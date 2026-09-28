// One node in the callgraph canvas. Renders contract / function / external /
// EOA / unknown variants. All sizing constants come from layout.ts so the
// SVG edges stay aligned without DOM measurement.

import { useCallback, useState } from 'react'
import { clsx } from 'clsx'
import type { CallNode } from '../model'
import { type LayoutMode, nodeHeight, nodeWidth } from '../layout'
import { shortAddr } from '../model'

interface Props {
  node: CallNode
  x: number
  y: number
  mode: LayoutMode
  isStart: boolean
  isSelected: boolean
  isOnPath: boolean
  isDimmed: boolean
  isCollapsed: boolean
  /** True for caller nodes shown above the start (informational tag only). */
  isCaller?: boolean
  /** Other write functions on the same contract — selectable to jump to. */
  siblings?: { id: string; name: string; isPermissioned: boolean }[]
  onSelect: (id: string) => void
  /** Double-click → take this node as the new trace start. Also used by the
   *  sibling switcher (picking another function re-focuses on it). */
  onReFocus: (id: string) => void
  onToggleCollapse: (contractAddress: string) => void
  onHandleMouseDown: (id: string, e: React.MouseEvent) => void
}

export function Node(props: Props): JSX.Element {
  const {
    node,
    x,
    y,
    mode,
    isStart,
    isSelected,
    isOnPath,
    isDimmed,
    isCollapsed,
    isCaller,
    siblings,
    onSelect,
    onReFocus,
    onToggleCollapse,
    onHandleMouseDown,
  } = props

  const [siblingsOpen, setSiblingsOpen] = useState(false)

  const isFn = node.functionName !== undefined
  const isExternal = node.kind === 'external'
  const isEoa = node.kind === 'eoa'
  const isUnknown = node.kind === 'unknown'

  const w = nodeWidth(mode)
  const h = nodeHeight(node, mode)

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onSelect(node.id)
    },
    [node.id, onSelect],
  )

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onReFocus(node.id)
    },
    [node.id, onReFocus],
  )

  const headBg =
    node.kind === 'project'
      ? 'bg-aux-pink text-coffee-900'
      : isUnknown
        ? 'bg-coffee-600 text-aux-yellow'
        : 'bg-coffee-700 text-coffee-200'

  return (
    <div
      data-node-id={node.id}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title="Double-click to focus the trace here"
      className={clsx(
        'absolute rounded border bg-coffee-800 select-none transition-shadow',
        'font-mono text-[11.5px]',
        isStart
          ? 'border-aux-cyan shadow-[0_0_0_1px_var(--tw-shadow-color)] shadow-aux-cyan'
          : isSelected
            ? 'border-aux-cyan shadow-[0_6px_24px_rgba(28,146,168,0.25)]'
            : isOnPath
              ? 'border-aux-cyan'
              : 'border-coffee-600 hover:border-coffee-400',
        isCaller && 'border-dashed',
        isDimmed && 'opacity-40',
      )}
      style={{ left: x, top: y, width: w, minHeight: h }}
    >
      {/* Caller cue — these sit above the start; clicking climbs the trace. */}
      {isCaller && (
        <span className="-top-2 -translate-x-1/2 absolute left-1/2 rounded-full border border-aux-cyan/60 bg-coffee-800 px-1.5 text-[8.5px] text-aux-cyan uppercase tracking-wider">
          ↑ caller
        </span>
      )}
      {/* Header */}
      <div
        className={clsx(
          'flex items-center gap-2 rounded-t px-2.5 py-1.5',
          headBg,
        )}
      >
        <span className="text-[11px] leading-none">
          {isEoa ? '⊙' : isUnknown ? '?' : isExternal ? '⊟' : '▣'}
        </span>
        <span className="flex-1 truncate font-medium">{node.contractName}</span>
        {isExternal && (
          <span className="rounded bg-black/20 px-1 text-[9px] uppercase tracking-wider">
            ext
          </span>
        )}
        {isEoa && (
          <span className="rounded bg-black/20 px-1 text-[9px] uppercase tracking-wider">
            eoa
          </span>
        )}
        {isUnknown && (
          <span className="rounded bg-black/20 px-1 text-[9px] uppercase tracking-wider">
            unresolved
          </span>
        )}
        {!isExternal && !isEoa && !isUnknown && (
          <span className="h-1.5 w-1.5 rounded-full bg-aux-green" />
        )}
      </div>

      {/* Body */}
      <div className="px-2.5 py-2">
        {isFn ? (
          <>
            <div className="break-all leading-tight text-coffee-200">
              <span className="text-aux-pink">{node.functionName}</span>
              <span className="text-coffee-400">()</span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[10px] text-coffee-400">
              <span className="uppercase tracking-wider text-coffee-200">
                {node.isView ? 'view' : 'write'}
              </span>
              {node.isPermissioned && (
                <span className="rounded border border-aux-orange/60 px-1 text-aux-orange">
                  permissioned
                </span>
              )}
            </div>

            {/* Other write functions on this contract — pick one to re-focus. */}
            {siblings && siblings.length > 0 && (
              <div className="relative mt-1.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSiblingsOpen((o) => !o)
                  }}
                  className="flex w-full items-center justify-between rounded border border-coffee-600 px-1.5 py-1 text-[10px] text-coffee-400 hover:border-coffee-400 hover:text-coffee-200"
                  title="Other write functions on this contract"
                >
                  <span>
                    ⇄ {siblings.length} other fn
                    {siblings.length === 1 ? '' : 's'}
                  </span>
                  <span>{siblingsOpen ? '▴' : '▾'}</span>
                </button>
                {siblingsOpen && (
                  <>
                    {/* Click-away backdrop */}
                    <button
                      type="button"
                      className="fixed inset-0 z-40 cursor-default"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSiblingsOpen(false)
                      }}
                    />
                    <div className="absolute top-full left-0 z-50 mt-1 max-h-48 w-full overflow-y-auto rounded border border-coffee-600 bg-coffee-900 py-0.5 shadow-lg">
                      {siblings.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSiblingsOpen(false)
                            onReFocus(s.id)
                          }}
                          className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10.5px] text-coffee-200 hover:bg-coffee-700"
                          title={s.name}
                        >
                          {s.isPermissioned && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-aux-orange" />
                          )}
                          <span className="truncate">
                            <span className="text-aux-pink">{s.name}</span>
                            <span className="text-coffee-400">()</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        ) : isEoa ? (
          <div className="text-[10.5px] text-coffee-400">
            <div className="text-coffee-200">
              {shortAddr(node.contractAddress)}
            </div>
            <div className="mt-0.5">externally-owned</div>
          </div>
        ) : (
          <div className="text-[10.5px] text-coffee-400">
            <div className="text-coffee-200">
              {shortAddr(node.contractAddress)}
            </div>
            {isCollapsed && <div className="mt-0.5">collapsed</div>}
          </div>
        )}
      </div>

      {/* Collapse / expand badge */}
      {!isEoa && (
        <button
          type="button"
          title={
            isCollapsed ? 'Expand contract into functions' : 'Collapse contract'
          }
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapse(node.contractAddress)
          }}
          className={clsx(
            'absolute -top-1.5 -right-1.5 grid h-4 w-4 place-items-center',
            'rounded-full border border-coffee-600 bg-coffee-800 text-[10px] text-coffee-400',
            'opacity-0 transition-opacity group-hover:opacity-100 hover:border-aux-pink hover:text-aux-pink',
          )}
        >
          {isCollapsed ? '+' : '−'}
        </button>
      )}

      {/* Drag-to-create-edge handle */}
      <button
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation()
          onHandleMouseDown(node.id, e)
        }}
        className={clsx(
          'absolute left-1/2 -bottom-[6px] z-10 -translate-x-1/2',
          'grid h-3 w-3 place-items-center rounded-full',
          'border border-coffee-600 bg-coffee-800 text-[9px] text-coffee-400',
          'opacity-0 transition-opacity hover:border-aux-cyan hover:text-aux-cyan',
          'group-hover:opacity-100',
        )}
        title="Drag to another node to add an edge"
      >
        +
      </button>
    </div>
  )
}
