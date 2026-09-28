// Adapter: ApiCallGraphResponse + ApiProjectResponse (+ enhanced edges, + functions)
//          ────────────────────────────────────────────────────────────────────────►
//          { nodes: Map<id, CallNode>, edges: CallEdge[] } for the callgraph view.
//
// This is the only place that knows the API shape. Everything downstream operates
// on the normalized {CallNode, CallEdge} model in ./model.ts.
//
// Edge sources:
//   - call-graph edges  → from ApiCallGraphResponse (rich: optimistic / unresolved /
//     view metadata). edgeType 'callgraph', id == backend enhancedEdgeKey.
//   - permission + dependency edges → from the enhanced-graph-edges endpoint, which
//     is the exact edge set capital/governance traversal consumes. Their id IS the
//     backend key, so a UI removal maps 1:1 to a suppressible backend edge.
//   - membership edges  → implicit faint links from each function node to its
//     owner-hub contract node, but only for contracts that own ≥1 permission/
//     dependency edge. This wires a function-rooted trace through to the contract's
//     ownership powers — i.e. it makes the permission over-flare visible/traceable.

import type {
  ApiCallGraphResponse,
  ApiFunctionsResponse,
  ApiProjectResponse,
  EdgeOverrideRule,
  EnhancedGraphEdge,
} from '../../../../api/types'
import {
  type CallEdge,
  type CallNode,
  type EdgeKind,
  edgeKey,
  nodeId,
} from './model'
import { applyRulesToCallEdges } from './rules'

interface BuildArgs {
  callGraph: ApiCallGraphResponse
  project: ApiProjectResponse
  /** Permission + dependency (and callgraph) edges from the backend enhanced graph. */
  enhancedEdges?: EnhancedGraphEdge[]
  /** Optional. When provided we mark caller functions as `permissioned`. */
  functions?: ApiFunctionsResponse
  /** Researcher-authored override rules (server-persisted). Applied last. */
  rules?: EdgeOverrideRule[]
}

interface BuildResult {
  nodes: Map<string, CallNode>
  /** Post-override edges — what the canvas renders. */
  edges: CallEdge[]
  /** Pre-override edges — so the sidebar can show suppressed edges (struck-through). */
  rawEdges: CallEdge[]
  /** Entrypoint functions, useful for the StartPicker. */
  entrypoints: { id: string; node: CallNode }[]
}

