// Main canvas: starting-function picker → tree of fan-out edges & nodes.
//
// State ownership:
//   - startId / depth / selected / hoveredEdge / drag             → useState (local)
//   - layoutMode / filters                                         → useState (local)
//   - userEdges / removedEdgeIds / collapsedContracts / notes      → zustand (persisted per project)
//
// Cross-panel wiring: clicking a node fires usePanelStore.select(address) so the
// Code / Values / Config panels follow along; double-click + the "open in code"
// action also flip the Code panel active and call useCodeStore.showRange via
// findAllFunctionOccurrences (same helper already used by the legacy list view).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getCallGraphData,
  getCallGraphOverrides,
  getCallGraphSuggestions,
  getCode,
  getEnhancedGraphEdges,
  getFunctions,
  getProject,
  resolveCallGraphSuggestion,
  updateCallGraphOverrides,
} from '../../../../../api/api'
import type {
  ApiCallGraphOverridesResponse,
  EdgeOverrideRule,
  EdgeScope,
  ImpactCap,
  Mitigation,
  RuleSuggestion,
} from '../../../../../api/types'
import { useCodeStore } from '../../../../../components/editor/store'
import { useMultiViewStore } from '../../../multi-view/store'
import { usePanelStore } from '../../../store/panel-store'

import { addressesEqual } from '../../addressUtils'
import { useFunctionNavigationStore } from '../../functionNavigationStore'
import { buildCallgraph } from '../buildCallgraph'
import {
  computeLayout,
  findPathToNode,
  type LayoutMode,
  nodeHeight,
} from '../layout'
import {
  type BackendEdgeType,
  type CallEdge,
  type CallNode,
  edgeKey,
  parseNodeId,
} from '../model'
import { useCallgraphOverridesStore } from '../overridesStore'
import { makeRuleId, ruleFocusNode } from '../rules'

import { ArrowDefs, EdgePath } from './EdgePath'
import { Controls } from './Controls'
import { DetailSidebar } from './DetailSidebar'
import { Node } from './Node'
import { StartPicker } from './StartPicker'

// ── source-location helper: copied verbatim from the legacy CallGraphPanel ─
// (extract into a shared util in a follow-up if you keep both views around)
function findAllFunctionOccurrences(
  sources: Array<{ name: string; code: string }>,
  functionName: string,
): Array<{ startOffset: number; length: number; sourceIndex: number }> {
  const occurrences: Array<{
    startOffset: number
    length: number
    sourceIndex: number
  }> = []
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    if (!src) continue
    const patterns = [
      new RegExp(`function\\s+${functionName}\\s*\\(`, 'gi'),
      new RegExp(
        `\\b${functionName}\\s*\\(.*?\\)\\s*(?:public|external|internal|private)?(?:\\s+\\w+)*\\s*(?:returns\\s*\\([^)]*\\))?\\s*\\{`,
        'gi',
      ),
    ]
    for (const re of patterns) {
      let m: RegExpExecArray | null
      while ((m = re.exec(src.code)) !== null) {
        const rest = src.code.slice(m.index)
        const end = rest.match(/[\{;]/)
        const length = end ? end.index! + 1 : functionName.length + 10
        occurrences.push({ startOffset: m.index, length, sourceIndex: i })
      }
    }
  }
  return occurrences
}

// Stable fallbacks for selectors/queries — see the NOTE below on React #185.
const EMPTY_STRINGS: string[] = []
const EMPTY_RULES: EdgeOverrideRule[] = []
const EMPTY_SUGGESTIONS: RuleSuggestion[] = []

// Canvas padding (also the offset between layout coords and the scroll container).
const PAD_X = 40
const PAD_Y = 36

