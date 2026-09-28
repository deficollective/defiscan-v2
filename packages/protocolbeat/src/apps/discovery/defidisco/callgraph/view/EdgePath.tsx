// SVG edge connecting two nodes. Curve goes from bottom-center of `from` to
// top-center of `to`. Kind drives both color and dash pattern.

import { useMemo } from 'react'
import type { CallEdge } from '../model'
import { parseNodeId } from '../model'

interface Props {
  edge: CallEdge
  fromX: number
  fromY: number
  toX: number
  toY: number
  hovered: boolean
  onPath: boolean
  dimmed: boolean
  showLabel: boolean
  /** Suggestion review highlight: 'remove' → red, 'add' → green. */
  preview?: 'add' | 'remove'
  onHover: (edge: CallEdge | null) => void
  onClick?: (edge: CallEdge) => void
}

const COLOR_BY_KIND = {
  internal: 'var(--coffee-400, #9378B3)',
  external: 'var(--aux-green, #9DDE6C)',
  optimistic: 'var(--aux-purple, #a73db5)',
  permissioned: 'var(--aux-orange, #FE8019)',
  permission: 'var(--aux-red, #FB4A35)',
  dependency: 'var(--aux-blue, #8B8BE8)',
  delegatecall: 'var(--aux-purple, #a73db5)',
  unresolved: 'var(--aux-yellow, #FABD30)',
} as const

const DASH_BY_KIND: Record<CallEdge['kind'], string> = {
  internal: '4 5',
  external: '6 4',
  optimistic: '4 4',
  permissioned: '6 4',
  permission: '',
  dependency: '5 3',
  delegatecall: '2 6',
  unresolved: '2 3',
}

export function EdgePath({
  edge,
  fromX,
  fromY,
  toX,
  toY,
  hovered,
  onPath,
  dimmed,
  showLabel,
  preview,
  onHover,
  onClick,
}: Props): JSX.Element {
  const { d, mx, my } = useMemo(() => {
    const dy = toY - fromY
    const curve = Math.max(40, Math.abs(dy) * 0.4)
    return {
      d: `M ${fromX} ${fromY} C ${fromX} ${fromY + curve}, ${toX} ${toY - curve}, ${toX} ${toY}`,
      mx: (fromX + toX) / 2,
      my: (fromY + toY) / 2,
    }
  }, [fromX, fromY, toX, toY])

  // Preview (suggestion review) overrides everything: red to remove, green to add.
  const stroke = preview
    ? preview === 'remove'
      ? 'var(--aux-red, #FB4A35)'
      : 'var(--aux-green, #9DDE6C)'
    : onPath
      ? 'var(--aux-cyan, #1c92a8)'
      : (COLOR_BY_KIND[edge.kind] ?? COLOR_BY_KIND.internal)
  const opacity = preview ? 1 : dimmed ? 0.15 : hovered ? 1 : 0.85
  const strokeWidth = preview ? 3 : onPath || hovered ? 2 : 1.2

  const label = edge.label ?? parseNodeId(edge.to).functionName ?? ''
  const labelText = label.length > 22 ? `${label.slice(0, 21)}…` : label
  const labelW = labelText.length * 6.3 + 12
  // Edge-centric markers: relationship constraints live on the edge (vs a
  // function-intrinsic cap/mitigation, which would render on a node). Shown as
  // small glyphs so edge-level constraints are distinguishable on the canvas.
  const hasCap = !!edge.cap
  const hasMit = !!edge.mitigations && edge.mitigations.length > 0
  const markerText = `${hasCap ? '◆' : ''}${hasMit ? '🛡' : ''}`

  return (
    <g
      onMouseEnter={() => onHover(edge)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(edge)
      }}
      style={{
        pointerEvents: 'stroke',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {/* Wider invisible hit area */}
      <path d={d} stroke="transparent" strokeWidth={14} fill="none" />
      <path
        d={d}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={preview === 'add' ? '6 4' : DASH_BY_KIND[edge.kind]}
        fill="none"
        opacity={opacity}
        markerEnd={`url(#arrow-${
          preview === 'remove'
            ? 'permission'
            : preview === 'add'
              ? 'external'
              : onPath
                ? 'cyan'
                : edge.kind
        })`}
      />
      {showLabel && labelText && (
        <>
          <rect
            x={mx - labelW / 2}
            y={my - 9}
            width={labelW}
            height={16}
            rx={2}
            fill="var(--coffee-900, #1A151F)"
            stroke="var(--coffee-600, #4A3A5F)"
            strokeWidth={0.8}
            style={{ pointerEvents: 'none' }}
          />
          <text
            x={mx}
            y={my + 2.5}
            textAnchor="middle"
            fill={
              onPath ? 'var(--aux-cyan, #1c92a8)' : 'var(--coffee-200, #E0D4F0)'
            }
            style={{
              font: '9.5px ui-monospace, Menlo, monospace',
              pointerEvents: 'none',
            }}
          >
            {labelText}
          </text>
          {markerText && (
            <text
              x={mx + labelW / 2 + 4}
              y={my + 3}
              textAnchor="start"
              fill="var(--aux-yellow, #FABD30)"
              style={{
                font: '11px ui-monospace, monospace',
                pointerEvents: 'none',
              }}
            >
              {markerText}
            </text>
          )}
        </>
      )}
    </g>
  )
}

/** Arrowhead defs shared across edges. Render once per SVG. */
export function ArrowDefs(): JSX.Element {
  const markers: { id: string; color: string }[] = [
    { id: 'arrow-internal', color: 'var(--coffee-400, #9378B3)' },
    { id: 'arrow-external', color: 'var(--aux-green, #9DDE6C)' },
    { id: 'arrow-optimistic', color: 'var(--aux-purple, #a73db5)' },
    { id: 'arrow-permissioned', color: 'var(--aux-orange, #FE8019)' },
    { id: 'arrow-permission', color: 'var(--aux-red, #FB4A35)' },
    { id: 'arrow-dependency', color: 'var(--aux-blue, #8B8BE8)' },
    { id: 'arrow-delegatecall', color: 'var(--aux-purple, #a73db5)' },
    { id: 'arrow-unresolved', color: 'var(--aux-yellow, #FABD30)' },
    { id: 'arrow-cyan', color: 'var(--aux-cyan, #1c92a8)' },
  ]
  return (
    <defs>
      {markers.map((m) => (
        <marker
          key={m.id}
          id={m.id}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={m.color} />
        </marker>
      ))}
    </defs>
  )
}
