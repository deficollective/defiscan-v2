import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ForceGraph2D from 'react-force-graph-2d'
import { useAllReviews, useIndex } from '../../data/hooks'
import {
  etherscanUrl,
  formatUsdValue,
  stripChainPrefix,
  truncateAddress,
} from '../../utils/format'
import type { CompiledReview } from '../../types'

type NodeKind = 'entity' | 'protocol'

interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  /** Total USD impact — sum of incident edge weights. Drives node size. */
  totalValue: number
  /** For entity nodes: unique protocols impacted. Drives hero stats. */
  protocolCount: number
  /** Protocol slug for navigation (protocol nodes only). */
  slug?: string
  /** Raw chain-prefixed address (entity nodes — only when not grouped by entity). */
  address?: string
  entity?: string | null
  // Mutable fields added by force-graph at runtime
  x?: number
  y?: number
}

interface GraphLink {
  source: string | GraphNode
  target: string | GraphNode
  value: number
}

interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

function buildGraph(
  reviews: CompiledReview[],
  groupByEntity: boolean,
): GraphData {
  const nodes = new Map<string, GraphNode>()
  const linkMap = new Map<string, GraphLink>()

  for (const review of reviews) {
    const protocolId = `p:${review.metadata.protocolSlug}`
    if (!nodes.has(protocolId)) {
      nodes.set(protocolId, {
        id: protocolId,
        kind: 'protocol',
        label: review.metadata.protocolName,
        totalValue: 0,
        protocolCount: 0,
        slug: review.metadata.protocolSlug,
      })
    }
    const pNode = nodes.get(protocolId) as GraphNode

    for (const dep of review.dependencies) {
      const value = dep.totalFundsAtRisk ?? 0
      const entityKey =
        groupByEntity && dep.entity
          ? `e:entity:${dep.entity.toLowerCase()}`
          : `e:addr:${dep.address.toLowerCase()}`

      if (!nodes.has(entityKey)) {
        nodes.set(entityKey, {
          id: entityKey,
          kind: 'entity',
          label:
            groupByEntity && dep.entity
              ? dep.entity
              : dep.name || truncateAddress(dep.address),
          totalValue: 0,
          protocolCount: 0,
          address: dep.address,
          entity: dep.entity,
        })
      }
      const eNode = nodes.get(entityKey) as GraphNode
      eNode.totalValue += value
      pNode.totalValue += value

      // Dedupe parallel edges (entity grouping can collapse multiple addresses
      // → one entity node, producing duplicate (entity → protocol) edges).
      const linkKey = `${entityKey}->${protocolId}`
      const existing = linkMap.get(linkKey)
      if (existing) {
        existing.value += value
      } else {
        linkMap.set(linkKey, {
          source: entityKey,
          target: protocolId,
          value,
        })
      }
    }
  }

  // Count unique protocol neighbors per entity (for "single point of failure"
  // stats and side-panel display).
  const protocolNeighbors = new Map<string, Set<string>>()
  for (const link of linkMap.values()) {
    const src = typeof link.source === 'string' ? link.source : link.source.id
    const tgt = typeof link.target === 'string' ? link.target : link.target.id
    if (!protocolNeighbors.has(src)) {
      protocolNeighbors.set(src, new Set())
    }
    protocolNeighbors.get(src)?.add(tgt)
  }
  for (const [eid, set] of protocolNeighbors) {
    const n = nodes.get(eid)
    if (n) n.protocolCount = set.size
  }

  return { nodes: Array.from(nodes.values()), links: Array.from(linkMap.values()) }
}

function entityColor(value: number): string {
  if (value >= 1e9) return '#DC2626' // risk.critical — >$1B
  if (value >= 1e8) return '#F97316' // risk.high — >$100M
  if (value >= 1e6) return '#D97706' // risk.medium — >$1M
  if (value > 0) return '#06B6D4' // risk.minimal
  return '#94A3B8' // slate — no quantified impact
}

function entityRadius(value: number): number {
  // log-scale radius: $1 → ~4, $1M → ~9, $1B → ~14, $100B → ~17
  if (value <= 0) return 3
  return Math.max(3, Math.min(18, Math.log10(value + 1) * 1.5))
}

