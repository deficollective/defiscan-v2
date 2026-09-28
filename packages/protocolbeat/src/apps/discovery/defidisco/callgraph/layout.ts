// Pure layout algorithm. No React, no DOM. Produces (x, y) for each node and
// the subset of edges that should render at the current depth/collapse state.
//
// Inputs are the full nodeset + edgeset built by buildCallgraph(); this module
// is responsible only for the geometry.

import { type CallEdge, type CallNode, parseNodeId } from './model'

export type LayoutMode = 'tree' | 'lanes' | 'compact'

export interface LayoutOptions {
  startId: string
  nodes: Map<string, CallNode>
  edges: CallEdge[]
  depth: number
  /** How many levels of callers to show ABOVE the start (default 1). Clicking a
   *  caller re-roots there, which is how the trace walks further upstream. */
  upDepth?: number
  /** Contract addresses that should be rendered as a single collapsed contract node. */
  collapsedContracts: Set<string>
  mode: LayoutMode
  /** Edge-kind filters. true = hidden. */
  filters: {
    hideExternal?: boolean
    hideOptimistic?: boolean
    hidePermissioned?: boolean
    hidePermission?: boolean
    hideDependency?: boolean
    hideDelegatecall?: boolean
    hideInternal?: boolean
    hideUnresolved?: boolean
  }
}

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>
  visibleEdges: CallEdge[]
  /** Nodes per BFS level. */
  byLevel: Record<number, string[]>
  /** Effective starting node (after collapse). */
  effectiveStartId: string
  nodeWidth: number
  canvasWidth: number
  canvasHeight: number
  mode: LayoutMode
  /** Only set in 'lanes' mode. */
  lanes?: {
    contracts: string[]
    colX: Record<string, number>
  }
}

const NODE_W = 240
const NODE_W_COMPACT = 184
const LEVEL_GAP = 70
const NODE_GAP = 28
const LANE_ROW_H = 110

/** Heights are constant per kind/mode so edge endpoints don't need DOM measurement. */
export function nodeHeight(
  node: CallNode | undefined,
  mode: LayoutMode,
): number {
  if (!node) return 80
  if (node.kind === 'eoa') return mode === 'compact' ? 56 : 64
  if (!node.functionName) return mode === 'compact' ? 64 : 72
  // Function nodes carry the "other functions on this contract" switcher row.
  if (node.kind === 'external') return mode === 'compact' ? 96 : 112
  return mode === 'compact' ? 104 : 120
}

export function nodeWidth(mode: LayoutMode): number {
  return mode === 'compact' ? NODE_W_COMPACT : NODE_W
}

const EDGE_PRIORITY: Record<string, number> = {
  internal: 0,
  unresolved: 1,
  external: 2,
  optimistic: 3,
  permissioned: 4,
  delegatecall: 5,
  dependency: 6,
  permission: 7,
}

function edgeVisible(e: CallEdge, f: LayoutOptions['filters']): boolean {
  if (f.hideExternal && e.kind === 'external') return false
  if (f.hideOptimistic && e.kind === 'optimistic') return false
  if (f.hidePermissioned && e.kind === 'permissioned') return false
  if (f.hidePermission && e.kind === 'permission') return false
  if (f.hideDependency && e.kind === 'dependency') return false
  if (f.hideDelegatecall && e.kind === 'delegatecall') return false
  if (f.hideInternal && e.kind === 'internal') return false
  if (f.hideUnresolved && e.kind === 'unresolved') return false
  return true
}

