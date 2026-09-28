// Manual call-graph edge overrides — researcher-authored rules that adjust the
// enhanced graph before capital/governance/dependency/mitigation analysis runs.
//
// WHY THIS EXISTS: the enhanced graph's forward BFS follows permission edges
// unconditionally, which over-flares an admin's reach through "logic" contracts
// (e.g. Aave's Pool flaring to every AToken via its onlyPool ownerships). There
// is no safe automatic filter (see docs/developers/features/permissions.md §
// "Known limitation"), so instead a researcher cuts the spurious edges by hand
// in the Call Graph Walker and we persist those decisions here.
//
// PERSISTENCE MODEL: one `call-graph-overrides.json` per project (committed to
// the repo, so the CI monitor picks it up). Rules are keyed by the *stable*
// semantic edge identity (node ids, not array indices), so they survive
// call-graph regeneration — they are re-applied on every `buildEnhancedGraph`.
//
// EXTENSIBILITY: a rule is a discriminated union; each `type` has one pure
// handler in RULE_HANDLERS. Adding a new rule = add a variant + one handler
// entry. Nothing else changes.

import type { DiscoveryPaths } from '@l2beat/discovery'
import * as fs from 'fs'
import * as path from 'path'
import { addressesEqual, normalizeChainAddress } from './addressUtils'
import type { EnhancedEdge } from './enhancedTraversal'
import type { ImpactCap, Mitigation } from './types'

export type BackendEdgeType = 'callgraph' | 'permission' | 'dependency'

interface RuleBase {
  /** Stable id (for dedup / delete from the UI). */
  id: string
  /** Optional researcher note shown in the walker. */
  note?: string
  /** Default true. Set false to keep a rule on disk but stop applying it. */
  enabled?: boolean
}

/** Inject an edge static analysis missed (e.g. a Timelock's dynamic dispatch). */
export interface AddEdgeRule extends RuleBase {
  type: 'addEdge'
  from: string // node id: `address` or `address.function`
  to: string // node id: `address.function`
  edgeType: BackendEdgeType
}

/** Remove one specific edge. */
export interface RemoveEdgeRule extends RuleBase {
  type: 'removeEdge'
  from: string
  to: string
  edgeType: BackendEdgeType
}

/**
 * Which traversal directions an edge participates in.
 * - 'both' (default): normal.
 * - 'backward': the relationship is real for governance/ownership chains but
 *   does NOT propagate forward capital reach — the principled over-flare fix
 *   (e.g. Pool owns AToken.mint stays in AToken's owner chain, but Pool reaching
 *   setLiquidationGracePeriod no longer flares capital to every AToken).
 * - 'forward': capital-only (rare).
 */
export type EdgeScope = 'forward' | 'backward' | 'both'

/** Set the traversal scope of one specific edge. */
export interface SetEdgeScopeRule extends RuleBase {
  type: 'setEdgeScope'
  from: string
  to: string
  edgeType: BackendEdgeType
  scope: EdgeScope
}

/** Set the scope of every edge leaving a node (a function, or whole contract). */
export interface SetOutgoingScopeRule extends RuleBase {
  type: 'setOutgoingScope'
  /** `address` matches all functions on the contract; `address.function` is exact. */
  node: string
  /** Optional: only edges of this type (e.g. just 'permission'). */
  edgeType?: BackendEdgeType
  scope: EdgeScope
}

/** Set the scope of every edge arriving at a node (a function, or whole contract). */
export interface SetIncomingScopeRule extends RuleBase {
  type: 'setIncomingScope'
  node: string
  edgeType?: BackendEdgeType
  scope: EdgeScope
}

/**
 * Edge-centric impact cap — a *relationship* cap (bounds the forward capital a
 * specific edge propagates), as opposed to a function-intrinsic cap authored on
 * a function's mitigation. Carries a raw `ImpactCap`; resolution to USD happens
 * in projectAnalysis (where discovered data + funds are available), keyed by the
 * stable enhancedEdgeKey. Folded into the per-edge cap in capitalAnalysis
 * (min wins, same as function caps). See docs/developers/designs/edge-centric-constraints.md.
 */
