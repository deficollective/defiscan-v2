# Edge-Centric Mitigations & Impact Caps

**Status:** Phase 1 (edge caps) + Phase 2 (edge mitigations) **implemented**; Phase 3 (`scopedTo` migration) explicitly deferred / not done.
**Author:** audit/refactor session, 2026-05-26

## Implementation notes (as-built)

- New rule variants live in `callGraphOverrides.ts`: `setEdgeCap`/`setOutgoingCap`/`setIncomingCap` (handler `setCapWhere`) and `setEdgeMitigation` (handler `appendMitigationsWhere`, appends so rules stack). `EnhancedEdge` gained `cap?: ImpactCap` and `mitigations?: Mitigation[]`.
- Edge caps resolved in `projectAnalysis.buildResolvedEdgeCaps()` (keyed by `enhancedEdgeKey`), folded in `capitalAnalysis.traverseForward` via a new `minDefined(...)` helper into both `edgeReachCap` and `propagatedPathCap`. A cap on a `scope:'backward'` edge is a no-op (edge skipped before the fold) — verified.
- Edge mitigations: `projectAnalysis.buildEdgeMitigationsLookup()` (keyed by a checksum-tolerant `normalizedEdgeKey`); merged in `getMitigationsForOwner` from the owner→fn **permission** edge, and transitively in `collectDownstreamScopedMitigations` on callgraph/dependency edges. The merge dedup now uses the **shared `mitigationDedupKey`** extracted into `mitigationUtils.ts` (backend twin of `shared.tsx`).
- Frontend mirror: `api/types.ts` (8 rule variants total), `model.CallEdge.{cap,mitigations}`, `rules.ts` (`effectiveCap`/`effectiveEdgeMitigations`/`capLabel` + exhaustive switches), `CallGraphView` (`setEdgeCap`/`setEdgeMitigations` callbacks), `DetailSidebar` (`CapControl` + `EdgeMitigationControl` inline editors), `EdgePath` (◆/🛡 markers). Cross-panel focus added in `CallGraphView` (watch `usePanelStore.selected`, self-echo guard).
- Tests: rule-engine handlers + dedup key + cap-fold verified against compiled `dist` (12 assertions across cap + mitigation + coexistence + backward-no-op). l2b `tsc` and protocolbeat `vite build` both pass.
- **Not done (deferred):** `scopedTo` is untouched and keeps working; no migration. The function-panel read-only "edge-level constraints" indicator (design §U3) was not built — function and edge editors are independent for now.

---


## Problem

Today a constraint on "what an admin can do" has two kinds but only one natural home:

- **Function-intrinsic constraints** — bounded by the function's own code (a `require` value-range, a rate limit, a reward budget). True for **every caller / every edge**. Correctly anchored on the **function** (`functions.json` / `permission-overrides.json` `mitigations[]`).
- **Relationship constraints** — they exist because of the *path*: a timelock delay on a `(timelock → target)` edge, governance-vs-capital `scope`, a cap that only applies because of *who* calls. The correct anchor is the **edge**.

Two mismatches result:
1. `scope` is already a true edge attribute (`forward`/`backward`/`both`) living in `call-graph-overrides.json`, but it is disconnected from mitigations/caps entirely.
2. Edge-specific mitigations are *faked* via `scopedTo: {address, type}` bolted onto a **function** mitigation. It works but can't express "cap this one hub edge" or "cap all outgoing edges of this admin," and it conflates function and edge identity.

This caused the concrete Aave over-flare: `PoolInstance` owns `mint`/`burn`/`transferUnderlyingTo`/… on every aToken (528 outgoing permission edges → 132 token contracts). Following them forward flared ~20B token value onto every admin that merely reaches a Pool setter. The interim fix was `setOutgoingScope(Pool, permission, backward)` — correct but blunt (it can only zero forward capital, not bound it to a realistic number).

## Principle