export function computeLayout(opts: LayoutOptions): LayoutResult {
  const { startId, nodes, edges, depth, collapsedContracts, mode, filters } =
    opts

  const collapseId = (id: string): string => {
    const { address, functionName } = parseNodeId(id)
    if (functionName && collapsedContracts.has(address)) return address
    return id
  }

  // Build effective edges (after contract-collapse + filters), de-duped with priority.
  const merged = new Map<string, CallEdge>()
  for (const e of edges) {
    if (!edgeVisible(e, filters)) continue
    const from = collapseId(e.from)
    const to = collapseId(e.to)
    if (from === to) continue
    const key = `${from}→${to}`
    const existing = merged.get(key)
    if (
      !existing ||
      (EDGE_PRIORITY[e.kind] ?? 0) > (EDGE_PRIORITY[existing.kind] ?? 0)
    ) {
      merged.set(key, { ...e, from, to })
    }
  }
  const effectiveEdges = Array.from(merged.values())

  // BFS from start.
  const effectiveStartId = collapseId(startId)
  const levels = new Map<string, number>([[effectiveStartId, 0]])
  const visited = new Set<string>([effectiveStartId])
  const visibleKeys = new Set<string>()
  const queue: [string, number][] = [[effectiveStartId, 0]]
  while (queue.length > 0) {
    const head = queue.shift()
    if (!head) break
    const [id, lvl] = head
    if (lvl >= depth) continue
    for (const e of effectiveEdges) {
      if (e.from !== id) continue
      visibleKeys.add(`${e.from}→${e.to}`)
      if (!visited.has(e.to)) {
        visited.add(e.to)
        levels.set(e.to, lvl + 1)
        queue.push([e.to, lvl + 1])
      }
    }
  }

  // Upstream pass: show callers ABOVE the start at negative levels. Default one
  // level (Option A); clicking a caller re-roots the trace there to walk higher.
  const upDepth = opts.upDepth ?? 1
  const upQueue: [string, number][] = [[effectiveStartId, 0]]
  while (upQueue.length > 0) {
    const head = upQueue.shift()
    if (!head) break
    const [id, lvl] = head
    if (lvl >= upDepth) continue
    for (const e of effectiveEdges) {
      if (e.to !== id) continue
      visibleKeys.add(`${e.from}→${e.to}`)
      if (!visited.has(e.from)) {
        visited.add(e.from)
        levels.set(e.from, -(lvl + 1))
        upQueue.push([e.from, lvl + 1])
      }
    }
  }

  const visibleEdges = effectiveEdges.filter((e) =>
    visibleKeys.has(`${e.from}→${e.to}`),
  )

  // Group by level + stable sort (project first, externals last).
  const byLevel: Record<number, string[]> = {}
  for (const [id, lvl] of levels) {
    byLevel[lvl] ??= []
    byLevel[lvl].push(id)
  }
  const sortOrder = { project: 0, external: 1, eoa: 2, unknown: 3 }
  for (const lvl of Object.keys(byLevel)) {
    byLevel[+lvl].sort((a, b) => {
      const na = nodes.get(parseNodeId(a).address)
      const nb = nodes.get(parseNodeId(b).address)
      const ka = sortOrder[na?.kind ?? 'unknown']
      const kb = sortOrder[nb?.kind ?? 'unknown']
      if (ka !== kb) return ka - kb
      return a.localeCompare(b)
    })
  }

  const NW = nodeWidth(mode)
  const positions: Record<string, { x: number; y: number }> = {}

  if (mode === 'lanes') {
    const contracts = Array.from(
      new Set(Array.from(visited).map((id) => parseNodeId(id).address)),
    )
    const startContract = parseNodeId(effectiveStartId).address
    contracts.sort((a, b) => {
      if (a === startContract) return -1
      if (b === startContract) return 1
      const na = nodes.get(a)
      const nb = nodes.get(b)
      const ka = sortOrder[na?.kind ?? 'unknown']
      const kb = sortOrder[nb?.kind ?? 'unknown']
      if (ka !== kb) return ka - kb
      return a.localeCompare(b)
    })
    const colX: Record<string, number> = {}
    contracts.forEach((c, i) => {
      colX[c] = i * (NW + NODE_GAP * 2)
    })
    const buckets: Record<string, string[]> = {}
    for (const id of visited) {
      const lvl = levels.get(id) ?? 0
      const ctr = parseNodeId(id).address
      const key = `${ctr}|${lvl}`
      buckets[key] ??= []
      buckets[key].push(id)
    }
    // Levels can be negative (callers above start); offset so the top row is 0.
    const laneLevels = Array.from(levels.values())
    const minLvl = Math.min(0, ...laneLevels)
    const maxLvl = Math.max(0, ...laneLevels)
    for (const key of Object.keys(buckets)) {
      const [ctr, lvlStr] = key.split('|')
      const lvl = +lvlStr
      buckets[key].forEach((id, i) => {
        positions[id] = {
          x: colX[ctr],
          y: (lvl - minLvl) * LANE_ROW_H + i * 95,
        }
      })
    }
    return {
      positions,
      visibleEdges,
      byLevel,
      effectiveStartId,
      nodeWidth: NW,
      canvasWidth: contracts.length * (NW + NODE_GAP * 2),
      canvasHeight: (maxLvl - minLvl) * LANE_ROW_H + 200,
      mode,
      lanes: { contracts, colX },
    }
  }

  // Tree / compact — rows centered horizontally. Levels can be negative (callers
  // shown above the start), so iterate the full minLvl..maxLvl range.
  const rowCounts = Object.values(byLevel).map((arr) => arr.length)
  const maxRow = Math.max(1, ...rowCounts)
  const rowMaxW = maxRow * NW + (maxRow - 1) * NODE_GAP
  let y = 0
  const levelNums = Object.keys(byLevel).map(Number)
  const minLvl = Math.min(0, ...levelNums)
  const maxLvl = Math.max(0, ...levelNums)
  for (let lvl = minLvl; lvl <= maxLvl; lvl++) {
    const ids = byLevel[lvl] ?? []
    const rowW = ids.length * NW + (ids.length - 1) * NODE_GAP
    const startX = (rowMaxW - rowW) / 2
    const heights = ids.map((id) => {
      const n = nodes.get(parseNodeId(id).address)
      return nodeHeight(n, mode)
    })
    const maxH = Math.max(60, ...heights)
    ids.forEach((id, i) => {
      positions[id] = { x: startX + i * (NW + NODE_GAP), y }
    })
    y += maxH + LEVEL_GAP
  }
  return {
    positions,
    visibleEdges,
    byLevel,
    effectiveStartId,
    nodeWidth: NW,
    canvasWidth: rowMaxW,
    canvasHeight: y + 40,
    mode,
  }
}

/** BFS from start to a target, returning the chain (or null if unreachable). */
export function findPathToNode(
  targetId: string,
  startId: string,
  edges: CallEdge[],
): string[] | null {
  if (targetId === startId) return [startId]
  const visited = new Set<string>([startId])
  const queue: string[][] = [[startId]]
  while (queue.length > 0) {
    const path = queue.shift()
    if (!path) break
    const last = path[path.length - 1]
    for (const e of edges) {
      if (e.from !== last) continue
      if (visited.has(e.to)) continue
      const next = [...path, e.to]
      if (e.to === targetId) return next
      visited.add(e.to)
      queue.push(next)
    }
  }
  return null
}