export interface SetEdgeCapRule extends RuleBase {
  type: 'setEdgeCap'
  from: string
  to: string
  edgeType: BackendEdgeType
  cap: ImpactCap
}

/** Cap every edge leaving a node (a function, or whole contract). */
export interface SetOutgoingCapRule extends RuleBase {
  type: 'setOutgoingCap'
  /** `address` matches all functions on the contract; `address.function` is exact. */
  node: string
  /** Optional: only edges of this type (e.g. just 'permission'). */
  edgeType?: BackendEdgeType
  cap: ImpactCap
}

/** Cap every edge arriving at a node (a function, or whole contract). */
export interface SetIncomingCapRule extends RuleBase {
  type: 'setIncomingCap'
  node: string
  edgeType?: BackendEdgeType
  cap: ImpactCap
}

/**
 * Edge-centric mitigations — relationship-level constraints (e.g. a timelock
 * delay that only applies on the owner→function edge), as opposed to
 * function-intrinsic mitigations authored on a function's `mitigations[]`.
 * Mitigations are *appended* to the matched edge(s), so multiple rules stack.
 * Merged into the function's effective mitigations in projectAnalysis
 * (getMitigationsForOwner), deduped against function mitigations by the shared
 * visible-identity key. See docs/developers/designs/edge-centric-constraints.md.
 */
export interface SetEdgeMitigationRule extends RuleBase {
  type: 'setEdgeMitigation'
  from: string
  to: string
  edgeType: BackendEdgeType
  mitigations: Mitigation[]
}

/**
 * Bulk "retarget" rule — the structural counterpart to the noisy
 * `removeEdge + addEdge` pair pattern that shows up when a multi-instance
 * protocol (Liquity v2's 3 markets, MetaMorpho factory deployments, etc.)
 * causes Slither to repeatedly resolve to the wrong instance.
 *
 * Matches every callgraph edge from `from` to `fromTarget` (and optionally
 * restricted to a specific `calledFunction`) and rewrites the target contract
 * to `toTarget` — preserving the original `targetFunction` on each edge.
 *
 * One rule can collapse dozens of (removeEdge, addEdge) pairs into a single
 * legible structural fact ("this contract's edges to X really belong to Y").
 */
export interface SetOutgoingTargetRule extends RuleBase {
  type: 'setOutgoingTarget'
  /** Source node ref. `address` matches all functions on the contract;
   *  `address.function` is exact. */
  from: string
  /** Current (wrong) target contract address. */
  fromTarget: string
  /** Corrected target contract address. */
  toTarget: string
  edgeType: BackendEdgeType
  /** Optional: only retarget edges whose called function matches this name.
   *  Use for selector-collision fixes (e.g. WETH.transferFrom vs ERC721
   *  transferFrom) where bulk retargeting would otherwise capture legit edges. */
  calledFunction?: string
}

export type EdgeOverrideRule =
  | AddEdgeRule
  | RemoveEdgeRule
  | SetEdgeScopeRule
  | SetOutgoingScopeRule
  | SetIncomingScopeRule
  | SetEdgeCapRule
  | SetOutgoingCapRule
  | SetIncomingCapRule
  | SetEdgeMitigationRule
  | SetOutgoingTargetRule

export interface CallGraphOverridesFile {
  version: string
  lastModified: string
  rules: EdgeOverrideRule[]
}

const EMPTY_FILE: CallGraphOverridesFile = {
  version: '1.0',
  lastModified: new Date(0).toISOString(),
  rules: [],
}

// ============================================================================
// Rule engine
// ============================================================================

/** A node ref is `address` (contract) or `address.function`. */
function parseNodeRef(ref: string): { address: string; functionName?: string } {
  const lastDot = ref.lastIndexOf('.')
  // Addresses ("eth:0x…") contain no '.', function names contain no '.', so the
  // last '.' cleanly separates them. No '.' → bare contract ref.
  if (lastDot === -1) return { address: ref }
  return {
    address: ref.slice(0, lastDot),
    functionName: ref.slice(lastDot + 1),
  }
}