function linkWidth(value: number): number {
  if (value <= 0) return 0.4
  return Math.max(0.4, Math.min(4, Math.log10(value + 1) * 0.35))
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ContagionMapPage() {
  const { data: reviews } = useAllReviews()
  const { data: indexData } = useIndex()

  const [groupByEntity, setGroupByEntity] = useState(true)
  const [minImpact, setMinImpact] = useState(0)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 800, height: 620 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect
        if (width > 0 && height > 0) {
          setSize({ width: Math.floor(width), height: Math.floor(height) })
        }
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fullGraph = useMemo(() => {
    if (!reviews) return { nodes: [], links: [] } as GraphData
    return buildGraph(reviews, groupByEntity)
  }, [reviews, groupByEntity])

  const graph = useMemo(() => {
    if (fullGraph.nodes.length === 0) return fullGraph
    const q = query.trim().toLowerCase()
    const passesEntityFilter = (n: GraphNode) => {
      if (n.kind !== 'entity') return true
      if (n.totalValue < minImpact) return false
      if (q.length > 0) {
        const hay = `${n.label} ${n.address ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }
    const keptEntities = new Set(
      fullGraph.nodes.filter((n) => n.kind === 'entity' && passesEntityFilter(n)).map((n) => n.id),
    )
    const keptLinks = fullGraph.links.filter((l) => {
      const src = typeof l.source === 'string' ? l.source : l.source.id
      return keptEntities.has(src)
    })
    const reachableProtocols = new Set<string>()
    for (const l of keptLinks) {
      const tgt = typeof l.target === 'string' ? l.target : l.target.id
      reachableProtocols.add(tgt)
    }
    const keptNodes = fullGraph.nodes.filter((n) =>
      n.kind === 'entity' ? keptEntities.has(n.id) : reachableProtocols.has(n.id),
    )
    return { nodes: keptNodes, links: keptLinks }
  }, [fullGraph, query, minImpact])

  // Highlight set for hover/selection — ids of nodes/links to emphasize.
  const focusId = hoveredId ?? selectedId
  const highlighted = useMemo(() => {
    if (!focusId) return { nodes: new Set<string>(), links: new Set<string>() }
    const nodeIds = new Set<string>([focusId])
    const linkIds = new Set<string>()
    for (const l of graph.links) {
      const src = typeof l.source === 'string' ? l.source : l.source.id
      const tgt = typeof l.target === 'string' ? l.target : l.target.id
      if (src === focusId || tgt === focusId) {
        nodeIds.add(src)
        nodeIds.add(tgt)
        linkIds.add(`${src}->${tgt}`)
      }
    }
    return { nodes: nodeIds, links: linkIds }
  }, [focusId, graph.links])

  const stats = useMemo(() => {
    const entities = fullGraph.nodes.filter((n) => n.kind === 'entity')
    const totalImpact = entities.reduce((s, n) => s + n.totalValue, 0)
    const sortedByProtocols = [...entities].sort(
      (a, b) => b.protocolCount - a.protocolCount,
    )
    const sortedByImpact = [...entities].sort((a, b) => b.totalValue - a.totalValue)
    const topSPOF = sortedByProtocols[0]
    const topImpact = sortedByImpact[0]
    return {
      entityCount: entities.length,
      protocolCount: fullGraph.nodes.filter((n) => n.kind === 'protocol').length,
      totalImpact,
      topSPOF,
      topImpact,
    }
  }, [fullGraph])

  const selectedNode = useMemo(
    () => (selectedId ? graph.nodes.find((n) => n.id === selectedId) : null),
    [selectedId, graph.nodes],
  )

  const neighbors = useMemo(() => {
    if (!selectedNode) return [] as { node: GraphNode; value: number }[]
    const out: { node: GraphNode; value: number }[] = []
    for (const l of graph.links) {
      const src = typeof l.source === 'string' ? l.source : l.source.id
      const tgt = typeof l.target === 'string' ? l.target : l.target.id
      if (src === selectedNode.id || tgt === selectedNode.id) {
        const otherId = src === selectedNode.id ? tgt : src
        const other = graph.nodes.find((n) => n.id === otherId)
        if (other) out.push({ node: other, value: l.value })
      }
    }
    return out.sort((a, b) => b.value - a.value)
  }, [selectedNode, graph])

  const isLoading = !reviews || !indexData

  return (
    <div className="w-full bg-white">
      <div className="mx-auto w-full max-w-[1536px] px-4 py-10 sm:px-8">
        {/* Header */}
        <div className="mb-6">
          <p className="font-bold text-[11px] text-accent-dark uppercase tracking-[0.55px]">
            Systemic Risk
          </p>
          <h1 className="mt-1 font-extrabold font-sans text-4xl text-text-primary leading-[1.05] tracking-[-0.04em] sm:text-5xl">
            Contagion Map
          </h1>
          <p className="mt-3 max-w-3xl text-base text-text-secondary leading-[1.625]">
            Shared dependencies across reviewed protocols. Each red node is an
            external entity — a multisig, oracle, bridge, or governance contract —
            that one or more protocols rely on. Node size reflects the total
            capital at risk if that entity were compromised.
          </p>
        </div>

        {/* Stats */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Entities"
            value={isLoading ? '—' : stats.entityCount.toLocaleString()}
          />
          <StatCard
            label="Protocols affected"
            value={isLoading ? '—' : stats.protocolCount.toLocaleString()}
          />
          <StatCard
            label="Aggregate capital at risk"
            value={isLoading ? '—' : formatUsdValue(stats.totalImpact)}
          />
          <StatCard
            label="Top single point of failure"
            value={
              isLoading || !stats.topSPOF
                ? '—'
                : `${stats.topSPOF.label} (${stats.topSPOF.protocolCount})`
            }
            hint={
              stats.topSPOF
                ? `Affects ${stats.topSPOF.protocolCount} protocol${stats.topSPOF.protocolCount === 1 ? '' : 's'}`
                : undefined
            }
          />
        </div>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-card px-4 py-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search entity name or address..."
            className="min-w-[220px] flex-1 rounded border border-border bg-white px-3 py-1.5 text-sm placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            Min impact
            <select
              value={minImpact}
              onChange={(e) => setMinImpact(Number(e.target.value))}
              className="rounded border border-border bg-white px-2 py-1 text-sm"
            >
              <option value={0}>Any</option>
              <option value={1e3}>≥ $1K</option>
              <option value={1e6}>≥ $1M</option>
              <option value={1e8}>≥ $100M</option>
              <option value={1e9}>≥ $1B</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={groupByEntity}
              onChange={(e) => {
                setGroupByEntity(e.target.checked)
                setSelectedId(null)
              }}
            />
            Group by entity
          </label>
          <div className="ml-auto flex items-center gap-3 text-xs text-text-muted">
            <LegendSwatch color="#DC2626" label="≥ $1B" />
            <LegendSwatch color="#F97316" label="≥ $100M" />
            <LegendSwatch color="#D97706" label="≥ $1M" />
            <LegendSwatch color="#06B6D4" label="< $1M" />
            <LegendSwatch color="#2563EB" label="Protocol" />
          </div>
        </div>

        {/* Graph + side panel */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div
            ref={containerRef}
            className="relative h-[620px] overflow-hidden rounded-xl border border-border bg-bg-card lg:col-span-9"
          >
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-text-muted">
                Loading graph…
              </div>
            ) : graph.nodes.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">
                No entities match the current filters.
              </div>
            ) : (
              <ForceGraph2D
                graphData={graph as unknown as { nodes: object[]; links: object[] }}
                width={size.width}
                height={size.height}
                backgroundColor="#F8FAFC"
                cooldownTicks={120}
                nodeRelSize={1}
                nodeLabel={(raw: object) => {
                  const n = raw as GraphNode
                  if (n.kind === 'entity') {
                    const addr = n.address
                      ? stripChainPrefix(n.address)
                      : ''
                    return `<div style="font-family:Inter,sans-serif;font-size:12px;">
                      <div style="font-weight:600;">${escapeHtml(n.label)}</div>
                      <div style="color:#64748b;">${formatUsdValue(n.totalValue)} · ${n.protocolCount} protocol${n.protocolCount === 1 ? '' : 's'}</div>
                      ${addr ? `<div style="color:#94a3b8;font-family:'JetBrains Mono',monospace;font-size:11px;">${escapeHtml(addr)}</div>` : ''}
                    </div>`
                  }
                  return `<div style="font-family:Inter,sans-serif;font-size:12px;">
                    <div style="font-weight:600;">${escapeHtml(n.label)}</div>
                    <div style="color:#64748b;">Protocol</div>
                  </div>`
                }}
                linkLabel={(raw: object) => {
                  const l = raw as GraphLink
                  return `<div style="font-family:Inter,sans-serif;font-size:12px;">Capital at risk: <b>${formatUsdValue(l.value)}</b></div>`
                }}
                nodePointerAreaPaint={(
                  raw: object,
                  color: string,
                  ctx: CanvasRenderingContext2D,
                ) => {
                  const node = raw as GraphNode
                  if (node.x === undefined || node.y === undefined) return
                  const radius =
                    node.kind === 'entity' ? entityRadius(node.totalValue) : 5
                  ctx.beginPath()
                  ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI)
                  ctx.fillStyle = color
                  ctx.fill()
                }}
                nodeCanvasObjectMode={() => 'replace'}
                nodeCanvasObject={(raw: object, ctx, globalScale) => {
                  const node = raw as GraphNode
                  if (node.x === undefined || node.y === undefined) return
                  const isEntity = node.kind === 'entity'
                  const dimmed =
                    focusId !== null && !highlighted.nodes.has(node.id)
                  const radius = isEntity
                    ? entityRadius(node.totalValue)
                    : 5
                  const color = isEntity ? entityColor(node.totalValue) : '#2563EB'
                  ctx.globalAlpha = dimmed ? 0.15 : 1
                  ctx.beginPath()
                  ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI)
                  ctx.fillStyle = color
                  ctx.fill()
                  ctx.lineWidth = 1 / globalScale
                  ctx.strokeStyle = 'rgba(15,23,42,0.25)'
                  ctx.stroke()
                  // Label: show for protocols, selected/hovered node, and large entities when zoomed in.
                  const showLabel =
                    !isEntity ||
                    highlighted.nodes.has(node.id) ||
                    (globalScale > 1.4 && node.totalValue >= 1e8) ||
                    globalScale > 2.5
                  if (showLabel) {
                    const fontSize = 11 / globalScale
                    ctx.font = `${fontSize}px Inter, sans-serif`
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'top'
                    ctx.fillStyle = '#0f172a'
                    ctx.fillText(node.label, node.x, node.y + radius + 2 / globalScale)
                  }
                  ctx.globalAlpha = 1
                }}
                linkColor={(raw: object) => {
                  const l = raw as GraphLink
                  const src =
                    typeof l.source === 'string' ? l.source : l.source.id
                  const tgt =
                    typeof l.target === 'string' ? l.target : l.target.id
                  const key = `${src}->${tgt}`
                  if (focusId) {
                    return highlighted.links.has(key)
                      ? 'rgba(37,99,235,0.8)'
                      : 'rgba(148,163,184,0.08)'
                  }
                  return 'rgba(148,163,184,0.35)'
                }}
                linkWidth={(raw: object) => {
                  const l = raw as GraphLink
                  const src =
                    typeof l.source === 'string' ? l.source : l.source.id
                  const tgt =
                    typeof l.target === 'string' ? l.target : l.target.id
                  const key = `${src}->${tgt}`
                  const base = linkWidth(l.value)
                  return highlighted.links.has(key) ? base + 1 : base
                }}
                onNodeClick={(raw: object) => {
                  const n = raw as GraphNode
                  setSelectedId(n.id === selectedId ? null : n.id)
                }}
                onNodeHover={(raw: object | null) => {
                  setHoveredId(raw ? (raw as GraphNode).id : null)
                }}
                onBackgroundClick={() => setSelectedId(null)}
              />
            )}
          </div>

          <aside className="rounded-xl border border-border bg-bg-card p-5 lg:col-span-3">
            {selectedNode ? (
              <SidePanel node={selectedNode} neighbors={neighbors} />
            ) : (
              <EmptyPanel topSPOF={stats.topSPOF} topImpact={stats.topImpact} />
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-card p-4">
      <p className="font-bold text-[10px] text-accent-dark uppercase tracking-[1px]">
        {label}
      </p>
      <p
        className="mt-2 truncate font-bold font-mono text-2xl text-text-primary"
        title={value}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}
    </div>
  )
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  )
}

function SidePanel({
  node,
  neighbors,
}: {
  node: GraphNode
  neighbors: { node: GraphNode; value: number }[]
}) {
  const isEntity = node.kind === 'entity'
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="font-bold text-[10px] text-accent-dark uppercase tracking-[1px]">
          {isEntity ? 'Entity' : 'Protocol'}
        </p>
        <h2 className="mt-1 break-words font-bold font-sans text-xl text-text-primary leading-tight">
          {node.label}
        </h2>
        {isEntity && node.address && (
          <a
            href={etherscanUrl(node.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block break-all font-mono text-xs text-text-muted hover:text-accent"
          >
            {stripChainPrefix(node.address)} ↗
          </a>
        )}
        {!isEntity && node.slug && (
          <Link
            to={`/protocol/${node.slug}`}
            className="mt-1 inline-block text-xs text-accent hover:underline"
          >
            View protocol report →
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MiniStat
          label={isEntity ? 'Capital at risk' : 'Exposed capital'}
          value={formatUsdValue(node.totalValue)}
        />
        <MiniStat
          label={isEntity ? 'Protocols' : 'Dependencies'}
          value={node.protocolCount.toString()}
        />
      </div>

      <div>
        <p className="mb-2 font-bold text-[10px] text-accent-dark uppercase tracking-[1px]">
          {isEntity ? 'Affects' : 'Depends on'}
        </p>
        <ul className="flex max-h-[360px] flex-col gap-1 overflow-y-auto pr-1">
          {neighbors.map(({ node: other, value }) => (
            <li
              key={other.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-white px-2.5 py-1.5 text-sm"
            >
              {other.kind === 'protocol' ? (
                <Link
                  to={`/protocol/${other.slug}`}
                  className="truncate text-text-primary hover:text-accent"
                  title={other.label}
                >
                  {other.label}
                </Link>
              ) : (
                <span className="truncate text-text-primary" title={other.label}>
                  {other.label}
                </span>
              )}
              <span className="shrink-0 font-mono text-text-muted text-xs">
                {formatUsdValue(value)}
              </span>
            </li>
          ))}
          {neighbors.length === 0 && (
            <li className="text-sm text-text-muted">No connections.</li>
          )}
        </ul>
      </div>
    </div>
  )
}

function EmptyPanel({
  topSPOF,
  topImpact,
}: {
  topSPOF?: GraphNode
  topImpact?: GraphNode
}) {
  return (
    <div className="flex h-full flex-col gap-4">
      <p className="font-bold text-[10px] text-accent-dark uppercase tracking-[1px]">
        How to read
      </p>
      <ul className="space-y-2 text-sm text-text-secondary leading-relaxed">
        <li>• Red/orange nodes are entities sized by capital at risk.</li>
        <li>• Blue nodes are protocols that depend on those entities.</li>
        <li>• Edges connect entities to the protocols they can impact. Thicker = higher $ exposure.</li>
        <li>• Hover to highlight neighbours; click for details.</li>
      </ul>
      {(topSPOF || topImpact) && (
        <>
          <div className="h-px bg-border" />
          <p className="font-bold text-[10px] text-accent-dark uppercase tracking-[1px]">
            Notable
          </p>
          <div className="flex flex-col gap-3 text-sm">
            {topSPOF && (
              <div>
                <div className="text-text-muted text-xs">Most shared</div>
                <div className="font-medium text-text-primary">
                  {topSPOF.label}
                </div>
                <div className="text-text-muted text-xs">
                  {topSPOF.protocolCount} protocols ·{' '}
                  {formatUsdValue(topSPOF.totalValue)}
                </div>
              </div>
            )}
            {topImpact && topImpact.id !== topSPOF?.id && (
              <div>
                <div className="text-text-muted text-xs">Largest impact</div>
                <div className="font-medium text-text-primary">
                  {topImpact.label}
                </div>
                <div className="text-text-muted text-xs">
                  {formatUsdValue(topImpact.totalValue)} ·{' '}
                  {topImpact.protocolCount} protocol
                  {topImpact.protocolCount === 1 ? '' : 's'}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-white p-2.5">
      <p className="text-[10px] text-text-muted uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-0.5 font-bold font-mono text-base text-text-primary">
        {value}
      </p>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