> **Anchor a constraint where it originates.** Function-intrinsic constraints stay on functions (apply to all edges). Relationship constraints live on edges, keyed by the stable `enhancedEdgeKey` (`from|to|edgeType`). One rule engine, one edge identity, one shared dedup key.

## Scope

- **Phase 1 — edge caps.** Pure addition. Solves the over-flare *magnitude* problem.
- **Phase 2 — edge mitigations + merge/dedup.** Pure addition.
- **Phase 3 — `scopedTo` migration — DEFERRED.** `scopedTo` stays exactly as-is and keeps working. The function panel keeps its function-level mitigation/cap editor unchanged. No migration, no removal.

Both Phase 1 and 2 are *additive*: existing rules, function mitigations, and `scopedTo` all keep working untouched.

---

## Grounding (current code)

- **Rule engine** `callGraphOverrides.ts`: `EdgeOverrideRule` discriminated union (`:91`), one pure handler per type in `RULE_HANDLERS` (`:174`), `applyEdgeOverrides` runs them and reports `unmatchedRuleIds` (`:242`). Helpers `removeWhere` (`:152`) and `setScopeWhere` (`:160`) are the patterns to copy. Runs as **step 4 of `buildEnhancedGraph`** (`enhancedTraversal.ts:288`) — the single chokepoint feeding capital/governance/dependency/mitigation analysis.
- **`EnhancedEdge`** `enhancedTraversal.ts:44-70`: carries `scope?` today.
- **Cap fold** `capitalAnalysis.ts traverseForward`: source/target function caps (`:314`,`:325`), `edgeReachCap` with `isViewCall ? 0` (`:337`), per-path `min` + per-contract `max` merge (`:346-369`), `propagatedPathCap` (`:374`). Scope skip `if (edge.scope === 'backward') continue` (`:296`). Caps come from `resolvedImpactCaps` built in `projectAnalysis.buildResolvedImpactCaps` (`:1590`).
- **Mitigation resolution** `projectAnalysis.getMitigationsForOwner` (`:1925`): direct (`mitigationsLookup` `:1642`) + transitive (`collectDownstreamScopedMitigations` `:1792`, walks callgraph/dependency edges, skips permission `:1869`), deduped by `${type}:${description}:${scopedTo?.address ?? ''}` (`:1977`).
- **PUT/GET `/call-graph-overrides`** `main.ts:830`: body is an **untyped** rules array (`Array.isArray(req.body)`), **no zod on rule shape** → new variants round-trip with zero persistence/schema changes. (If zod is ever added, run `pnpm run generate-schemas && pnpm build`.)
- **Suggestions** `callGraphSuggestions.ts`: rule-type-agnostic; `acceptSuggestion` promotes any rule verbatim → new variants are auto-suggestible.
- **Frontend mirror** `callgraph/rules.ts`: `applyRulesToCallEdges` (`:50`), `effectiveScope` (`:112`), `describeRule` (`:241`), `ruleFocusNode` (`:189`), `ruleMatchesAnyEdge` (`:202`); rule union in `api/types.ts:933`; `CallEdge` in `model.ts:53` has `scope?`.
- **Cross-panel selection** `store/panel-store.ts`: `usePanelStore`, state `selected`, action `select`. Read by `ValuesPanel`/`FunctionFolder` and `CallGraphView` (which already pushes selection out via `selectGlobal`, `CallGraphView.tsx:535`).
- **Walker focus** `CallGraphView.tsx`: `startId` state (`:351`), `handleReFocus` → `setStartId` + `handleSelectNode` (`:544`), scroll-to-center effect (`:441`). Node id format `address` or `address.function` (`model.ts nodeId :89` / `parseNodeId :93`).
- **Node/edge rendering** `view/Node.tsx` (`isFn` flag `:54`, head color `:78`, permissioned badge `:155`), `view/EdgePath.tsx` (color/dash by `edge.kind`, label `:60-84`), `view/DetailSidebar.tsx` (Node tab edge list + scope control, tabs `:93`).

---

