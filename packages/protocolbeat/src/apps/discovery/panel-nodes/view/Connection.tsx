export interface ConnectionProps {
  from: { x: number; y: number; direction: 'left' | 'right' }
  to: { x: number; y: number; direction: 'left' | 'right' }
  isHighlighted?: boolean
  isDashed?: boolean
  isDimmed?: boolean
  isGrayedOut?: boolean
  hasCallGraphData?: boolean
  onClick?: (e: React.MouseEvent<SVGPathElement>) => void
}

export function Connection({
  from,
  to,
  isDashed,
  hasCallGraphData,
  onClick,
  ...rest
}: ConnectionProps) {
  const controlA = {
    x: from.x + (from.direction === 'left' ? -50 : 50),
    y: from.y,
  }

  const controlB = {
    x: to.x + (to.direction === 'left' ? -50 : 50),
    y: to.y,
  }

  const d = [
    'M',
    from.x,
    from.y,
    'C',
    controlA.x,
    controlA.y,
    controlB.x,
    controlB.y,
    to.x,
    to.y,
  ].join(' ')

  return (
    <g>
      {/* Invisible hitbox for clickable edges with call graph data */}
      {hasCallGraphData && (
        <path
          d={d}
          stroke="transparent"
          strokeWidth={16}
          strokeLinecap="round"
          pointerEvents="stroke"
          className="cursor-pointer"
          onClick={onClick}
        />
      )}
      {/* Visible path */}
      <path
        d={d}
        strokeLinecap="round"
        strokeDasharray={isDashed ? '5,5' : undefined}
        className={toStrokeClass(rest, hasCallGraphData)}
        pointerEvents="none"
      />
    </g>
  )
}

function toStrokeClass(
  props: Pick<ConnectionProps, 'isHighlighted' | 'isDimmed' | 'isGrayedOut'>,
  hasCallGraphData?: boolean,
) {
  if (props.isHighlighted) {
    return 'stroke-[3] stroke-autumn-300'
  }

  if (props.isGrayedOut) {
    return 'stroke-2 stroke-coffee-200/10'
  }

  if (props.isDimmed) {
    return 'stroke-2 stroke-coffee-400/30'
  }

  // Edges with call graph data get a flashy color to indicate they're interactive
  if (hasCallGraphData) {
    return 'stroke-[3] stroke-aux-cyan'
  }

  return 'stroke-2 stroke-coffee-400'
}
