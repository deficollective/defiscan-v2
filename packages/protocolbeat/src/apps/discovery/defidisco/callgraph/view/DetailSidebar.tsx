// Right-side detail sidebar inside the CallGraph panel.
// Tabs: Node | Notes | Rules. The Node tab doubles as the edge editor for the
// selected node — its edges are listed with reversible on/off toggles, plus an
// inline "add edge" form. The Rules tab is the full ledger of persisted overrides.

import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { useParams } from 'react-router-dom'
import type {
  EdgeOverrideRule,
  EdgeScope,
  ImpactCap,
  Mitigation,
  RuleSuggestion,
} from '../../../../../api/types'
import type { BackendEdgeType, CallEdge, CallNode } from '../model'
import { parseNodeId, shortAddr } from '../model'
import { useCallgraphOverridesStore } from '../overridesStore'
import {
  capLabel,
  describeRule,
  effectiveCap,
  effectiveEdgeMitigations,
  effectiveScope,
  findRemoveEdgeRule,
  ruleMatchesAnyEdge,
} from '../rules'

interface Props {
  selectedId: string | null
  startId: string | null
  nodes: Map<string, CallNode>
  /** Post-override edges (what the canvas shows). */
  allEdges: CallEdge[]
  /** Pre-override edges — lets us show suppressed edges struck-through. */
  rawEdges: CallEdge[]
  visibleNodeIds: Set<string>
  onSelectNode: (id: string) => void
  onSetStart: (id: string) => void
  /** Highlight an edge on the canvas (e.g. hovering an edge row); null clears. */
  onHoverEdge: (edge: CallEdge | null) => void
  onToggleCollapse: (contract: string) => void
  collapsedContracts: Set<string>
  onOpenInCode?: (contractAddress: string, functionName: string) => void
  /** Server-persisted override rules + which are stale. */
  rules: EdgeOverrideRule[]
  unmatchedRuleIds?: string[]
  /** Remove a callgraph edge → removeEdge rule (or drops a user addEdge). */
  onRemoveEdge: (edge: CallEdge) => void
  /** Add a manual edge from→to of the given type. */
  onAddEdge: (from: string, to: string, edgeType: BackendEdgeType) => void
  /** Set the scope of one edge (perm/dependency edges — governance/capital/both). */
  onSetEdgeScope: (edge: CallEdge, scope: EdgeScope) => void
  /** Set (or clear, with undefined) an edge-centric impact cap on one edge. */
  onSetEdgeCap: (edge: CallEdge, cap: ImpactCap | undefined) => void
  /** Replace the edge-centric mitigation list on one edge (empty clears). */
  onSetEdgeMitigations: (edge: CallEdge, mitigations: Mitigation[]) => void
  /** Bulk scope all outgoing/incoming edges of a node (optionally one type). */
  onSetOutgoingScope: (
    nodeRef: string,
    scope: EdgeScope,
    edgeType?: BackendEdgeType,
  ) => void
  onSetIncomingScope: (
    nodeRef: string,
    scope: EdgeScope,
    edgeType?: BackendEdgeType,
  ) => void
  /** Delete a rule by id (also used to restore a single suppressed edge). */
  onDeleteRule: (id: string) => void
  /** Agent-proposed rules pending review. */
  suggestions: RuleSuggestion[]
  /** Review a suggestion: re-root on its node and highlight its edge (red/green). */
  onFocusSuggestion: (rule: EdgeOverrideRule) => void
  onResolveSuggestion: (id: string, action: 'accept' | 'reject') => void
}

type Tab = 'node' | 'notes' | 'rules' | 'suggest'

// Stable fallback for the notes selector (see React #185 note below).
const EMPTY_NOTES: Record<string, string> = {}

export function DetailSidebar(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('node')
  const pendingCount = props.suggestions.filter(
    (s) => s.status === 'pending',
  ).length

  // Open straight to the inbox when there are pending suggestions and no trace
  // has been started yet — so a researcher can review without picking a function
  // first. Runs once (when suggestions finish loading); never hijacks after the
  // user has started tracing or manually changed tabs.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!autoOpened.current && !props.startId && pendingCount > 0) {
      autoOpened.current = true
      setTab('suggest')
    }
  }, [pendingCount, props.startId])

  return (
    <div className="flex h-full w-[340px] flex-col border-coffee-500 border-l bg-coffee-700">
      <div className="flex border-coffee-500 border-b">
        <TabButton on={tab === 'node'} onClick={() => setTab('node')}>
          node
        </TabButton>
        <TabButton on={tab === 'notes'} onClick={() => setTab('notes')}>
          notes
        </TabButton>
        <TabButton on={tab === 'rules'} onClick={() => setTab('rules')}>
          rules{' '}
          <span className="ml-1.5 rounded bg-coffee-600 px-1 text-[10px] text-coffee-400">
            {props.rules.length}
          </span>
        </TabButton>
        <TabButton on={tab === 'suggest'} onClick={() => setTab('suggest')}>
          inbox{pendingCount > 0 && ' '}
          {pendingCount > 0 && (
            <span className="ml-1.5 rounded bg-aux-pink px-1 text-[10px] text-coffee-900">
              {pendingCount}
            </span>
          )}
        </TabButton>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'node' && <NodeTab {...props} />}
        {tab === 'notes' && <NotesTab {...props} />}
        {tab === 'rules' && <RulesTab {...props} />}
        {tab === 'suggest' && <SuggestionsTab {...props} />}
      </div>
    </div>
  )
}