## Phase 1 — Edge caps

### 1A. Rule variants (`callGraphOverrides.ts`)
Reuse `ImpactCap` from `types.ts`. Add after `SetIncomingScopeRule`:

```ts
export interface SetEdgeCapRule extends RuleBase {
  type: 'setEdgeCap'
  from: string; to: string; edgeType: BackendEdgeType
  cap: ImpactCap
}
export interface SetOutgoingCapRule extends RuleBase {
  type: 'setOutgoingCap'
  node: string; edgeType?: BackendEdgeType
  cap: ImpactCap
}
export interface SetIncomingCapRule extends RuleBase {
  type: 'setIncomingCap'
  node: string; edgeType?: BackendEdgeType
  cap: ImpactCap
}
```
Add to the `EdgeOverrideRule` union.

### 1B. Handlers
Add `setCapWhere` (mirrors `setScopeWhere`) that sets the **raw `ImpactCap`** on matched edges (USD resolution needs `dataAccess`/`fundsData`, unavailable in the pure engine). Add 3 handler entries matching the scope trio's matchers. `applyEdgeOverrides` needs no change (`matched === 0` already drives `unmatchedRuleIds`).

### 1C. `EnhancedEdge`
Add `cap?: ImpactCap`. Thread onto the walker edge type `EnhancedGraphEdge` + its mapping so the sidebar can display the current cap.

### 1D. Merge in `traverseForward` (critical)
- `projectAnalysis`: add `buildResolvedEdgeCaps(): Map<string, number>` keyed by `enhancedEdgeKey(edge)` — `normalizeImpactCap(edge.cap)` → `resolveImpactCap(...)`. Pass into `CapitalAnalysisCalculator` constructor.
- In `traverseForward`, fold the edge cap into the existing per-edge `min`:
  ```ts
  const edgeCap = this.resolvedEdgeCaps.get(enhancedEdgeKey(edge))
  const edgeReachCap = isViewCall ? 0 : minDefined(newPathCap, targetFuncCap, edgeCap)
  ```
  Also fold `edgeCap` into `propagatedPathCap` so it threads downstream. Add a small `minDefined` helper.
- Edge caps are **owner-independent** (the edge already encodes the relationship) → they do **not** force owner into the BFS cache key (`:75-83` unchanged).
- Merge semantics: tightest cap wins per path (`min`), least-restrictive across paths wins per contract (`max`) — identical to function caps today, just extended.

### 1E. Frontend mirror
`api/types.ts` (3 interfaces + union), `model.ts CallEdge.cap?`, `rules.ts` (3 cases in `applyRulesToCallEdges`, `effectiveCap` helper paralleling `effectiveScope`, extend exhaustive switches in `describeRule`/`ruleFocusNode`/`ruleMatchesAnyEdge`).

---

## Phase 2 — Edge mitigations + resolution/dedup

### 2A. Rule variant
Reuse `Mitigation` from `types.ts`:
```ts
export interface SetEdgeMitigationRule extends RuleBase {
  type: 'setEdgeMitigation'
  from: string; to: string; edgeType: BackendEdgeType
  mitigations: Mitigation[]   // appended, not replaced
}
```
Handler `setMitigationsWhere` **appends** to `e.mitigations ?? []` so multiple rules accumulate.

### 2B. `EnhancedEdge`
Add `mitigations?: Mitigation[]`.

