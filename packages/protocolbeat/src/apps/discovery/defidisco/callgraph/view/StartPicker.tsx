// Empty-state picker shown when no starting function is selected.

import { useMemo, useState } from 'react'
import { clsx } from 'clsx'
import type { CallNode } from '../model'

interface Props {
  entrypoints: { id: string; node: CallNode }[]
  onPick: (id: string) => void
}

export function StartPicker({ entrypoints, onPick }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    if (!q) return entrypoints
    const needle = q.toLowerCase()
    return entrypoints.filter(({ id, node }) =>
      `${node.contractName}.${node.functionName} ${id}`
        .toLowerCase()
        .includes(needle),
    )
  }, [q, entrypoints])

  return (
    <div className="flex h-full w-full items-center justify-center p-10">
      <div
        className="w-full max-w-lg rounded-md border border-coffee-600 bg-coffee-800 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold text-coffee-200">
          Pick a starting function
        </h2>
        <p className="mb-4 text-xs text-coffee-400">
          The callgraph fans out downward from the function you select. Change
          depth, expand or collapse contracts, and edit edges live.
        </p>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter… try “harvest” or “swap”"
          className={clsx(
            'mb-2 w-full rounded border border-coffee-600 bg-coffee-700 px-3 py-2',
            'font-mono text-xs text-coffee-200 outline-none placeholder:text-coffee-400',
            'focus:border-coffee-400',
          )}
        />
        <div className="max-h-80 overflow-y-auto rounded border border-coffee-600 bg-coffee-900">
          {filtered.map(({ id, node }) => (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              className={clsx(
                'flex w-full items-center gap-2 border-b border-coffee-600 px-3 py-2 text-left',
                'font-mono text-xs last:border-b-0 hover:bg-coffee-700',
              )}
            >
              <span
                className={clsx(
                  'h-2 w-2 rounded-sm',
                  node.kind === 'project' ? 'bg-aux-pink' : 'bg-coffee-400',
                )}
              />
              <span className="text-coffee-400">{node.contractName}.</span>
              <span className="text-coffee-200">{node.functionName}</span>
              <span className="ml-auto flex items-center gap-2">
                {node.isPermissioned && (
                  <span className="rounded border border-aux-orange/60 px-1 text-[10px] text-aux-orange">
                    permissioned
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-wider text-coffee-400">
                  {node.isView ? 'view' : 'write'}
                </span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="p-4 text-center text-xs text-coffee-400">
              No matches.
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-coffee-400">
          <span>
            {filtered.length} entrypoint{filtered.length === 1 ? '' : 's'}
          </span>
          <span>click a row to start tracing</span>
        </div>
      </div>
    </div>
  )
}
