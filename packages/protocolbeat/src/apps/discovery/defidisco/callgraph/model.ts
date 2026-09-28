// Pure types + helpers for the callgraph view.
// No React, no fetch — safe to import from anywhere.

import type {
  ApiCallGraphResponse,
  ApiAddressType,
  ContractCallGraph,
  ExternalCall,
  ImpactCap,
  Mitigation,
} from '../../../../api/types'

/** Edge kinds rendered with distinct colors / dash patterns. */
export type EdgeKind =
  | 'internal' // user-added edges, and the implicit function→owner-hub membership link
  | 'external' // ExternalCall with resolutionType === 'deterministic'
  | 'optimistic' // ExternalCall with resolutionType === 'optimistic'
  | 'permissioned' // call-graph edge whose CALLER function is flagged isPermissioned
  | 'permission' // ownership edge: owner contract has write access to a target fn
  | 'dependency' // researcher-declared dependency in functions.json
  | 'delegatecall' // not currently emitted; reserved for future analysis
  | 'unresolved' // ExternalCall without resolvedAddress

/**
 * Backend EnhancedEdge type. The override identity is `${from}|${to}|${edgeType}`
 * (see `enhancedEdgeKey` in enhancedTraversal.ts), so an edge deleted in the UI
 * maps 1:1 to a suppressible backend edge. UI-only edges (unresolved placeholders,
 * user-drawn edges, the membership link) leave `edgeType` undefined.
 */
export type BackendEdgeType = 'callgraph' | 'permission' | 'dependency'

/** Visibility used for filtering and styling. */
export type FunctionVisibility = 'external' | 'public' | 'internal' | 'private'

/** A node in the callgraph. id is either `${address}` (contract) or `${address}.${functionName}`. */
export interface CallNode {
  id: string
  contractAddress: string // chain-qualified, e.g. "eth:0x..."
  contractName: string
  contractType: ApiAddressType
  /** Discovery kind, derived from contract tags. */
  kind: 'project' | 'external' | 'eoa' | 'unknown'
  /** Function name, undefined when this is a contract-level node. */
  functionName?: string
  /** True for view/pure functions. */
  isView?: boolean
  /** True for permissioned functions (from functions.json). */
  isPermissioned?: boolean
  /** True for nodes seeded from the contract ABI that aren't (yet) in any edge —
   *  shown as selectable siblings inside a node, but kept out of the StartPicker. */
  seeded?: boolean
}

/** An edge between two `CallNode.id`s. */
export interface CallEdge {
  /**
   * For backend-backed edges this IS the override key (`${from}|${to}|${edgeType}`),
   * so the overrides store records a removal the backend can apply verbatim.
   * UI-only edges (unresolved/user/membership) use a UI-unique id.
   */
  id: string
  from: string
  to: string
  kind: EdgeKind
  /** Backend edge type, set only for edges that exist in the enhanced graph. */
  edgeType?: BackendEdgeType
  /** Traversal scope (set by a scope override rule; default 'both'). 'backward'
   *  = governance-only (no forward capital flare); 'forward' = capital-only. */
  scope?: 'forward' | 'backward' | 'both'
  /** Edge-centric impact cap (set by a setEdgeCap/setOutgoingCap/setIncomingCap
   *  rule). Bounds the forward capital this edge propagates. Relationship-level,
   *  distinct from a function-intrinsic cap on a mitigation. */
  cap?: ImpactCap
  /** Edge-centric mitigations (set by a setEdgeMitigation rule) — relationship-
   *  level constraints, distinct from a function's own mitigations. */
  mitigations?: Mitigation[]
  /** True when this edge was added by the user (vs derived from the API). */
  user?: boolean
  /** Optional human label override. Defaults to the target function name. */
  label?: string
  /** True for state-changing calls that move value (best-effort). */
  carriesValue?: boolean
  /** Free-form note (e.g. resolution heuristic). */
  meta?: string
}

/** Stable semantic identity for a backend-backed edge. Mirrors `enhancedEdgeKey`. */
export function edgeKey(
  from: string,
  to: string,
  edgeType: BackendEdgeType,
): string {
  return `${from}|${to}|${edgeType}`
}

// ─────────────────── id helpers ───────────────────

export function nodeId(address: string, functionName?: string): string {
  return functionName ? `${address}.${functionName}` : address
}

export function parseNodeId(id: string): {
  address: string
  functionName?: string
} {
  // address can contain "eth:0x..." — split on the LAST "." so the chain prefix survives.
  const lastDot = id.lastIndexOf('.')
  if (lastDot === -1) return { address: id }
  const maybeFn = id.slice(lastDot + 1)
  const maybeAddr = id.slice(0, lastDot)
  // If the part after "." looks like an address suffix (hex), treat the whole thing as an address.
  if (/^[0-9a-fA-F]+$/.test(maybeFn) && maybeFn.length > 8) {
    return { address: id }
  }
  return { address: maybeAddr, functionName: maybeFn }
}

export function nodeContract(node: CallNode): string {
  return node.contractAddress
}

export function shortAddr(address: string): string {
  // "eth:0xabcd…1234" → "0xabcd…1234"; "0xabcd1234..." → "0xabcd…1234"
  const raw = address.includes(':') ? address.split(':')[1] : address
  if (!raw || raw.length < 12) return raw ?? address
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`
}