/**
 * Does node ref `ref` match the (contract, function) end of an edge? A
 * contract-level ref (no function) matches every function on that contract.
 */
function nodeMatches(
  ref: string,
  contract: string,
  fn: string | undefined,
): boolean {
  const parsed = parseNodeRef(ref)
  if (!addressesEqual(parsed.address, contract)) return false
  if (parsed.functionName === undefined) return true
  return parsed.functionName === fn
}

interface RuleResult {
  edges: EnhancedEdge[]
  /** How many edges the rule affected (added or removed). */
  matched: number
}

type RuleHandler<R extends EdgeOverrideRule> = (
  edges: EnhancedEdge[],
  rule: R,
) => RuleResult

function removeWhere(
  edges: EnhancedEdge[],
  predicate: (e: EnhancedEdge) => boolean,
): RuleResult {
  const kept = edges.filter((e) => !predicate(e))
  return { edges: kept, matched: edges.length - kept.length }
}

function setScopeWhere(
  edges: EnhancedEdge[],
  predicate: (e: EnhancedEdge) => boolean,
  scope: EdgeScope,
): RuleResult {
  let matched = 0
  const out = edges.map((e) => {
    if (!predicate(e)) return e
    matched++
    return { ...e, scope }
  })
  return { edges: out, matched }
}

function setCapWhere(
  edges: EnhancedEdge[],
  predicate: (e: EnhancedEdge) => boolean,
  cap: ImpactCap,
): RuleResult {
  let matched = 0
  const out = edges.map((e) => {
    if (!predicate(e)) return e
    matched++
    return { ...e, cap }
  })
  return { edges: out, matched }
}

function appendMitigationsWhere(
  edges: EnhancedEdge[],
  predicate: (e: EnhancedEdge) => boolean,
  mitigations: Mitigation[],
): RuleResult {
  let matched = 0
  const out = edges.map((e) => {
    if (!predicate(e)) return e
    matched++
    return { ...e, mitigations: [...(e.mitigations ?? []), ...mitigations] }
  })
  return { edges: out, matched }
}