export function buildCallgraph(args: BuildArgs): BuildResult {
  const { callGraph, project, enhancedEdges = [], functions, rules = [] } = args

  // ── 1. Build the node map from the discovery payload ─────────────────────
  const nodes = new Map<string, CallNode>()

  for (const chain of project.entries) {
    const allContracts = [
      ...chain.initialContracts,
      ...chain.discoveredContracts,
    ]
    for (const c of allContracts) {
      nodes.set(c.address, {
        id: c.address,
        contractAddress: c.address,
        contractName: c.name ?? shortLabel(c.address),
        contractType: c.type,
        kind:
          c.type === 'EOA' || c.type === 'EOAPermissioned'
            ? 'eoa'
            : chain.initialContracts.includes(c)
              ? 'project'
              : 'external',
      })
    }
    for (const eoa of chain.eoas) {
      nodes.set(eoa.address, {
        id: eoa.address,
        contractAddress: eoa.address,
        contractName: eoa.name ?? shortLabel(eoa.address),
        contractType: eoa.type,
        kind: 'eoa',
      })
    }
  }

  // Pull function metadata (visibility, permissioned) from functions.json if present.
  const permissionedSet = new Set<string>()
  if (functions) {
    for (const [addr, c] of Object.entries(functions.contracts)) {
      for (const fn of c.functions) {
        if (fn.isPermissioned)
          permissionedSet.add(nodeId(addr, fn.functionName))
      }
    }
  }

  // ── 2. Walk every ExternalCall and emit call-graph edges + function nodes ─
  const edges: CallEdge[] = []

  for (const c of Object.values(callGraph.contracts)) {
    if (!nodes.has(c.address)) {
      nodes.set(c.address, {
        id: c.address,
        contractAddress: c.address,
        contractName: c.name ?? shortLabel(c.address),
        contractType: 'Contract',
        kind: 'project',
      })
    }
    if (c.skipped || c.error) continue

    for (const call of c.externalCalls) {
      const callerNodeId = ensureFunctionNode(
        nodes,
        c.address,
        call.callerFunction,
        {
          isView: call.callerIsView,
          isPermissioned: permissionedSet.has(
            nodeId(c.address, call.callerFunction),
          ),
        },
      )

      // Unresolved: synthesise a placeholder destination. UI-only — there is no
      // backend edge to override, so edgeType stays undefined.
      if (!call.resolvedAddress) {
        const placeholderAddr = `unresolved:${call.interfaceType}:${call.storageVariable}`
        if (!nodes.has(placeholderAddr)) {
          nodes.set(placeholderAddr, {
            id: placeholderAddr,
            contractAddress: placeholderAddr,
            contractName: call.interfaceType,
            contractType: 'Unknown',
            kind: 'unknown',
          })
        }
        const calleeNodeId = ensureFunctionNode(
          nodes,
          placeholderAddr,
          call.calledFunction,
          { isView: call.isViewCall },
        )
        edges.push({
          id: `unresolved:${callerNodeId}->${calleeNodeId}`,
          from: callerNodeId,
          to: calleeNodeId,
          kind: 'unresolved',
          meta: call.storageVariable,
        })
        continue
      }

      if (!nodes.has(call.resolvedAddress)) {
        nodes.set(call.resolvedAddress, {
          id: call.resolvedAddress,
          contractAddress: call.resolvedAddress,
          contractName: call.resolvedContractName ?? call.interfaceType,
          contractType: 'Contract',
          kind: 'external',
        })
      }
      const calleeNodeId = ensureFunctionNode(
        nodes,
        call.resolvedAddress,
        call.calledFunction,
        { isView: call.isViewCall },
      )

      const kind: EdgeKind = permissionedSet.has(callerNodeId)
        ? 'permissioned'
        : call.resolutionType === 'optimistic'
          ? 'optimistic'
          : 'external'

      edges.push({
        // Same identity the backend gives this call-graph edge.
        id: edgeKey(callerNodeId, calleeNodeId, 'callgraph'),
        from: callerNodeId,
        to: calleeNodeId,
        kind,
        edgeType: 'callgraph',
        carriesValue: call.isViewCall === false,
        meta: call.resolutionHeuristic,
      })
    }
  }

  // ── 3. Layer in permission + dependency edges from the enhanced graph ─────
  // Track which contracts own ≥1 such edge so we can wire membership links.
  const ownerHubs = new Set<string>()

  for (const e of enhancedEdges) {
    if (e.edgeType === 'callgraph') continue // already covered (richer) in step 2
    const fromId = e.sourceFunction
      ? ensureFunctionNode(nodes, e.sourceContract, e.sourceFunction)
      : ensureContractNode(nodes, e.sourceContract, e.sourceName)
    const toId = ensureFunctionNode(nodes, e.targetContract, e.targetFunction, {
      isPermissioned: e.edgeType === 'permission' ? true : undefined,
    })
    // Owner is the source contract (permission edges are contract-level).
    ownerHubs.add(e.sourceContract)
    edges.push({
      id: e.key, // backend key verbatim
      from: fromId,
      to: toId,
      kind: e.edgeType === 'permission' ? 'permission' : 'dependency',
      edgeType: e.edgeType,
      carriesValue: e.isViewCall === false,
    })
  }

  // ── 4. Membership links: function node → its owner-hub contract node ──────
  // Only for contracts that own permission/dependency edges, so a function-rooted
  // trace can flow into the contract's ownership powers (mirrors the backend's
  // contract-level permission firing — this is where the over-flare shows up).
  for (const node of [...nodes.values()]) {
    if (!node.functionName) continue
    if (!ownerHubs.has(node.contractAddress)) continue
    edges.push({
      id: `member:${node.id}`,
      from: node.id,
      to: node.contractAddress,
      kind: 'internal',
    })
  }

  // ── 5. Seed the rest of each contract's WRITE functions from its ABI, so a
  //      node can offer "other write functions on this contract" to jump to,
  //      even ones with no edges. Marked `seeded` and kept out of the
  //      StartPicker (which stays scoped to graph-connected functions).
  for (const chain of project.entries) {
    const allContracts = [
      ...chain.initialContracts,
      ...chain.discoveredContracts,
    ]
    for (const c of allContracts) {
      for (const abi of c.abis ?? []) {
        for (const entry of abi.entries) {
          if (entry.topic) continue // event
          const fn = parseAbiFunction(entry.value)
          if (!fn || fn.isView) continue
          if (nodes.has(nodeId(c.address, fn.name))) continue
          ensureFunctionNode(nodes, c.address, fn.name, {
            isView: false,
            seeded: true,
          })
        }
      }
    }
  }

  // ── 6. Apply researcher override rules (same rules the backend applies) ───
  const finalEdges = applyRulesToCallEdges(edges, rules)

  // ── 7. Build entrypoints list — graph-connected function nodes only (a
  //      function is "connected" if it touches a real, non-membership edge).
  const connectedIds = new Set<string>()
  for (const e of edges) {
    if (e.kind === 'internal') continue // membership link — not real connectivity
    connectedIds.add(e.from)
    connectedIds.add(e.to)
  }
  const entrypoints: BuildResult['entrypoints'] = []
  for (const n of nodes.values()) {
    if (!n.functionName) continue
    if (n.kind === 'eoa') continue
    if (!connectedIds.has(n.id)) continue
    entrypoints.push({ id: n.id, node: n })
  }
  entrypoints.sort((a, b) => {
    if (a.node.kind !== b.node.kind) return a.node.kind === 'project' ? -1 : 1
    return a.id.localeCompare(b.id)
  })

  return { nodes, edges: finalEdges, rawEdges: edges, entrypoints }
}

