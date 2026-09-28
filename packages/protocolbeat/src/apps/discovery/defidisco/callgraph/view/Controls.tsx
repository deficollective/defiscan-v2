// Bottom strip of controls: layout mode, depth, edge-kind filters, edit toggle,
// path-trail breadcrumb. Modelled on the existing panel-nodes/controls/Controls.tsx
// styling so it sits beside the other panels naturally.

import { clsx } from 'clsx'
import type { CallNode } from '../model'
import { parseNodeId } from '../model'
import type { LayoutMode } from '../layout'

type EdgeKindKey =
  | 'hideInternal'
  | 'hideExternal'
  | 'hideOptimistic'
  | 'hidePermissioned'
  | 'hidePermission'
  | 'hideDependency'
  | 'hideDelegatecall'
  | 'hideUnresolved'

interface Props {
  layoutMode: LayoutMode
  setLayoutMode: (m: LayoutMode) => void
  /** Downstream BFS depth: how many caller→callee hops to expand below the start. */
  depth: number
  setDepth: (d: number) => void
  /** Upstream BFS depth: how many caller rows to expand above the start. 0 hides callers. */
  upDepth: number
  setUpDepth: (d: number) => void
  filters: Record<EdgeKindKey, boolean>
  setFilters: (next: Record<EdgeKindKey, boolean>) => void
  onClearStart: () => void
  onReset: () => void
  trail: string[] | null
  nodes: Map<string, CallNode>
  onSelectNode: (id: string) => void
}

const KIND_BUTTONS: { key: EdgeKindKey; label: string; dotClass: string }[] = [
  { key: 'hideInternal', label: 'internal', dotClass: 'bg-coffee-400' },
  { key: 'hideExternal', label: 'external', dotClass: 'bg-aux-green' },
  { key: 'hideOptimistic', label: 'optimistic', dotClass: 'bg-aux-purple' },
  { key: 'hidePermissioned', label: 'permissioned', dotClass: 'bg-aux-orange' },
  { key: 'hidePermission', label: 'owns', dotClass: 'bg-aux-red' },
  { key: 'hideDependency', label: 'dependency', dotClass: 'bg-aux-blue' },
  { key: 'hideDelegatecall', label: 'delegate', dotClass: 'bg-aux-purple' },
  { key: 'hideUnresolved', label: 'unresolved', dotClass: 'bg-aux-yellow' },
]

export function Controls({
  layoutMode,
  setLayoutMode,
  depth,
  setDepth,
  upDepth,
  setUpDepth,
  filters,
  setFilters,
  onClearStart,
  onReset,
  trail,
  nodes,
  onSelectNode,
}: Props): JSX.Element {
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-coffee-500 border-t bg-coffee-700 px-3 py-2 font-mono text-[11px]">
      {/* Layout */}
      <Group label="layout">
        {(['tree', 'lanes', 'compact'] as LayoutMode[]).map((m) => (
          <PillButton
            key={m}
            on={layoutMode === m}
            onClick={() => setLayoutMode(m)}
          >
            {m === 'tree' ? '▾ tree' : m === 'lanes' ? '┃ lanes' : '◫ compact'}
          </PillButton>
        ))}
      </Group>

      {/* Trace depth — separate sliders for upstream callers and downstream
          callees. Upstream defaults to 1 (matches the original single-row caller
          behavior); set 0 to hide callers entirely. */}
      <Group label="↑ callers">
        <input
          type="range"
          min={0}
          max={6}
          value={upDepth}
          onChange={(e) => setUpDepth(+e.target.value)}
          className="h-3 w-24 accent-aux-pink"
          title="How many levels of callers to show above the start node"
        />
        <span className="w-4 text-center text-coffee-200">{upDepth}</span>
      </Group>
      <Group label="↓ callees">
        <input
          type="range"
          min={1}
          max={6}
          value={depth}
          onChange={(e) => setDepth(+e.target.value)}
          className="h-3 w-24 accent-aux-pink"
          title="How many levels of callees to expand below the start node"
        />
        <span className="w-4 text-center text-coffee-200">{depth}</span>
      </Group>

      <div className="min-w-2 flex-1" />

      {/* Path trail */}
      <div
        className={clsx(
          'flex max-w-[40%] shrink-0 items-center gap-1 overflow-x-auto rounded border border-coffee-600',
          'bg-coffee-900 px-2 py-1 font-mono text-[10.5px]',
        )}
        title="Path from start to selected node"
      >
        {trail && trail.length > 1 ? (
          trail.map((id, i) => {
            const node = nodes.get(parseNodeId(id).address)
            const fn = parseNodeId(id).functionName
            return (
              <span key={`${id}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span className="text-coffee-400">›</span>}
                <button
                  type="button"
                  className="whitespace-nowrap text-aux-cyan hover:underline"
                  onClick={() => onSelectNode(id)}
                >
                  <span className="text-coffee-400">
                    {node?.contractName}
                    {fn ? '.' : ''}
                  </span>
                  {fn ?? ''}
                </button>
              </span>
            )
          })
        ) : (
          <span className="whitespace-nowrap text-coffee-400">
            select a node to trace path from start →
          </span>
        )}
      </div>

      <PillButton onClick={onClearStart}>↺ new trace</PillButton>
      <PillButton
        onClick={onReset}
        title="Clear user-added/removed edges and notes"
      >
        reset
      </PillButton>

      {/* Edge filters at the far right of the bottom strip. */}
      <Group label="edges">
        {KIND_BUTTONS.map(({ key, label, dotClass }) => (
          <PillButton
            key={key}
            on={!filters[key]}
            onClick={() => setFilters({ ...filters, [key]: !filters[key] })}
          >
            <span className={clsx('h-1.5 w-1.5 rounded-full', dotClass)} />
            {label}
          </PillButton>
        ))}
      </Group>
    </div>
  )
}

function Group({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-r border-coffee-600 pr-3 last:border-r-0">
      <span className="text-[10px] uppercase tracking-wider text-coffee-400">
        {label}
      </span>
      {children}
    </div>
  )
}

function PillButton({
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
        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-2.5',
        'font-mono text-[11px] transition-colors',
        on
          ? 'border-coffee-400 bg-coffee-600 text-coffee-200'
          : 'border-coffee-600 bg-coffee-700 text-coffee-400 hover:border-coffee-400 hover:text-coffee-200',
      )}
    >
      {children}
    </button>
  )
}