export function CallGraphView(): JSX.Element {
  const { project } = useParams()
  if (!project) throw new Error('CallGraphView requires a project route param')

  const callGraphQ = useQuery({
    queryKey: ['call-graph', project],
    queryFn: () => getCallGraphData(project),
  })
  const projectQ = useQuery({
    queryKey: ['projects', project],
    queryFn: () => getProject(project),
  })
  // Permission + dependency edges from the backend enhanced graph (the same
  // edge set capital/governance traversal consumes). Optional — the view still
  // renders call-graph edges if this fails.
  const enhancedEdgesQ = useQuery({
    queryKey: ['enhanced-graph-edges', project],
    queryFn: () => getEnhancedGraphEdges(project),
  })
  // functions.json — used to flag permissioned caller functions for node coloring.
  const functionsQ = useQuery({
    queryKey: ['functions', project],
    queryFn: () => getFunctions(project),
  })

  // Server-persisted override rules (call-graph-overrides.json).
  const overridesQ = useQuery({
    queryKey: ['call-graph-overrides', project],
    queryFn: () => getCallGraphOverrides(project),
  })
  const rules = useMemo(
    () => overridesQ.data?.rules ?? EMPTY_RULES,
    [overridesQ.data],
  )
  const queryClient = useQueryClient()
  const overridesKey = ['call-graph-overrides', project]
  const saveRules = useMutation({
    mutationFn: (next: EdgeOverrideRule[]) =>
      updateCallGraphOverrides(project, next),
    // Optimistic: reflect the change instantly (graph reflows, rows toggle)
    // and roll back if the write fails.
    onMutate: async (next: EdgeOverrideRule[]) => {
      await queryClient.cancelQueries({ queryKey: overridesKey })
      const prev =
        queryClient.getQueryData<ApiCallGraphOverridesResponse>(overridesKey)
      queryClient.setQueryData<ApiCallGraphOverridesResponse>(overridesKey, {
        version: prev?.version ?? '1.0',
        lastModified: new Date().toISOString(),
        rules: next,
      })
      return { prev }
    },
    onError: (_e, _next, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(overridesKey, ctx.prev)
    },
    onSettled: () => {
      // The (raw) enhanced edges' unmatched flags also depend on the rules.
      queryClient.invalidateQueries({ queryKey: overridesKey })
      queryClient.invalidateQueries({
        queryKey: ['enhanced-graph-edges', project],
      })
    },
  })
  const addRule = useCallback(
    (rule: EdgeOverrideRule) => saveRules.mutate([...rules, rule]),
    [rules, saveRules],
  )
  const removeRule = useCallback(
    (id: string) => saveRules.mutate(rules.filter((r) => r.id !== id)),
    [rules, saveRules],
  )

  // Agent-proposed suggestions (separate file; never affects analysis until accepted).
  const suggestionsQ = useQuery({
    queryKey: ['call-graph-suggestions', project],
    queryFn: () => getCallGraphSuggestions(project),
  })
  const suggestions = suggestionsQ.data?.suggestions ?? EMPTY_SUGGESTIONS
  const resolveSuggestion = useMutation({
    mutationFn: (v: { id: string; action: 'accept' | 'reject' }) =>
      resolveCallGraphSuggestion(project, v.id, v.action),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['call-graph-suggestions', project],
      })
      // Accept promotes a rule into the overrides → refetch the dependent data.
      queryClient.invalidateQueries({ queryKey: overridesKey })
      queryClient.invalidateQueries({
        queryKey: ['enhanced-graph-edges', project],
      })
    },
  })

  // NOTE: select the raw per-project value WITHOUT a `?? []` fallback. Returning
  // a fresh `[]` literal from a zustand selector makes useSyncExternalStore see a
  // new snapshot every render → infinite re-render loop (React #185). Fall back to
  // a single stable EMPTY constant instead, then memoize.
  const collapsedRaw = useCallgraphOverridesStore(
    (s) => s.collapsedContracts[project],
  )
  const collapsedList = collapsedRaw ?? EMPTY_STRINGS
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList])
  const toggleCollapsed = useCallgraphOverridesStore((s) => s.toggleCollapsed)
  const resetView = useCallgraphOverridesStore((s) => s.resetProject)

  // Removing an edge in the UI: if it was a user-added edge, drop that addEdge
  // rule; otherwise persist a removeEdge rule the backend will also apply.
  const removeEdgeAsRule = useCallback(
    (edge: CallEdge) => {
      if (!edge.edgeType) return // UI-only edge (unresolved / membership) — nothing to persist
      const existingAdd = rules.find(
        (r) =>
          r.type === 'addEdge' &&
          r.from === edge.from &&
          r.to === edge.to &&
          r.edgeType === edge.edgeType,
      )
      if (existingAdd) {
        removeRule(existingAdd.id)
        return
      }
      addRule({
        id: makeRuleId(),
        type: 'removeEdge',
        from: edge.from,
        to: edge.to,
        edgeType: edge.edgeType,
      })
    },
    [rules, addRule, removeRule],
  )

  // Set the scope of a single edge (replace any existing single-edge scope rule;
  // 'both' = default → just delete the rule).
  const setEdgeScope = useCallback(
    (edge: CallEdge, scope: EdgeScope) => {
      if (!edge.edgeType) return
      const existing = rules.find(
        (r) =>
          r.type === 'setEdgeScope' &&
          r.from === edge.from &&
          r.to === edge.to &&
          r.edgeType === edge.edgeType,
      )
      const without = existing
        ? rules.filter((r) => r.id !== existing.id)
        : rules
      const next: EdgeOverrideRule[] =
        scope === 'both'
          ? without
          : [
              ...without,
              {
                id: makeRuleId(),
                type: 'setEdgeScope',
                from: edge.from,
                to: edge.to,
                edgeType: edge.edgeType,
                scope,
              },
            ]
      saveRules.mutate(next)
    },
    [rules, saveRules],
  )

  // Edge-centric cap: upsert (or clear) a setEdgeCap rule for one exact edge.
  // Bounds the forward capital this edge propagates without removing it.
  const setEdgeCap = useCallback(
    (edge: CallEdge, cap: ImpactCap | undefined) => {
      if (!edge.edgeType) return
      const existing = rules.find(
        (r) =>
          r.type === 'setEdgeCap' &&
          r.from === edge.from &&
          r.to === edge.to &&
          r.edgeType === edge.edgeType,
      )
      const without = existing
        ? rules.filter((r) => r.id !== existing.id)
        : rules
      const next: EdgeOverrideRule[] =
        cap === undefined
          ? without
          : [
              ...without,
              {
                id: makeRuleId(),
                type: 'setEdgeCap',
                from: edge.from,
                to: edge.to,
                edgeType: edge.edgeType,
                cap,
              },
            ]
      saveRules.mutate(next)
    },
    [rules, saveRules],
  )

  // Edge-centric mitigations: replace the edge's mitigation set. Removes any
  // existing setEdgeMitigation rules for the exact edge, then (if non-empty)
  // adds one rule carrying the full list. The sidebar manages add/remove of
  // individual mitigations and calls this with the resulting list.
  const setEdgeMitigations = useCallback(
    (edge: CallEdge, mitigations: Mitigation[]) => {
      if (!edge.edgeType) return
      const without = rules.filter(
        (r) =>
          !(
            r.type === 'setEdgeMitigation' &&
            r.from === edge.from &&
            r.to === edge.to &&
            r.edgeType === edge.edgeType
          ),
      )
      const next: EdgeOverrideRule[] =
        mitigations.length === 0
          ? without
          : [
              ...without,
              {
                id: makeRuleId(),
                type: 'setEdgeMitigation',
                from: edge.from,
                to: edge.to,
                edgeType: edge.edgeType,
                mitigations,
              },
            ]
      saveRules.mutate(next)
    },
    [rules, saveRules],
  )

  // Bulk scope: all outgoing/incoming edges of a node (optionally one type).
  // The over-flare one-click is setOutgoingScope(contract, 'permission', 'backward').
  const setOutgoingScope = useCallback(
    (nodeRef: string, scope: EdgeScope, edgeType?: BackendEdgeType) => {
      addRule({
        id: makeRuleId(),
        type: 'setOutgoingScope',
        node: nodeRef,
        edgeType,
        scope,
      })
    },
    [addRule],
  )
  const setIncomingScope = useCallback(
    (nodeRef: string, scope: EdgeScope, edgeType?: BackendEdgeType) => {
      addRule({
        id: makeRuleId(),
        type: 'setIncomingScope',
        node: nodeRef,
        edgeType,
        scope,
      })
    },
    [addRule],
  )

  // Add a manual edge (the source is the selected node).
  const addEdgeRule = useCallback(
    (from: string, to: string, edgeType: BackendEdgeType) => {
      addRule({ id: makeRuleId(), type: 'addEdge', from, to, edgeType })
    },
    [addRule],
  )

  const { nodes, edges, rawEdges, entrypoints } = useMemo(() => {
    if (!callGraphQ.data || !projectQ.data) {
      return {
        nodes: new Map(),
        edges: [] as CallEdge[],
        rawEdges: [] as CallEdge[],
        entrypoints: [],
      }
    }
    return buildCallgraph({
      callGraph: callGraphQ.data,
      project: projectQ.data,
      enhancedEdges: enhancedEdgesQ.data?.edges,
      functions: functionsQ.data,
      rules,
    })
  }, [
    callGraphQ.data,
    projectQ.data,
    enhancedEdgesQ.data,
    functionsQ.data,
    rules,
  ])

  // Write functions per contract — powers the in-node "other functions" switcher.
  const writeFnsByContract = useMemo(() => {
    const m = new Map<
      string,
      { id: string; name: string; isPermissioned: boolean }[]
    >()
    for (const n of nodes.values()) {
      if (!n.functionName || n.isView === true) continue
      const arr = m.get(n.contractAddress) ?? []
      arr.push({
        id: n.id,
        name: n.functionName,
        isPermissioned: !!n.isPermissioned,
      })
      m.set(n.contractAddress, arr)
    }
    for (const arr of m.values())
      arr.sort((a, b) => a.name.localeCompare(b.name))
    return m
  }, [nodes])

  // Local UI state
  const [startId, setStartId] = useState<string | null>(null)
  const [depth, setDepth] = useState(4)
  // Callers shown above the start; default 1 preserves the original behavior.
  // The layout BFS walks upstream symmetrically with `upDepth`, so higher values
  // expand additional caller rows.
  const [upDepth, setUpDepth] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [hoveredEdge, setHoveredEdge] = useState<CallEdge | null>(null)
  // The edge a suggestion is being reviewed against — highlighted red (remove)
  // or green (add) on the canvas while previewing.
  const [previewEdge, setPreviewEdge] = useState<{
    from: string
    to: string
    edgeType: BackendEdgeType
    action: 'add' | 'remove'
  } | null>(null)
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('tree')
  const [filters, setFilters] = useState({
    hideInternal: false,
    hideExternal: false,
    hideOptimistic: false,
    hidePermissioned: false,
    hidePermission: false,
    hideDependency: false,
    hideDelegatecall: false,
    hideUnresolved: true,
  })

  // If start's contract is collapsed, force-expand it.
  useEffect(() => {
    if (!startId) return
    const { address } = parseNodeId(startId)
    if (collapsed.has(address)) toggleCollapsed(project, address)
  }, [startId, collapsed, project, toggleCollapsed])

  // For an addEdge preview the proposed edge doesn't exist in the graph yet, so
  // inject a synthetic edge (+ endpoint nodes) into the render set so it shows
  // green. removeEdge previews highlight an existing edge, so no injection.
  const displayEdges = useMemo(() => {
    if (previewEdge?.action !== 'add') return edges
    const id = edgeKey(previewEdge.from, previewEdge.to, previewEdge.edgeType)
    if (edges.some((e) => e.id === id)) return edges
    const synthetic: CallEdge = {
      id,
      from: previewEdge.from,
      to: previewEdge.to,
      kind: 'external',
      edgeType: previewEdge.edgeType,
      user: true,
    }
    return [...edges, synthetic]
  }, [edges, previewEdge])

  const displayNodes = useMemo(() => {
    if (previewEdge?.action !== 'add') return nodes
    const dn = new Map(nodes)
    for (const ref of [previewEdge.from, previewEdge.to]) {
      if (dn.has(ref)) continue
      const { address, functionName } = parseNodeId(ref)
      const parent = dn.get(address)
      dn.set(ref, {
        id: ref,
        contractAddress: address,
        contractName: parent?.contractName ?? address,
        contractType: parent?.contractType ?? 'Contract',
        kind: parent?.kind ?? 'external',
        functionName,
      } as CallNode)
    }
    return dn
  }, [nodes, previewEdge])

  const layout = useMemo(() => {
    if (!startId || !displayNodes.size) return null
    return computeLayout({
      startId,
      nodes: displayNodes,
      edges: displayEdges,
      depth,
      upDepth,
      collapsedContracts: collapsed,
      mode: layoutMode,
      filters,
    })
  }, [
    startId,
    displayNodes,
    displayEdges,
    depth,
    upDepth,
    collapsed,
    layoutMode,
    filters,
  ])

  // Selected → path-from-start (cyan highlight + breadcrumb)
  const pathFromStart = useMemo(() => {
    if (!selected || !startId || !layout) return null
    return findPathToNode(selected, startId, layout.visibleEdges)
  }, [selected, startId, layout])

  // Re-center the start node whenever the focus OR the trace shape changes
  // (new start id, OR depth/upDepth slider moved — the start's horizontal
  // position can shift as the BFS tree widens/narrows). Filter toggles and
  // collapse changes intentionally do NOT trigger re-centering — the start
  // stays where it is; only the surrounding tree reflows.
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastCenterKey = useRef<string | null>(null)
  useEffect(() => {
    if (!startId || !layout || !scrollRef.current) return
    const key = `${startId}|${depth}|${upDepth}`
    if (lastCenterKey.current === key) return
    const pos = layout.positions[layout.effectiveStartId]
    if (!pos) return
    lastCenterKey.current = key
    const el = scrollRef.current
    el.scrollLeft = PAD_X + pos.x + layout.nodeWidth / 2 - el.clientWidth / 2
    // Bring the start (and its caller row above) comfortably into view.
    el.scrollTop = Math.max(0, PAD_Y + pos.y - 120)
  }, [startId, depth, upDepth, layout])

  // ── Drag-to-create-edge ────────────────────────────────────────────────
  const canvasRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{
    fromId: string
    x: number
    y: number
    target: string | null
  } | null>(null)

  const onHandleMouseDown = useCallback(
    (fromId: string, e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      setDrag({
        fromId,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        target: null,
      })
    },
    [],
  )

  useEffect(() => {
    if (!drag) return
    const move = (ev: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = ev.clientX - rect.left
      const y = ev.clientY - rect.top
      const targetEl = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>('[data-node-id]')
      const target = targetEl?.getAttribute('data-node-id') ?? null
      setDrag((d) =>
        d
          ? {
              ...d,
              x,
              y,
              target: target && target !== d.fromId ? target : null,
            }
          : null,
      )
    }
    const up = () => {
      setDrag((d) => {
        if (d?.target) {
          // A user-drawn edge asserts a call static analysis missed (e.g. a
          // Timelock's dynamic dispatch). Persist as an addEdge rule of type
          // 'callgraph' so it behaves like a real call in BFS.
          addRule({
            id: makeRuleId(),
            type: 'addEdge',
            from: d.fromId,
            to: d.target,
            edgeType: 'callgraph',
          })
        }
        return null
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [drag, addRule])

  // ── Cross-panel wiring ────────────────────────────────────────────────
  const selectGlobal = usePanelStore((s) => s.select)
  const ensurePanel = useMultiViewStore((s) => s.ensurePanel)
  const setActivePanel = useMultiViewStore((s) => s.setActivePanel)
  const { showRange, setSourceIndex } = useCodeStore()

  // Address the walker itself last pushed to the shared selection — used to
  // ignore our own echo in the cross-panel focus effect (so a single-click in
  // the walker selects without re-rooting; only Values-panel selections re-root).
  const selfPushedAddress = useRef<string | null>(null)
  const navigateToFunction = useFunctionNavigationStore(
    (s) => s.navigateToFunction,
  )
  const handleSelectNode = useCallback(
    (id: string) => {
      setSelected(id)
      const { address, functionName } = parseNodeId(id)
      selfPushedAddress.current = address
      selectGlobal(address)
      // If a function node, also open/expand that exact function in the Values
      // panel (FunctionFolder consumes this navigation target).
      if (functionName) navigateToFunction(address, functionName)
    },
    [selectGlobal, navigateToFunction],
  )

  // Cross-panel focus: when a contract is selected in the Values panel (the
  // shared panel-store selection), re-root the walker on it and center. Skip
  // selections the walker itself originated (the selfPushedAddress echo) so a
  // single-click in the walker doesn't re-root — only an external selection does.
  // Re-rooting is the "focus" gesture; the scroll-to-center effect below fires.
  //
  // IMPORTANT: this effect intentionally depends ONLY on `selectedFromPanel`,
  // NOT on `startId`. Including `startId` in the deps caused a clear-start
  // regression: clearing the trace (setStartId(null)) would re-fire this effect
  // with the still-set selectedFromPanel and instantly restore the previous
  // trace — making the chooser flash and disappear. `startId` is read via a ref
  // so the guard uses the current value without re-triggering on its change.
  const selectedFromPanel = usePanelStore((s) => s.selected)
  const startIdRef = useRef<string | null>(null)
  useEffect(() => {
    startIdRef.current = startId
  }, [startId])
  useEffect(() => {
    if (!selectedFromPanel) return
    if (
      selfPushedAddress.current &&
      addressesEqual(selfPushedAddress.current, selectedFromPanel)
    )
      return
    const cur = startIdRef.current
    const currentRoot = cur ? parseNodeId(cur).address : undefined
    if (currentRoot && addressesEqual(currentRoot, selectedFromPanel)) return
    setStartId(selectedFromPanel)
    setSelected(selectedFromPanel)
  }, [selectedFromPanel])

  // Double-click any node → take it as the new trace start. Its own callers
  // then appear above and its callees below, so you can walk the graph in
  // either direction. (Single-click still just selects + highlights the path
  // from the current start.)
  const handleReFocus = useCallback(
    (id: string) => {
      if (id.startsWith('unresolved:')) return // placeholder node — not a real start
      setStartId(id)
      handleSelectNode(id)
    },
    [handleSelectNode],
  )

  // Review a suggestion: re-root on the rule's node and highlight the exact edge
  // — red if it removes one, green if it adds one. Scope rules just focus.
  const focusSuggestion = useCallback(
    (rule: EdgeOverrideRule) => {
      const node = ruleFocusNode(rule)
      if (!node.startsWith('unresolved:')) {
        setStartId(node)
        handleSelectNode(node)
      }
      if (rule.type === 'addEdge') {
        setPreviewEdge({
          from: rule.from,
          to: rule.to,
          edgeType: rule.edgeType,
          action: 'add',
        })
      } else if (rule.type === 'removeEdge') {
        setPreviewEdge({
          from: rule.from,
          to: rule.to,
          edgeType: rule.edgeType,
          action: 'remove',
        })
      } else {
        setPreviewEdge(null)
      }
    },
    [handleSelectNode],
  )

  // Node ids placed ABOVE the start (negative BFS levels) — caller nodes.
  const upstreamIds = useMemo(() => {
    const set = new Set<string>()
    if (!layout) return set
    for (const [lvl, ids] of Object.entries(layout.byLevel)) {
      if (Number(lvl) < 0) for (const id of ids) set.add(id)
    }
    return set
  }, [layout])

  const handleOpenInCode = useCallback(
    async (contractAddress: string, functionName: string) => {
      try {
        selectGlobal(contractAddress)
        ensurePanel('code')
        setActivePanel('code')
        const codeResp = await getCode(project, contractAddress)
        const occs = findAllFunctionOccurrences(codeResp.sources, functionName)
        if (occs.length === 0) {
          console.warn(`Function "${functionName}" not found in source`)
          return
        }
        const first = occs[0]
        if (first) {
          setSourceIndex(contractAddress, first.sourceIndex)
          showRange(contractAddress, {
            startOffset: first.startOffset,
            length: first.length,
          })
        }
      } catch (err) {
        console.error('Failed to navigate to function:', err)
      }
    },
    [
      project,
      selectGlobal,
      ensurePanel,
      setActivePanel,
      setSourceIndex,
      showRange,
    ],
  )

  // ── Render guards ─────────────────────────────────────────────────────
  if (callGraphQ.isLoading || projectQ.isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center text-coffee-400">
        Loading…
      </div>
    )
  }
  if (callGraphQ.error) {
    return (
      <div className="flex h-full w-full items-center justify-center text-aux-red">
        Error loading call graph data
      </div>
    )
  }
  if (!callGraphQ.data || Object.keys(callGraphQ.data.contracts).length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-coffee-400">
        <div>No call graph data available</div>
        <div className="text-sm">
          Run “Generate Call Graph” in the Terminal panel first.
        </div>
      </div>
    )
  }

  const visibleNodeIds = new Set(layout ? Object.keys(layout.positions) : [])

  return (
    <div className="flex h-full w-full bg-coffee-800 text-sm">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="relative flex-1 overflow-auto"
          style={{
            backgroundImage:
              'radial-gradient(circle, rgba(150,130,200,0.10) 1px, transparent 1px)',
            backgroundSize: '18px 18px',
          }}
          onClick={() => {
            setSelected(null)
            setPreviewEdge(null)
          }}
        >
          {!startId ? (
            <StartPicker entrypoints={entrypoints} onPick={handleReFocus} />
          ) : (
            <div
              ref={canvasRef}
              className="relative group"
              style={{
                width: Math.max((layout?.canvasWidth ?? 0) + PAD_X * 2, 600),
                height: (layout?.canvasHeight ?? 0) + PAD_Y * 3,
                padding: `${PAD_Y}px ${PAD_X}px`,
              }}
            >
              {/* Edges SVG (behind nodes) */}
              <svg
                className="pointer-events-none absolute"
                style={{
                  left: PAD_X,
                  top: PAD_Y,
                  width: layout?.canvasWidth,
                  height: layout?.canvasHeight,
                  overflow: 'visible',
                }}
              >
                <ArrowDefs />
                {layout?.visibleEdges.map((e) => {
                  const fp = layout.positions[e.from]
                  const tp = layout.positions[e.to]
                  if (!fp || !tp) return null
                  const fromNode = displayNodes.get(parseNodeId(e.from).address)
                  const fromH = nodeHeight(fromNode, layoutMode)
                  const preview =
                    previewEdge &&
                    e.from === previewEdge.from &&
                    e.to === previewEdge.to &&
                    e.edgeType === previewEdge.edgeType
                      ? previewEdge.action
                      : undefined
                  const onPath =
                    !preview &&
                    !!(
                      pathFromStart &&
                      pathFromStart.includes(e.from) &&
                      pathFromStart.includes(e.to) &&
                      pathFromStart.indexOf(e.to) ===
                        pathFromStart.indexOf(e.from) + 1
                    )
                  const dimmed = !preview && !!pathFromStart && !onPath
                  const isHovered = hoveredEdge?.id === e.id
                  return (
                    <g key={e.id} style={{ pointerEvents: 'auto' }}>
                      <EdgePath
                        edge={e}
                        fromX={fp.x + layout.nodeWidth / 2}
                        fromY={fp.y + fromH}
                        toX={tp.x + layout.nodeWidth / 2}
                        toY={tp.y}
                        hovered={isHovered}
                        onPath={onPath}
                        dimmed={dimmed}
                        preview={preview}
                        showLabel={isHovered || onPath || !!preview}
                        onHover={setHoveredEdge}
                        onClick={(ed) => setSelected(ed.to)}
                      />
                    </g>
                  )
                })}
                {/* Drag-ghost edge */}
                {drag && (
                  <path
                    d={(() => {
                      const fp = layout?.positions[drag.fromId]
                      if (!fp || !layout) return ''
                      const fromNode = nodes.get(
                        parseNodeId(drag.fromId).address,
                      )
                      const fromH = nodeHeight(fromNode, layoutMode)
                      const x1 = fp.x + layout.nodeWidth / 2
                      const y1 = fp.y + fromH
                      const x2 = drag.x - PAD_X
                      const y2 = drag.y - PAD_Y
                      return `M ${x1} ${y1} C ${x1} ${y1 + 80}, ${x2} ${y2 - 80}, ${x2} ${y2}`
                    })()}
                    stroke={
                      drag.target
                        ? 'var(--aux-cyan, #1c92a8)'
                        : 'var(--aux-pink, #e27991)'
                    }
                    strokeWidth={1.6}
                    strokeDasharray="4 3"
                    fill="none"
                  />
                )}
              </svg>

              {/* Nodes */}
              <div className="absolute" style={{ left: PAD_X, top: PAD_Y }}>
                {layout &&
                  Object.entries(layout.positions).map(([id, pos]) => {
                    const { address } = parseNodeId(id)
                    const node =
                      displayNodes.get(id) ?? displayNodes.get(address)
                    if (!node) return null
                    const onPath = !!(
                      pathFromStart && pathFromStart.includes(id)
                    )
                    const dimmed = !!pathFromStart && !onPath
                    const isCaller = upstreamIds.has(id)
                    const siblings = node.functionName
                      ? (
                          writeFnsByContract.get(node.contractAddress) ?? []
                        ).filter((s) => s.id !== id)
                      : []
                    return (
                      <Node
                        key={id}
                        node={node}
                        x={pos.x}
                        y={pos.y}
                        mode={layoutMode}
                        isStart={id === startId}
                        isSelected={selected === id}
                        isOnPath={onPath}
                        isDimmed={dimmed}
                        isCollapsed={collapsed.has(node.contractAddress)}
                        isCaller={isCaller}
                        siblings={siblings}
                        onSelect={handleSelectNode}
                        onReFocus={handleReFocus}
                        onToggleCollapse={(addr) =>
                          toggleCollapsed(project, addr)
                        }
                        onHandleMouseDown={onHandleMouseDown}
                      />
                    )
                  })}
              </div>
            </div>
          )}
        </div>

        <Controls
          layoutMode={layoutMode}
          setLayoutMode={setLayoutMode}
          depth={depth}
          setDepth={setDepth}
          upDepth={upDepth}
          setUpDepth={setUpDepth}
          filters={filters}
          setFilters={setFilters}
          onClearStart={() => {
            setStartId(null)
            setSelected(null)
            setPreviewEdge(null)
          }}
          onReset={() => resetView(project)}
          trail={pathFromStart}
          nodes={nodes}
          onSelectNode={handleSelectNode}
        />
      </div>

      {/* Sidebar is always rendered (even with no trace) so the agent-suggestion
          inbox and Rules ledger are reachable without first picking a function. */}
      <DetailSidebar
        selectedId={selected}
        startId={startId}
        nodes={nodes}
        allEdges={edges}
        visibleNodeIds={visibleNodeIds}
        onSelectNode={handleSelectNode}
        onSetStart={handleReFocus}
        onHoverEdge={setHoveredEdge}
        onToggleCollapse={(c) => toggleCollapsed(project, c)}
        collapsedContracts={collapsed}
        onOpenInCode={handleOpenInCode}
        rawEdges={rawEdges}
        rules={rules}
        unmatchedRuleIds={enhancedEdgesQ.data?.unmatchedRuleIds}
        onRemoveEdge={removeEdgeAsRule}
        onAddEdge={addEdgeRule}
        onSetEdgeScope={setEdgeScope}
        onSetEdgeCap={setEdgeCap}
        onSetEdgeMitigations={setEdgeMitigations}
        onSetOutgoingScope={setOutgoingScope}
        onSetIncomingScope={setIncomingScope}
        onDeleteRule={removeRule}
        suggestions={suggestions}
        onFocusSuggestion={focusSuggestion}
        onResolveSuggestion={(id, action) =>
          resolveSuggestion.mutate({ id, action })
        }
      />
    </div>
  )
}