function ensureContractNode(
  nodes: Map<string, CallNode>,
  address: string,
  name?: string,
): string {
  if (!nodes.has(address)) {
    nodes.set(address, {
      id: address,
      contractAddress: address,
      contractName: name ?? shortLabel(address),
      contractType: 'Contract',
      kind: 'external',
    })
  }
  return address
}

function ensureFunctionNode(
  nodes: Map<string, CallNode>,
  address: string,
  functionName: string,
  extra: { isView?: boolean; isPermissioned?: boolean; seeded?: boolean } = {},
): string {
  const id = nodeId(address, functionName)
  if (nodes.has(id)) {
    const existing = nodes.get(id)!
    if (extra.isView !== undefined)
      existing.isView = existing.isView ?? extra.isView
    if (extra.isPermissioned) existing.isPermissioned = true
    return id
  }
  let parent = nodes.get(address)
  if (!parent) {
    parent = {
      id: address,
      contractAddress: address,
      contractName: shortLabel(address),
      contractType: 'Contract',
      kind: 'external',
    }
    nodes.set(address, parent)
  }
  nodes.set(id, {
    id,
    contractAddress: address,
    contractName: parent.contractName,
    contractType: parent.contractType,
    kind: parent.kind,
    functionName,
    isView: extra.isView,
    isPermissioned: extra.isPermissioned,
    seeded: extra.seeded,
  })
  return id
}

function shortLabel(addr: string): string {
  const raw = addr.includes(':') ? addr.split(':')[1] : addr
  return raw && raw.length >= 8 ? `${raw.slice(0, 6)}…${raw.slice(-4)}` : addr
}

/**
 * Parse a human-readable ABI signature into a function name + whether it's
 * read-only. Returns null for non-functions (events, errors, constructor, …).
 */
function parseAbiFunction(
  value: string,
): { name: string; isView: boolean } | null {
  const v = value.trim()
  if (
    /^(event|error|constructor|fallback|receive|struct|enum|modifier)\b/.test(v)
  ) {
    return null
  }
  const m = v.match(/^(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(/)
  if (!m?.[1]) return null
  return { name: m[1], isView: /\b(view|pure|constant)\b/.test(v) }
}