### 2C. Resolution / merge (the hard part) — `getMitigationsForOwner`
- Add a third source alongside direct + transitive: edge mitigations on the **incoming permission edge** from `ownerAddress` → `(contractAddress, functionName)`, looked up by `enhancedEdgeKey`. Build a lazy `edgeMitigationsLookup` from the enhanced edges. Owner-match is *intrinsic* (the edge only exists for that relationship) — no `scopedTo` filtering needed.
- **Shared dedup key (mandatory):** extract the visible-identity key logic out of `defiscan-frontend shared.tsx mitigationDedupKey` into a shared util (e.g. `l2b .../defidisco/mitigationUtils.ts`); have both backend and `shared.tsx` use it. Switch the backend dedup (`:1977`, `:1912`) to it. This prevents an edge mitigation and an identical function mitigation rendering as two badges (**the #1 correctness risk**).
- Edge mitigations carrying `impactCap` resolve to USD in the same loop and feed the Phase-1 edge-cap fold. Document: an edge mitigation with `impactCap` is the "rich" form; `setEdgeCap` is the cap-only shortcut.

### 2D. Transitive collection
`collectDownstreamScopedMitigations` walks callgraph/dependency edges (skips permission). When it crosses such an edge, also pull `edgeMitigationsLookup.get(enhancedEdgeKey(edge))`. Permission-edge mitigations are relationship-terminal (handled in 2C). Reuse the shared dedup key in the `seen` sets.

### 2E. Frontend
Mirror `setEdgeMitigation` in `api/types.ts`, `rules.ts` (append to `e.mitigations`), `model.ts CallEdge.mitigations?`.

---

## UX (covers function-vs-edge distinction, walker, function-panel, cross-panel focus)

### U1. Function-level vs edge-level visual distinction in the walker
- **Function-intrinsic** caps/mitigations render **on the node** (function node, near the existing "permissioned" badge in `Node.tsx:155`): a shield icon + count for mitigations, a `$cap` chip for caps. These come from the function's own metadata (already available via the admins/dependencies data the walker can read).
- **Edge-level** caps/mitigations render **on the edge** (`EdgePath.tsx`, near the label `:81`): a small badge/marker (e.g. a `◆$` chip for a cap, a shield glyph for a mitigation) so it's unmistakably a property of the *relationship*, not either endpoint. Edge cap also shown in the DetailSidebar edge row.
- Legend/tooltip copy makes the distinction explicit ("on node = applies to all callers; on edge = applies only to this caller→target relationship").

### U2. DetailSidebar edge editors (`DetailSidebar.tsx` Node tab)
Alongside the existing scope segmented control for permission/dependency edges, add:
- a **cap editor** (amount + unit dropdown reusing the `ImpactCap` shape, or "remove cap") → emits `setEdgeCap` / bulk `setOutgoingCap`/`setIncomingCap`;
- a **mitigation editor** (reuse the mitigation form shape from `FunctionFolder.tsx` minus the `scopedTo` block — the edge *is* the scope) → emits `setEdgeMitigation`.
All via the existing generic `saveRules`/`addRule`/`removeRule` path in `CallGraphView.tsx` (no API change). Section-header one-click affordances mirror the existing "owns → gov-only" pattern.

### U3. Function panel compatibility (`FunctionFolder.tsx`) — no Phase 3
- The function panel keeps its function-level mitigation/cap editor and `scopedTo` exactly as-is.
- **Add a read-only "edge-level constraints" indicator**: for the selected function, list any edge mitigations/caps whose target is `(thisContract, thisFunction)`, labelled as edge-level and pointing to the walker for editing. This keeps the two surfaces coherent (a researcher in the Values panel sees that edge-level constraints exist without editing them there). Purely additive, read-only.

### U4. Cross-panel focus (Values → walker)
When a contract is selected in the Values panel, focus/center it in the walker. Implementation in `CallGraphView.tsx`:
```ts
const selectedFromPanel = usePanelStore((s) => s.selected)
useEffect(() => {
  if (!selectedFromPanel) return
  const { address } = parseNodeId(startId ?? '')
  if (address === selectedFromPanel) return        // loop guard: ignore our own pushes
  setStartId(selectedFromPanel)                     // re-root + the existing scroll-to-center effect fires
}, [selectedFromPanel])
```
- **Loop guard** is essential: the walker already pushes selection out via `handleSelectNode → selectGlobal`. Re-focus only when the incoming selection differs from the current root's address.
- Behavior: select a contract in Values (or click a node in the walker) → walker re-roots and centers on that contract. Bidirectional, consistent with `usePanelStore` already being the shared channel.

---

## Testing

### Backend unit tests (Vitest, colocated `*.test.ts`)
- **`callGraphOverrides.test.ts`** (extend): each new handler — `setEdgeCap`/`setOutgoingCap`/`setIncomingCap`/`setEdgeMitigation` — sets the attribute on exactly the matched edges; non-matching edges untouched; `unmatchedRuleIds` reports a stale rule; bulk vs single matchers; rule order independence with scope rules.
- **`capitalAnalysis` cap fold**: a `setEdgeCap` on an edge caps that path's reach (`min` with function caps); a `backward`-scoped edge with a cap contributes 0 (cap is a no-op on a skipped edge — explicit assertion); view-call edge still contributes 0; per-contract `max` across a capped and an uncapped path returns the uncapped value.
- **Mitigation merge/dedup**: an edge mitigation identical (by shared `mitigationDedupKey`) to a function mitigation collapses to one; distinct ones both survive; transitive collection pulls edge mitigations on callgraph/dependency edges without double-adding; permission-edge mitigations resolve via the direct owner path.
- **Shared dedup key**: a focused test asserting backend and frontend keys agree for representative mitigations (delay/valueRange/relativeValue/other-with-label).

### Integration / regression
- **Before/after capital snapshot** (scripted, like the over-flare measurement): apply a `setEdgeCap` on a representative Aave Pool→AToken edge; assert the target admin's `totalReachableCapital` drops by the expected bounded amount and the deduplicated `totals` union is unchanged.
- Run on a project using `scopedTo` today (grep `permission-overrides.json`) — assert identical capital/mitigation output (Phase 2 must not change `scopedTo` behavior since Phase 3 is deferred).
- `cd packages/l2b && pnpm build`; `cd packages/protocolbeat && pnpm build`; rebuild `defiscan-frontend` if the `mitigationDedupKey` extraction touches `shared.tsx`.

### Manual UX checklist
- Author an edge cap and an edge mitigation from the DetailSidebar; confirm round-trip via GET `/call-graph-overrides` and re-applied after a call-graph regen.
- Walker: function-level badge on node vs edge-level badge on edge are visually distinct; tooltips correct.
- Function panel shows the read-only edge-level indicator for a function that has an edge mitigation.
- Select a contract in Values → walker re-roots/centers on it; click a walker node → Values updates; no focus oscillation (loop guard).

---

## Docs to update on completion
- **CLAUDE.md** Feature Index: Call-Graph Edge Overrides (new rule types; edge `cap`/`mitigations` attributes; "existence vs attributes" now includes caps + mitigations), Impact Cap (edge caps fold in `traverseForward`), Mitigations Display / Permission Overrides (edge mitigations; shared `mitigationDedupKey`).
- `docs/developers/features/call-graph-analysis.md` — Edge Overrides section.
- `docs/developers/features/permissions.md` — Mitigations + Impact Cap (edge-anchored vs function-intrinsic principle).
- `docs/developers/features/scoring-and-review.md` — how edge caps/mitigations affect TVS impact + radar.

## Risks / open questions
1. **Double-counting function vs edge mitigations** — #1 risk; solved by the single shared `mitigationDedupKey` (2C). Must extract to shared code.
2. **Cap fold correctness** — edge cap + function cap on same target must `min` (single `minDefined` fold), not double-discount.
3. **Transitive edge-mitigation collection** — easy to miss in `collectDownstreamScopedMitigations` (2D); call out in PR.
4. **Capping a `backward`-scoped edge is a no-op for capital** (edge skipped at `:296`) — document; surface in UI if both set on one edge.
5. **Edge-key stability** — permission edge keys are contract-level (stable); callgraph/dependency keys include `sourceFunction`, so a rename orphans the rule → surfaces via `unmatchedRuleIds` (same guarantee as scope today).
6. **Focus loop** — guard `usePanelStore` echo in U4.
