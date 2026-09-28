// Frontend mirror of the backend rule engine (callGraphOverrides.ts). Applies
// EdgeOverrideRules to the walker's CallEdge[] so the rendered graph matches what
// capital/governance analysis sees. The backend applies the same rules file
// independently inside buildEnhancedGraph — this is the display-side twin.
//
// Adding a rule type: add the variant in api/types.ts, then a case here and a
// handler in the backend RULE_HANDLERS. Nothing else.

import type {
  EdgeOverrideRule,
  ImpactCap,
  Mitigation,
} from '../../../../api/types'
import { addressesEqual } from '../addressUtils'
import {
  type BackendEdgeType,
  type CallEdge,
  edgeKey,
  parseNodeId,
} from './model'

/** Does node ref `ref` match the (address, fn) end of an edge? A contract-level
 *  ref (no `.function`) matches every function on that contract. */
function nodeMatches(
  ref: string,
  address: string,
  fn: string | undefined,
): boolean {
  const p = parseNodeId(ref)
  if (!addressesEqual(p.address, address)) return false
  if (p.functionName === undefined) return true
  return p.functionName === fn
}

function fromMatches(e: CallEdge, ref: string): boolean {
  const p = parseNodeId(e.from)
  return nodeMatches(ref, p.address, p.functionName)
}

function toMatches(e: CallEdge, ref: string): boolean {
  const p = parseNodeId(e.to)
  return nodeMatches(ref, p.address, p.functionName)
}

function kindForEdgeType(edgeType: BackendEdgeType): CallEdge['kind'] {
  return edgeType === 'permission'
    ? 'permission'
    : edgeType === 'dependency'
      ? 'dependency'
      : 'external'
}