function TabButton({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex-1 border-b-2 px-3 py-3 font-mono text-[11px] uppercase tracking-wider transition-colors',
        on
          ? 'border-aux-pink text-coffee-200'
          : 'border-transparent text-coffee-400 hover:text-coffee-200',
      )}
    >
      {children}
    </button>
  )
}

// ───────────────────── Node tab (+ edge editor) ─────────────────────

/**
 * One edge in the editor, with its derived override state. callgraph edges have
 * existence states (active/added/suppressed); permission/dependency edges are
 * curated at the source, so here they only carry a traversal `scope` control.
 */
interface EditableEdge {
  edge: CallEdge
  /** The node at the other end (what we navigate to / label). */
  otherId: string
  state: 'callgraph' | 'added' | 'suppressed' | 'scoped'
  /** For 'suppressed', the removeEdge rule id (to restore). */
  restoreRuleId?: string
  /** For 'scoped' (perm/dependency edges), the effective traversal scope. */
  scope?: EdgeScope
  /** Effective edge-centric impact cap (any edge type), if a cap rule applies. */
  cap?: ImpactCap
  /** Effective edge-centric mitigations (any edge type). */
  mitigations?: Mitigation[]
}

function NodeTab(props: Props): JSX.Element {
  const {
    selectedId,
    startId,
    nodes,
    allEdges,
    rawEdges,
    rules,
    onSelectNode,
    onSetStart,
    onToggleCollapse,
    collapsedContracts,
    onOpenInCode,
    onRemoveEdge,
    onAddEdge,
    onSetEdgeScope,
    onSetEdgeCap,
    onSetEdgeMitigations,
    onHoverEdge,
    onSetOutgoingScope,
    onSetIncomingScope,
    onDeleteRule,
  } = props

  // Hooks must run unconditionally — compute before the early return.
  const finalIds = useMemo(() => new Set(allEdges.map((e) => e.id)), [allEdges])

  const classify = (e: CallEdge, dir: 'out' | 'in'): EditableEdge => {
    const otherId = dir === 'out' ? e.to : e.from
    if (e.user) return { edge: e, otherId, state: 'added' }
    if (!finalIds.has(e.id)) {
      // Removed by a removeEdge rule (callgraph). Restorable by deleting it.
      return {
        edge: e,
        otherId,
        state: 'suppressed',
        restoreRuleId: findRemoveEdgeRule(rules, e)?.id,
      }
    }
    if (e.edgeType === 'callgraph')
      return {
        edge: e,
        otherId,
        state: 'callgraph',
        cap: effectiveCap(rules, e),
        mitigations: effectiveEdgeMitigations(rules, e),
      }
    // permission / dependency → scope control (existence edited at source).
    return {
      edge: e,
      otherId,
      state: 'scoped',
      scope: effectiveScope(rules, e),
      cap: effectiveCap(rules, e),
      mitigations: effectiveEdgeMitigations(rules, e),
    }
  }

  const { outgoing, incoming } = useMemo(() => {
    if (!selectedId) return { outgoing: [], incoming: [] }
    const editable = (e: CallEdge) => !!e.edgeType // callgraph/permission/dependency only
    // Base set = raw edges; added edges live only in the post-override set.
    const rawOut = rawEdges.filter((e) => e.from === selectedId && editable(e))
    const rawIn = rawEdges.filter((e) => e.to === selectedId && editable(e))
    const addedOut = allEdges.filter((e) => e.user && e.from === selectedId)
    const addedIn = allEdges.filter((e) => e.user && e.to === selectedId)
    return {
      outgoing: [
        ...addedOut.map((e) => classify(e, 'out')),
        ...rawOut.map((e) => classify(e, 'out')),
      ],
      incoming: [
        ...addedIn.map((e) => classify(e, 'in')),
        ...rawIn.map((e) => classify(e, 'in')),
      ],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rawEdges, allEdges, finalIds, rules])

  if (!selectedId) {
    return (
      <p className="text-coffee-400 italic">
        Click a node in the graph to inspect it and edit its connections.
      </p>
    )
  }
  const { address, functionName } = parseNodeId(selectedId)
  const node = nodes.get(selectedId) ?? nodes.get(address)
  if (!node) return <p className="text-coffee-400 italic">Unknown node.</p>

  const isCollapsed = collapsedContracts.has(address)
  const contractNode = nodes.get(address)

  return (
    <>
      <div className="mb-1 break-all font-mono text-[13.5px] leading-snug">
        <span className="text-coffee-200">{node.contractName}</span>
        {functionName && (
          <>
            <span className="text-coffee-400">.</span>
            <span className="text-aux-pink">{functionName}</span>
          </>
        )}
      </div>

      <KvRow
        k="address"
        v={<span className="font-mono">{shortAddr(address)}</span>}
      />
      <KvRow k="type" v={node.contractType} />
      <KvRow k="kind" v={node.kind} />
      {functionName && (
        <KvRow k="visibility" v={node.isView ? 'view' : 'write'} />
      )}
      {node.isPermissioned && (
        <KvRow
          k="modifier"
          v={<span className="text-aux-orange">permissioned</span>}
        />
      )}

      <EdgeSection
        title="Outgoing"
        dir="out"
        rows={outgoing}
        nodes={nodes}
        onSelectNode={onSelectNode}
        onRemoveEdge={onRemoveEdge}
        onRestore={onDeleteRule}
        onSetEdgeScope={onSetEdgeScope}
        onSetEdgeCap={onSetEdgeCap}
        onSetEdgeMitigations={onSetEdgeMitigations}
        onHoverEdge={onHoverEdge}
        onBulkOwnsScope={(scope) =>
          onSetOutgoingScope(selectedId, scope, 'permission')
        }
      />

      <AddEdgeForm sourceId={selectedId} nodes={nodes} onAddEdge={onAddEdge} />

      <EdgeSection
        title="Incoming"
        dir="in"
        rows={incoming}
        nodes={nodes}
        onSelectNode={onSelectNode}
        onRemoveEdge={onRemoveEdge}
        onRestore={onDeleteRule}
        onSetEdgeScope={onSetEdgeScope}
        onSetEdgeCap={onSetEdgeCap}
        onSetEdgeMitigations={onSetEdgeMitigations}
        onHoverEdge={onHoverEdge}
        onBulkOwnsScope={(scope) =>
          onSetIncomingScope(selectedId, scope, 'permission')
        }
      />

      <Section title="Node actions">
        <div className="flex flex-wrap gap-1.5">
          {functionName && selectedId !== startId && (
            <ActionBtn onClick={() => onSetStart(selectedId)}>
              ↟ use as start
            </ActionBtn>
          )}
          {contractNode && contractNode.kind !== 'eoa' && (
            <ActionBtn onClick={() => onToggleCollapse(address)}>
              {isCollapsed ? '＋ expand contract' : '− collapse contract'}
            </ActionBtn>
          )}
          {functionName && onOpenInCode && (
            <ActionBtn onClick={() => onOpenInCode(address, functionName)}>
              ↗ open in code
            </ActionBtn>
          )}
        </div>
      </Section>
    </>
  )
}

// ── Edge section (Outgoing / Incoming) ──────────────────────────────────────

function EdgeSection({
  title,
  dir,
  rows,
  nodes,
  onSelectNode,
  onRemoveEdge,
  onRestore,
  onSetEdgeScope,
  onSetEdgeCap,
  onSetEdgeMitigations,
  onHoverEdge,
  onBulkOwnsScope,
}: {
  title: string
  dir: 'out' | 'in'
  rows: EditableEdge[]
  nodes: Map<string, CallNode>
  onSelectNode: (id: string) => void
  onRemoveEdge: (e: CallEdge) => void
  onRestore: (ruleId: string) => void
  onSetEdgeScope: (edge: CallEdge, scope: EdgeScope) => void
  onSetEdgeCap: (edge: CallEdge, cap: ImpactCap | undefined) => void
  onSetEdgeMitigations: (edge: CallEdge, mitigations: Mitigation[]) => void
  onHoverEdge: (edge: CallEdge | null) => void
  onBulkOwnsScope: (scope: EdgeScope) => void
}): JSX.Element {
  // Over-flare convenience: if this side has ownership edges, offer a one-click
  // "ownership → governance-only" (real ownership stays, no forward capital flare).
  const ownsRows = rows.filter((r) => r.edge.edgeType === 'permission')
  const ownsAllBackward =
    ownsRows.length > 0 && ownsRows.every((r) => r.scope === 'backward')
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-coffee-400 uppercase tracking-wider">
          {title} ({rows.length})
        </span>
        {ownsRows.length > 0 && (
          <MiniBtn
            on={ownsAllBackward}
            onClick={() =>
              onBulkOwnsScope(ownsAllBackward ? 'both' : 'backward')
            }
            title="Ownership edges are real for governance but shouldn't flare forward capital. Toggle all of them to governance-only."
          >
            {ownsAllBackward ? '✓ owns: gov-only' : 'owns → gov-only'}
          </MiniBtn>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-coffee-400">
          No {dir === 'out' ? 'outgoing' : 'incoming'} edges.
        </p>
      ) : (
        rows.map((row) => (
          <EdgeRow
            key={row.edge.id}
            row={row}
            dir={dir}
            nodes={nodes}
            onSelectNode={onSelectNode}
            onRemoveEdge={onRemoveEdge}
            onRestore={onRestore}
            onSetEdgeScope={onSetEdgeScope}
            onSetEdgeCap={onSetEdgeCap}
            onSetEdgeMitigations={onSetEdgeMitigations}
            onHoverEdge={onHoverEdge}
          />
        ))
      )}
    </div>
  )
}