const RULE_HANDLERS: {
  [K in EdgeOverrideRule['type']]: RuleHandler<
    Extract<EdgeOverrideRule, { type: K }>
  >
} = {
  addEdge: (edges, rule) => {
    const from = parseNodeRef(rule.from)
    const to = parseNodeRef(rule.to)
    const edge: EnhancedEdge = {
      sourceContract: normalizeChainAddress(from.address),
      sourceFunction: from.functionName,
      targetContract: normalizeChainAddress(to.address),
      targetFunction: to.functionName ?? '',
      edgeType: rule.edgeType,
      isViewCall: false,
    }
    return { edges: [...edges, edge], matched: 1 }
  },

  removeEdge: (edges, rule) =>
    removeWhere(
      edges,
      (e) =>
        e.edgeType === rule.edgeType &&
        nodeMatches(rule.from, e.sourceContract, e.sourceFunction) &&
        nodeMatches(rule.to, e.targetContract, e.targetFunction),
    ),

  setEdgeScope: (edges, rule) =>
    setScopeWhere(
      edges,
      (e) =>
        e.edgeType === rule.edgeType &&
        nodeMatches(rule.from, e.sourceContract, e.sourceFunction) &&
        nodeMatches(rule.to, e.targetContract, e.targetFunction),
      rule.scope,
    ),

  setOutgoingScope: (edges, rule) =>
    setScopeWhere(
      edges,
      (e) =>
        (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
        nodeMatches(rule.node, e.sourceContract, e.sourceFunction),
      rule.scope,
    ),

  setIncomingScope: (edges, rule) =>
    setScopeWhere(
      edges,
      (e) =>
        (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
        nodeMatches(rule.node, e.targetContract, e.targetFunction),
      rule.scope,
    ),

  setEdgeCap: (edges, rule) =>
    setCapWhere(
      edges,
      (e) =>
        e.edgeType === rule.edgeType &&
        nodeMatches(rule.from, e.sourceContract, e.sourceFunction) &&
        nodeMatches(rule.to, e.targetContract, e.targetFunction),
      rule.cap,
    ),

  setOutgoingCap: (edges, rule) =>
    setCapWhere(
      edges,
      (e) =>
        (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
        nodeMatches(rule.node, e.sourceContract, e.sourceFunction),
      rule.cap,
    ),

  setIncomingCap: (edges, rule) =>
    setCapWhere(
      edges,
      (e) =>
        (rule.edgeType === undefined || e.edgeType === rule.edgeType) &&
        nodeMatches(rule.node, e.targetContract, e.targetFunction),
      rule.cap,
    ),

  setEdgeMitigation: (edges, rule) =>
    appendMitigationsWhere(
      edges,
      (e) =>
        e.edgeType === rule.edgeType &&
        nodeMatches(rule.from, e.sourceContract, e.sourceFunction) &&
        nodeMatches(rule.to, e.targetContract, e.targetFunction),
      rule.mitigations,
    ),

  setOutgoingTarget: (edges, rule) => {
    const fromTargetNorm = normalizeChainAddress(rule.fromTarget)
    const toTargetNorm = normalizeChainAddress(rule.toTarget)
    let matched = 0
    const out = edges.map((e) => {
      if (e.edgeType !== rule.edgeType) return e
      if (!nodeMatches(rule.from, e.sourceContract, e.sourceFunction)) return e
      if (!addressesEqual(e.targetContract, fromTargetNorm)) return e
      if (rule.calledFunction && e.targetFunction !== rule.calledFunction)
        return e
      matched++
      // Preserve targetFunction — only the contract address is rewritten.
      return { ...e, targetContract: toTargetNorm }
    })
    return { edges: out, matched }
  },
}

export interface ApplyOverridesResult {
  edges: EnhancedEdge[]
  /** Ids of enabled rules that matched nothing — surfaced so the UI can flag
   *  stale cuts (e.g. a function was renamed since the rule was authored). */
  unmatchedRuleIds: string[]
}

/**
 * Apply override rules to an enhanced-graph edge set, in order. Pure — no I/O.
 * Disabled rules are skipped. addEdge rules never count as "unmatched".
 */
export function applyEdgeOverrides(
  edges: EnhancedEdge[],
  rules: EdgeOverrideRule[],
): ApplyOverridesResult {
  let current = edges
  const unmatchedRuleIds: string[] = []
  for (const rule of rules) {
    if (rule.enabled === false) continue
    const handler = RULE_HANDLERS[rule.type] as RuleHandler<EdgeOverrideRule>
    const result = handler(current, rule)
    current = result.edges
    if (result.matched === 0 && rule.type !== 'addEdge') {
      unmatchedRuleIds.push(rule.id)
    }
  }
  return { edges: current, unmatchedRuleIds }
}

// ============================================================================
// File CRUD
// ============================================================================

function getOverridesPath(paths: DiscoveryPaths, project: string): string {
  return path.join(paths.discovery, project, 'call-graph-overrides.json')
}

export function getCallGraphOverrides(
  paths: DiscoveryPaths,
  project: string,
): CallGraphOverridesFile {
  const filePath = getOverridesPath(paths, project)
  if (!fs.existsSync(filePath)) return { ...EMPTY_FILE }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as CallGraphOverridesFile
    return {
      version: parsed.version ?? '1.0',
      lastModified: parsed.lastModified ?? EMPTY_FILE.lastModified,
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    }
  } catch (error) {
    console.error('Error parsing call-graph-overrides.json:', error)
    return { ...EMPTY_FILE }
  }
}

/** Enabled rules only — the form `buildEnhancedGraph` consumes. */
export function getEdgeOverrideRules(
  paths: DiscoveryPaths,
  project: string,
): EdgeOverrideRule[] {
  return getCallGraphOverrides(paths, project).rules
}

export function updateCallGraphOverrides(
  paths: DiscoveryPaths,
  project: string,
  rules: EdgeOverrideRule[] | null,
): void {
  const filePath = getOverridesPath(paths, project)
  if (rules === null || rules.length === 0) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return
  }
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const file: CallGraphOverridesFile = {
    version: '1.0',
    lastModified: new Date().toISOString(),
    rules,
  }
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2))
}