/** Apply override rules to the walker edge set, in order. Pure. */
export function applyRulesToCallEdges(
  edges: CallEdge[],
  rules: EdgeOverrideRule[],
): CallEdge[] {
  let current = edges
  for (const rule of rules) {
    if (rule.enabled === false) continue
    switch (rule.type) {
      case 'addEdge':
        current = [
          ...current,
          {
            id: edgeKey(rule.from, rule.to, rule.edgeType),
            from: rule.from,
            to: rule.to,
            kind: kindForEdgeType(rule.edgeType),
            edgeType: rule.edgeType,
            user: true,
          },
        ]
        break
      case 'removeEdge':
        current = current.filter(
          (e) =>
            !(
              e.edgeType === rule.edgeType &&
              fromMatches(e, rule.from) &&
              toMatches(e, rule.to)
            ),
        )
        break
      case 'setEdgeScope':
        current = current.map((e) =>
          e.edgeType === rule.edgeType &&
          fromMatches(e, rule.from) &&
          toMatches(e, rule.to)
            ? { ...e, scope: rule.scope }
            : e,
        )
        break
      case 'setOutgoingScope':
        current = current.map((e) =>
          (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
          fromMatches(e, rule.node)
            ? { ...e, scope: rule.scope }
            : e,
        )
        break
      case 'setIncomingScope':
        current = current.map((e) =>
          (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
          toMatches(e, rule.node)
            ? { ...e, scope: rule.scope }
            : e,
        )
        break
      case 'setEdgeCap':
        current = current.map((e) =>
          e.edgeType === rule.edgeType &&
          fromMatches(e, rule.from) &&
          toMatches(e, rule.to)
            ? { ...e, cap: rule.cap }
            : e,
        )
        break
      case 'setOutgoingCap':
        current = current.map((e) =>
          (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
          fromMatches(e, rule.node)
            ? { ...e, cap: rule.cap }
            : e,
        )
        break
      case 'setIncomingCap':
        current = current.map((e) =>
          (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
          toMatches(e, rule.node)
            ? { ...e, cap: rule.cap }
            : e,
        )
        break
      case 'setEdgeMitigation':
        current = current.map((e) =>
          e.edgeType === rule.edgeType &&
          fromMatches(e, rule.from) &&
          toMatches(e, rule.to)
            ? {
                ...e,
                mitigations: [...(e.mitigations ?? []), ...rule.mitigations],
              }
            : e,
        )
        break
      case 'setOutgoingTarget': {
        // Bulk retarget: edges matching (from, fromTarget) get their target
        // address rewritten to toTarget; the target FUNCTION is preserved.
        // CallEdge `to` is `address.function`, so rebuild it from the new
        // address. Also refresh `id` (edgeKey of from|to|edgeType).
        const fromTargetAddr = parseNodeId(rule.fromTarget).address
        const toTargetAddr = parseNodeId(rule.toTarget).address
        current = current.map((e) => {
          if (e.edgeType !== rule.edgeType) return e
          if (!fromMatches(e, rule.from)) return e
          const tp = parseNodeId(e.to)
          if (!addressesEqual(tp.address, fromTargetAddr)) return e
          if (rule.calledFunction && tp.functionName !== rule.calledFunction)
            return e
          const newTo = tp.functionName
            ? `${toTargetAddr}.${tp.functionName}`
            : toTargetAddr
          return {
            ...e,
            to: newTo,
            id: edgeKey(e.from, newTo, e.edgeType ?? rule.edgeType),
          }
        })
        break
      }
    }
  }
  return current
}

/** The effective scope of an edge after applying all scope rules (default 'both'). */
export function effectiveScope(
  rules: EdgeOverrideRule[],
  edge: CallEdge,
): 'forward' | 'backward' | 'both' {
  let scope: 'forward' | 'backward' | 'both' = 'both'
  for (const r of rules) {
    if (r.enabled === false) continue
    if (
      r.type === 'setEdgeScope' &&
      r.edgeType === edge.edgeType &&
      fromMatches(edge, r.from) &&
      toMatches(edge, r.to)
    ) {
      scope = r.scope
    } else if (
      r.type === 'setOutgoingScope' &&
      (r.edgeType === undefined || r.edgeType === edge.edgeType) &&
      fromMatches(edge, r.node)
    ) {
      scope = r.scope
    } else if (
      r.type === 'setIncomingScope' &&
      (r.edgeType === undefined || r.edgeType === edge.edgeType) &&
      toMatches(edge, r.node)
    ) {
      scope = r.scope
    }
  }
  return scope
}

/** The single-edge scope rule targeting this exact edge, if any. */
export function findEdgeScopeRule(
  rules: EdgeOverrideRule[],
  edge: CallEdge,
): EdgeOverrideRule | undefined {
  return rules.find(
    (r) =>
      r.type === 'setEdgeScope' &&
      r.edgeType === edge.edgeType &&
      fromMatches(edge, r.from) &&
      toMatches(edge, r.to),
  )
}

/** The effective edge cap after applying all cap rules (last write wins;
 *  undefined = uncapped). Mirrors the backend min-at-resolve behavior loosely —
 *  the backend takes the tightest when several rules hit one edge, but for
 *  display the last matching rule's cap is shown. */
export function effectiveCap(
  rules: EdgeOverrideRule[],
  edge: CallEdge,
): ImpactCap | undefined {
  let cap: ImpactCap | undefined
  for (const r of rules) {
    if (r.enabled === false) continue
    if (
      r.type === 'setEdgeCap' &&
      r.edgeType === edge.edgeType &&
      fromMatches(edge, r.from) &&
      toMatches(edge, r.to)
    ) {
      cap = r.cap
    } else if (
      r.type === 'setOutgoingCap' &&
      (r.edgeType === undefined || r.edgeType === edge.edgeType) &&
      fromMatches(edge, r.node)
    ) {
      cap = r.cap
    } else if (
      r.type === 'setIncomingCap' &&
      (r.edgeType === undefined || r.edgeType === edge.edgeType) &&
      toMatches(edge, r.node)
    ) {
      cap = r.cap
    }
  }
  return cap
}

/** The single-edge cap rule targeting this exact edge, if any. */
export function findEdgeCapRule(
  rules: EdgeOverrideRule[],
  edge: CallEdge,
): EdgeOverrideRule | undefined {
  return rules.find(
    (r) =>
      r.type === 'setEdgeCap' &&
      r.edgeType === edge.edgeType &&
      fromMatches(edge, r.from) &&
      toMatches(edge, r.to),
  )
}

/** All edge-centric mitigations applied to this edge by setEdgeMitigation rules
 *  (appended across rules, in order). */
export function effectiveEdgeMitigations(
  rules: EdgeOverrideRule[],
  edge: CallEdge,
): Mitigation[] {
  const out: Mitigation[] = []
  for (const r of rules) {
    if (r.enabled === false) continue
    if (
      r.type === 'setEdgeMitigation' &&
      r.edgeType === edge.edgeType &&
      fromMatches(edge, r.from) &&
      toMatches(edge, r.to)
    ) {
      out.push(...r.mitigations)
    }
  }
  return out
}

// ── Per-edge rule lookups (for the sidebar's toggle / restore actions) ──────

/** The exact `removeEdge` rule suppressing this edge, if any (1:1, restorable). */
export function findRemoveEdgeRule(
  rules: EdgeOverrideRule[],
  edge: CallEdge,
): EdgeOverrideRule | undefined {
  return rules.find(
    (r) =>
      r.enabled !== false &&
      r.type === 'removeEdge' &&
      r.edgeType === edge.edgeType &&
      fromMatches(edge, r.from) &&
      toMatches(edge, r.to),
  )
}

/** The `addEdge` rule that created this edge, if any. */
export function findAddEdgeRule(
  rules: EdgeOverrideRule[],
  edge: CallEdge,
): EdgeOverrideRule | undefined {
  return rules.find(
    (r) =>
      r.type === 'addEdge' &&
      r.from === edge.from &&
      r.to === edge.to &&
      r.edgeType === edge.edgeType,
  )
}

/** The node a rule is "about" — what the walker should focus when reviewing it. */
export function ruleFocusNode(rule: EdgeOverrideRule): string {
  switch (rule.type) {
    case 'addEdge':
    case 'removeEdge':
    case 'setEdgeScope':
    case 'setEdgeCap':
    case 'setEdgeMitigation':
    case 'setOutgoingTarget':
      return rule.from
    case 'setOutgoingScope':
    case 'setIncomingScope':
    case 'setOutgoingCap':
    case 'setIncomingCap':
      return rule.node
  }
}

/** Does a rule currently match ≥1 edge? (addEdge always "matches" — it injects.) */
export function ruleMatchesAnyEdge(
  rule: EdgeOverrideRule,
  edges: CallEdge[],
): boolean {
  switch (rule.type) {
    case 'addEdge':
      return true
    case 'removeEdge':
    case 'setEdgeScope':
    case 'setEdgeCap':
    case 'setEdgeMitigation':
      return edges.some(
        (e) =>
          e.edgeType === rule.edgeType &&
          fromMatches(e, rule.from) &&
          toMatches(e, rule.to),
      )
    case 'setOutgoingTarget': {
      const ft = parseNodeId(rule.fromTarget).address
      return edges.some(
        (e) =>
          e.edgeType === rule.edgeType &&
          fromMatches(e, rule.from) &&
          addressesEqual(parseNodeId(e.to).address, ft) &&
          (!rule.calledFunction ||
            parseNodeId(e.to).functionName === rule.calledFunction),
      )
    }
    case 'setOutgoingScope':
    case 'setOutgoingCap':
      return edges.some(
        (e) =>
          (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
          fromMatches(e, rule.node),
      )
    case 'setIncomingScope':
    case 'setIncomingCap':
      return edges.some(
        (e) =>
          (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
          toMatches(e, rule.node),
      )
  }
}

/** Stable-ish unique id for a new rule. */
export function makeRuleId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Human-readable one-liner for a rule (used in the Rules list). */
export function describeRule(rule: EdgeOverrideRule): string {
  switch (rule.type) {
    case 'addEdge':
      return `add ${rule.edgeType}: ${shortRef(rule.from)} → ${shortRef(rule.to)}`
    case 'removeEdge':
      return `remove ${rule.edgeType}: ${shortRef(rule.from)} → ${shortRef(rule.to)}`
    case 'setEdgeScope':
      return `${scopeVerb(rule.scope)}: ${shortRef(rule.from)} → ${shortRef(rule.to)}`
    case 'setOutgoingScope':
      return `${scopeVerb(rule.scope)}: ${rule.edgeType ?? 'all'} outgoing from ${shortRef(rule.node)}`
    case 'setIncomingScope':
      return `${scopeVerb(rule.scope)}: ${rule.edgeType ?? 'all'} incoming to ${shortRef(rule.node)}`
    case 'setEdgeCap':
      return `cap ${capLabel(rule.cap)}: ${shortRef(rule.from)} → ${shortRef(rule.to)}`
    case 'setOutgoingCap':
      return `cap ${capLabel(rule.cap)}: ${rule.edgeType ?? 'all'} outgoing from ${shortRef(rule.node)}`
    case 'setIncomingCap':
      return `cap ${capLabel(rule.cap)}: ${rule.edgeType ?? 'all'} incoming to ${shortRef(rule.node)}`
    case 'setEdgeMitigation': {
      const n = rule.mitigations.length
      return `mitigate (${n} ${n === 1 ? 'rule' : 'rules'}): ${shortRef(rule.from)} → ${shortRef(rule.to)}`
    }
    case 'setOutgoingTarget':
      return `retarget${rule.calledFunction ? ` .${rule.calledFunction}` : ''}: ${shortRef(rule.from)} → was ${shortRef(rule.fromTarget)}, now ${shortRef(rule.toTarget)}`
  }
}

/** Short human label for an impact cap (e.g. "$1,000" or "→field"). */
export function capLabel(cap: ImpactCap): string {
  if (cap.value.mode === 'hardcoded') {
    const n = cap.value.amount
    const unit = cap.unit.kind === 'usd' ? '$' : ''
    return `${unit}${n.toLocaleString()}`
  }
  return `→${cap.value.fieldName}`
}

function scopeVerb(scope: 'forward' | 'backward' | 'both'): string {
  return scope === 'backward'
    ? 'governance-only'
    : scope === 'forward'
      ? 'capital-only'
      : 'both directions'
}

function shortRef(ref: string): string {
  const { address, functionName } = parseNodeId(ref)
  const raw = address.includes(':')
    ? (address.split(':')[1] ?? address)
    : address
  const short = raw.length >= 10 ? `${raw.slice(0, 6)}…${raw.slice(-4)}` : raw
  return functionName ? `${short}.${functionName}` : short
}