function EdgeRow({
  row,
  dir,
  nodes,
  onSelectNode,
  onRemoveEdge,
  onRestore,
  onSetEdgeScope,
  onSetEdgeCap,
  onSetEdgeMitigations,
  onHoverEdge,
}: {
  row: EditableEdge
  dir: 'out' | 'in'
  nodes: Map<string, CallNode>
  onSelectNode: (id: string) => void
  onRemoveEdge: (e: CallEdge) => void
  onRestore: (ruleId: string) => void
  onSetEdgeScope: (edge: CallEdge, scope: EdgeScope) => void
  onSetEdgeCap: (edge: CallEdge, cap: ImpactCap | undefined) => void
  onSetEdgeMitigations: (edge: CallEdge, mitigations: Mitigation[]) => void
  onHoverEdge: (edge: CallEdge | null) => void
}): JSX.Element {
  const { edge, otherId, state } = row
  const off = state === 'suppressed'
  // A cap is meaningful on any live (non-suppressed) backend edge. A 'backward'
  // scope makes it a no-op (edge carries no forward capital) — flagged in the UI.
  const capEditable = state === 'callgraph' || state === 'scoped'
  return (
    <div
      // Hovering the row highlights (and labels) the matching edge on the
      // canvas. Suppressed edges aren't on the canvas, so skip the highlight.
      onMouseEnter={() => !off && onHoverEdge(edge)}
      onMouseLeave={() => onHoverEdge(null)}
      className={clsx(
        'mb-1 flex w-full flex-col gap-1 rounded border bg-coffee-800 px-2 py-1.5 font-mono text-[11px]',
        off ? 'border-coffee-700' : 'border-coffee-600 hover:border-coffee-400',
      )}
    >
      <div className="flex w-full items-center gap-2">
        <button
          type="button"
          onClick={() => onSelectNode(otherId)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-coffee-400">{dir === 'in' ? '←' : '→'}</span>
          <span
            className={clsx(
              'flex-1 truncate',
              off ? 'text-coffee-500 line-through' : 'text-coffee-200',
            )}
          >
            {nodeLabel(otherId, nodes)}
          </span>
          <EdgeKindBadge kind={edge.kind} dimmed={off} />
        </button>

        {/* callgraph: on/off toggle (existence) */}
        {state === 'callgraph' && (
          <Toggle
            on
            title="In the graph — click to suppress this call"
            onClick={() => onRemoveEdge(edge)}
          />
        )}
        {state === 'suppressed' && (
          <Toggle
            on={false}
            title="Suppressed — click to restore"
            onClick={() => row.restoreRuleId && onRestore(row.restoreRuleId)}
          />
        )}
        {state === 'added' && (
          <div className="flex items-center gap-1">
            <span className="rounded bg-aux-cyan/10 px-1 text-[8.5px] text-aux-cyan uppercase tracking-wider">
              added
            </span>
            <button
              type="button"
              onClick={() => onRemoveEdge(edge)}
              title="Remove this manually-added edge"
              className="text-coffee-400 hover:text-aux-red"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* permission / dependency: scope control (existence is edited at source) */}
      {state === 'scoped' && (
        <div className="flex items-center justify-between gap-2 pl-4">
          <ScopeControl
            scope={row.scope ?? 'both'}
            onChange={(s) => onSetEdgeScope(edge, s)}
          />
          <span
            className="shrink-0 text-[9px] text-coffee-500"
            title="To remove this edge entirely, edit its owner definition / dependency in the Permissions panel (functions.json)."
          >
            edit at source
          </span>
        </div>
      )}

      {/* edge-centric impact cap — bounds the forward capital this edge propagates */}
      {capEditable && (
        <CapControl
          cap={row.cap}
          noop={row.scope === 'backward'}
          onSet={(cap) => onSetEdgeCap(edge, cap)}
        />
      )}

      {/* edge-centric mitigations — relationship-level constraints on this edge */}
      {capEditable && (
        <EdgeMitigationControl
          mitigations={row.mitigations ?? []}
          onChange={(ms) => onSetEdgeMitigations(edge, ms)}
        />
      )}
    </div>
  )
}

/** Inline edge-mitigation editor: lists the edge's relationship mitigations with
 *  remove, and an add form for the two relationship-typical kinds — a `delay`
 *  (seconds) and an `other` (label + description). Richer types (valueRange,
 *  relativeValue, impactCap) are authored on the function or via the rules file. */
function EdgeMitigationControl({
  mitigations,
  onChange,
}: {
  mitigations: Mitigation[]
  onChange: (mitigations: Mitigation[]) => void
}): JSX.Element {
  const [adding, setAdding] = useState<null | 'delay' | 'other'>(null)
  const [delaySecs, setDelaySecs] = useState('')
  const [label, setLabel] = useState('')
  const [desc, setDesc] = useState('')

  const reset = () => {
    setAdding(null)
    setDelaySecs('')
    setLabel('')
    setDesc('')
  }
  const commit = () => {
    if (adding === 'delay') {
      const n = Number(delaySecs.replace(/[, _]/g, ''))
      if (isFinite(n) && n > 0) {
        onChange([
          ...mitigations,
          {
            type: 'delay',
            description: `${n}s delay on this relationship`,
            delaySeconds: n,
          },
        ])
      }
    } else if (adding === 'other') {
      if (label.trim() || desc.trim()) {
        onChange([
          ...mitigations,
          {
            type: 'other',
            label: label.trim() || undefined,
            description: desc.trim() || label.trim(),
          },
        ])
      }
    }
    reset()
  }

  return (
    <div className="flex flex-col gap-1 pl-4 text-[10px]">
      <div className="flex items-center gap-2">
        <span className="text-coffee-500">mitigations</span>
        {mitigations.length === 0 && adding === null && (
          <button
            type="button"
            onClick={() => setAdding('other')}
            className="text-coffee-400 hover:text-coffee-200"
          >
            ＋ add
          </button>
        )}
      </div>

      {mitigations.map((m, i) => (
        <div
          key={`${m.type}-${i}`}
          className="flex items-center gap-1.5"
          title={m.description}
        >
          <span className="rounded bg-aux-green/10 px-1 py-0.5 font-mono text-aux-green">
            🛡{' '}
            {m.label ??
              (m.type === 'delay' ? `${m.delaySeconds ?? '?'}s` : m.type)}
          </span>
          <button
            type="button"
            onClick={() => onChange(mitigations.filter((_, j) => j !== i))}
            title="Remove this edge mitigation"
            className="text-coffee-400 hover:text-aux-red"
          >
            ✕
          </button>
        </div>
      ))}

      {adding === null && mitigations.length > 0 && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAdding('delay')}
            className="text-coffee-400 hover:text-coffee-200"
          >
            ＋ delay
          </button>
          <button
            type="button"
            onClick={() => setAdding('other')}
            className="text-coffee-400 hover:text-coffee-200"
          >
            ＋ other
          </button>
        </div>
      )}

      {adding === 'delay' && (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={delaySecs}
            onChange={(e) => setDelaySecs(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') reset()
            }}
            placeholder="delay seconds"
            className="w-28 rounded border border-coffee-600 bg-coffee-900 px-1 py-0.5 font-mono text-coffee-100"
          />
          <button
            type="button"
            onClick={commit}
            className="text-aux-green hover:underline"
          >
            save
          </button>
          <button
            type="button"
            onClick={reset}
            className="text-coffee-400 hover:text-aux-red"
          >
            ✕
          </button>
        </div>
      )}

      {adding === 'other' && (
        <div className="flex flex-col gap-1">
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label (1-2 words)"
            className="rounded border border-coffee-600 bg-coffee-900 px-1 py-0.5 font-mono text-coffee-100"
          />
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') reset()
            }}
            placeholder="description"
            className="rounded border border-coffee-600 bg-coffee-900 px-1 py-0.5 font-mono text-coffee-100"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={commit}
              className="text-aux-green hover:underline"
            >
              save
            </button>
            <button
              type="button"
              onClick={reset}
              className="text-coffee-400 hover:text-aux-red"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Inline edge-cap editor: shows the current cap (or a "set cap" affordance) and
 *  lets the researcher enter a hardcoded USD cap or clear it. fieldRef caps are
 *  authored via the rules file / agent suggestions; this inline form is USD-only. */
function CapControl({
  cap,
  noop,
  onSet,
}: {
  cap?: ImpactCap
  noop?: boolean
  onSet: (cap: ImpactCap | undefined) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const isUsdHardcoded =
    cap?.value.mode === 'hardcoded' && cap.unit.kind === 'usd'

  const commit = () => {
    const n = Number(val.replace(/[, _]/g, ''))
    if (isFinite(n) && n > 0) {
      onSet({ value: { mode: 'hardcoded', amount: n }, unit: { kind: 'usd' } })
    }
    setEditing(false)
    setVal('')
  }

  return (
    <div className="flex items-center gap-2 pl-4 text-[10px]">
      <span className="text-coffee-500">cap</span>
      {cap && !editing ? (
        <>
          <span
            className={clsx(
              'rounded bg-aux-yellow/10 px-1 py-0.5 font-mono text-aux-yellow',
              noop && 'opacity-50',
            )}
            title={
              noop
                ? 'This edge is governance-only (backward) — the cap has no effect on forward capital.'
                : 'Forward capital through this edge is bounded to this amount.'
            }
          >
            ◆ {capLabel(cap)}
            {!isUsdHardcoded && ''}
          </span>
          <button
            type="button"
            onClick={() => onSet(undefined)}
            title="Remove this edge cap"
            className="text-coffee-400 hover:text-aux-red"
          >
            ✕
          </button>
          {noop && (
            <span className="text-[9px] text-coffee-500">
              (no effect while gov-only)
            </span>
          )}
        </>
      ) : editing ? (
        <span className="flex items-center gap-1">
          <span className="text-coffee-400">$</span>
          <input
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setEditing(false)
                setVal('')
              }
            }}
            onBlur={commit}
            placeholder="USD amount"
            className="w-24 rounded border border-coffee-600 bg-coffee-900 px-1 py-0.5 font-mono text-coffee-100"
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-coffee-400 hover:text-coffee-200"
        >
          ＋ set cap
        </button>
      )}
    </div>
  )
}

/** Three-way traversal-scope control for permission/dependency edges. */
function ScopeControl({
  scope,
  onChange,
}: {
  scope: EdgeScope
  onChange: (s: EdgeScope) => void
}): JSX.Element {
  const opts: { value: EdgeScope; label: string; title: string }[] = [
    {
      value: 'both',
      label: 'both',
      title: 'Counts for governance and capital',
    },
    {
      value: 'backward',
      label: 'gov',
      title: 'Governance-only — real ownership, no forward capital flare',
    },
    {
      value: 'forward',
      label: 'capital',
      title: 'Capital-only — excluded from governance chains',
    },
  ]
  return (
    <div className="flex overflow-hidden rounded border border-coffee-600">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          title={o.title}
          className={clsx(
            'px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider',
            scope === o.value
              ? 'bg-coffee-600 text-coffee-100'
              : 'text-coffee-400 hover:text-coffee-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A small on/off switch. on = edge is in the graph. */
function Toggle({
  on,
  title,
  onClick,
}: {
  on: boolean
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx(
        'relative h-4 w-7 shrink-0 rounded-full transition-colors',
        on ? 'bg-aux-green/70' : 'bg-coffee-600',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-3 w-3 rounded-full bg-coffee-900 transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

// ── Add-edge inline form ─────────────────────────────────────────────────────

function AddEdgeForm({
  sourceId,
  nodes,
  onAddEdge,
}: {
  sourceId: string
  nodes: Map<string, CallNode>
  onAddEdge: (from: string, to: string, edgeType: BackendEdgeType) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [type, setType] = useState<BackendEdgeType>('callgraph')

  const matches = useMemo(() => {
    if (!open) return []
    const needle = q.trim().toLowerCase()
    const out: { id: string; label: string }[] = []
    for (const n of nodes.values()) {
      if (n.id === sourceId) continue
      if (n.contractAddress.startsWith('unresolved:')) continue
      const label = nodeLabel(n.id, nodes)
      if (needle && !`${label} ${n.id}`.toLowerCase().includes(needle)) continue
      out.push({ id: n.id, label })
      if (out.length >= 50) break
    }
    return out.slice(0, 8)
  }, [open, q, nodes, sourceId])

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 w-full rounded border border-coffee-600 border-dashed py-1.5 font-mono text-[11px] text-coffee-400 hover:border-coffee-400 hover:text-coffee-200"
      >
        ＋ add outgoing edge
      </button>
    )
  }

  return (
    <div className="mt-1.5 rounded border border-coffee-600 bg-coffee-800 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-coffee-400 uppercase tracking-wider">
          type
        </span>
        <MiniBtn on={type === 'callgraph'} onClick={() => setType('callgraph')}>
          call
        </MiniBtn>
        <MiniBtn
          on={type === 'dependency'}
          onClick={() => setType('dependency')}
        >
          dependency
        </MiniBtn>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setQ('')
          }}
          className="text-coffee-400 text-xs hover:text-coffee-200"
        >
          ✕
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search target node by name / address…"
        className="mb-1 w-full rounded border border-coffee-600 bg-coffee-900 px-2 py-1.5 font-mono text-[11px] text-coffee-200 outline-none placeholder:text-coffee-500 focus:border-coffee-400"
      />
      <div className="max-h-44 overflow-y-auto">
        {matches.length === 0 ? (
          <p className="px-1 py-1 text-[10.5px] text-coffee-400">
            {q ? 'No matching nodes.' : 'Type to search nodes…'}
          </p>
        ) : (
          matches.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onAddEdge(sourceId, m.id, type)
                setOpen(false)
                setQ('')
              }}
              className="mb-0.5 block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[10.5px] text-coffee-200 hover:bg-coffee-700"
              title={m.id}
            >
              → {m.label}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function nodeLabel(id: string, nodes: Map<string, CallNode>): string {
  const { address, functionName } = parseNodeId(id)
  const n = nodes.get(id) ?? nodes.get(address)
  const name = n?.contractName ?? shortAddr(address)
  return functionName ? `${name}.${functionName}` : name
}

function KvRow({ k, v }: { k: string; v: React.ReactNode }): JSX.Element {
  return (
    <div className="flex justify-between gap-2 border-coffee-600 border-b border-dashed py-1.5 font-mono text-[11.5px]">
      <span className="text-coffee-400">{k}</span>
      <span className="break-all text-right text-coffee-200">{v}</span>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="mt-4">
      <div className="mb-1.5 font-mono text-[10px] text-coffee-400 uppercase tracking-wider">
        {title}
      </div>
      {children}
    </div>
  )
}

function ActionBtn({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded border border-coffee-600 bg-coffee-800 px-2.5 font-mono text-[11px] text-coffee-200 hover:border-coffee-400"
    >
      {children}
    </button>
  )
}

function MiniBtn({
  on,
  onClick,
  title,
  children,
}: {
  on?: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx(
        'rounded border px-1.5 py-0.5 font-mono text-[10px]',
        on
          ? 'border-coffee-400 bg-coffee-600 text-coffee-200'
          : 'border-coffee-600 bg-coffee-800 text-coffee-400 hover:text-coffee-200',
      )}
    >
      {children}
    </button>
  )
}

function EdgeKindBadge({
  kind,
  dimmed,
}: {
  kind: CallEdge['kind']
  dimmed?: boolean
}): JSX.Element {
  const tone =
    kind === 'external'
      ? 'text-aux-green bg-aux-green/10'
      : kind === 'optimistic'
        ? 'text-aux-purple bg-aux-purple/10'
        : kind === 'permissioned'
          ? 'text-aux-orange bg-aux-orange/10'
          : kind === 'permission'
            ? 'text-aux-red bg-aux-red/10'
            : kind === 'dependency'
              ? 'text-aux-blue bg-aux-blue/10'
              : kind === 'delegatecall'
                ? 'text-aux-purple bg-aux-purple/10'
                : kind === 'unresolved'
                  ? 'text-aux-yellow bg-aux-yellow/10'
                  : 'text-coffee-400 bg-coffee-900'
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider',
        tone,
        dimmed && 'opacity-50',
      )}
    >
      {kind}
    </span>
  )
}

// ───────────────────── Notes tab ─────────────────────

function NotesTab({ selectedId }: Props): JSX.Element {
  const { project } = useParams()
  // Select the raw value (no fresh `{}` literal in the selector) to avoid the
  // useSyncExternalStore re-render loop — see React #185 note in CallGraphView.
  const notesRaw = useCallgraphOverridesStore((s) =>
    project ? s.notes[project] : undefined,
  )
  const notes = notesRaw ?? EMPTY_NOTES
  const setNote = useCallgraphOverridesStore((s) => s.setNote)

  if (!selectedId) {
    return (
      <p className="text-coffee-400 italic">
        Select a node to attach research notes. Stored locally per project +
        node.
      </p>
    )
  }
  const value = notes[selectedId] ?? ''
  return (
    <>
      <div className="mb-1 font-mono text-[10px] text-coffee-400 uppercase tracking-wider">
        notes for
      </div>
      <div className="mb-2 break-all font-mono text-[12.5px] text-coffee-200">
        {selectedId}
      </div>
      <textarea
        value={value}
        onChange={(e) =>
          project && setNote(project, selectedId, e.target.value)
        }
        placeholder="e.g. unguarded — anyone can call. Verify Oracle.getPrice has staleness check…"
        className="min-h-24 w-full resize-y rounded border border-coffee-600 bg-coffee-900 px-2.5 py-2 font-mono text-[11.5px] text-coffee-200 outline-none focus:border-coffee-400"
      />
      <p className="mt-1.5 text-[10px] text-coffee-400">
        {value.length} char · saved automatically
      </p>
    </>
  )
}

// ───────────────────── Rules tab ─────────────────────

function RulesTab({
  rules,
  unmatchedRuleIds,
  onDeleteRule,
}: Props): JSX.Element {
  const unmatched = new Set(unmatchedRuleIds ?? [])
  if (rules.length === 0) {
    return (
      <p className="text-coffee-400 italic">
        No override rules yet. In the Node tab, toggle an edge off to suppress
        it or use "＋ add outgoing edge". Rules persist to{' '}
        <span className="font-mono">call-graph-overrides.json</span> and are
        re-applied to capital/governance analysis on every recompute.
      </p>
    )
  }
  return (
    <div className="font-mono text-[11px]">
      <p className="mb-2 text-[10px] text-coffee-400">
        {rules.length} rule{rules.length === 1 ? '' : 's'} · applied on every
        graph recompute
      </p>
      {rules.map((rule) => {
        const stale = unmatched.has(rule.id)
        return (
          <div
            key={rule.id}
            className="mb-1 flex items-start gap-2 rounded border border-coffee-600 bg-coffee-800 px-2 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="break-words text-[10.5px] text-coffee-200">
                {describeRule(rule)}
              </div>
              {rule.note && (
                <div className="text-[10px] text-coffee-400">{rule.note}</div>
              )}
              {stale && (
                <div
                  className="mt-0.5 text-[9.5px] text-aux-yellow"
                  title="This rule matched no edge — it may be stale after a call-graph regeneration."
                >
                  ⚠ matches nothing — re-verify
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDeleteRule(rule.id)}
              title="Delete rule"
              className="text-coffee-400 hover:text-aux-red"
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────── Suggestions tab (agent inbox) ─────────────────────

function SuggestionsTab({
  suggestions,
  rawEdges,
  onFocusSuggestion,
  onResolveSuggestion,
}: Props): JSX.Element {
  const pending = suggestions.filter((s) => s.status === 'pending')
  const resolved = suggestions.filter((s) => s.status !== 'pending')

  if (suggestions.length === 0) {
    return (
      <p className="text-coffee-400 italic">
        No agent suggestions. Agents propose edge rules into{' '}
        <span className="font-mono">call-graph-suggestions.json</span>; they
        stay inert (never affect analysis) until you accept one here.
      </p>
    )
  }
  return (
    <div className="font-mono text-[11px]">
      <p className="mb-2 text-[10px] text-coffee-400">
        {pending.length} pending · {resolved.length} resolved
      </p>
      {pending.map((s) => (
        <SuggestionCard
          key={s.id}
          s={s}
          rawEdges={rawEdges}
          onFocusSuggestion={onFocusSuggestion}
          onResolveSuggestion={onResolveSuggestion}
        />
      ))}
      {resolved.length > 0 && (
        <div className="mt-3 border-coffee-600 border-t pt-2">
          <div className="mb-1.5 text-[10px] text-coffee-500 uppercase tracking-wider">
            resolved
          </div>
          {resolved.map((s) => (
            <SuggestionCard
              key={s.id}
              s={s}
              rawEdges={rawEdges}
              onFocusSuggestion={onFocusSuggestion}
              onResolveSuggestion={onResolveSuggestion}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SuggestionCard({
  s,
  rawEdges,
  onFocusSuggestion,
  onResolveSuggestion,
}: {
  s: RuleSuggestion
  rawEdges: CallEdge[]
  onFocusSuggestion: (rule: EdgeOverrideRule) => void
  onResolveSuggestion: (id: string, action: 'accept' | 'reject') => void
}): JSX.Element {
  const pending = s.status === 'pending'
  const stale = !ruleMatchesAnyEdge(s.rule, rawEdges)
  return (
    <div
      className={clsx(
        'mb-1.5 rounded border bg-coffee-800 px-2 py-2',
        pending ? 'border-coffee-600' : 'border-coffee-700 opacity-70',
      )}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="break-words text-[10.5px] text-coffee-100">
          {describeRule(s.rule)}
        </span>
        {!pending && (
          <span
            className={clsx(
              'shrink-0 rounded px-1 text-[8.5px] uppercase tracking-wider',
              s.status === 'accepted'
                ? 'bg-aux-green/15 text-aux-green'
                : 'bg-coffee-700 text-coffee-400',
            )}
          >
            {s.status}
          </span>
        )}
      </div>
      {s.reasoning && (
        <p className="mb-1.5 text-[10px] text-coffee-300 leading-snug">
          {s.reasoning}
        </p>
      )}
      <div className="mb-1.5 flex items-center gap-2 text-[9px] text-coffee-500">
        {s.createdBy && <span>by {s.createdBy}</span>}
        {stale && (
          <span
            className="text-aux-yellow"
            title="This rule matches no current edge — the graph may have changed since it was suggested."
          >
            ⚠ edge not present
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <MiniBtn onClick={() => onFocusSuggestion(s.rule)}>⊙ focus</MiniBtn>
        {pending && (
          <>
            <button
              type="button"
              onClick={() => onResolveSuggestion(s.id, 'accept')}
              className="rounded border border-aux-green/50 bg-aux-green/10 px-2 py-0.5 font-mono text-[10px] text-aux-green hover:bg-aux-green/20"
            >
              ✓ accept
            </button>
            <button
              type="button"
              onClick={() => onResolveSuggestion(s.id, 'reject')}
              className="rounded border border-coffee-600 px-2 py-0.5 font-mono text-[10px] text-coffee-400 hover:text-aux-red"
            >
              ✕ reject
            </button>
          </>
        )}
      </div>
    </div>
  )
}
