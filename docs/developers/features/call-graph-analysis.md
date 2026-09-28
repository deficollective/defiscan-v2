# Call Graph Analysis

## External Call Detection

Uses Slither to analyze which external contracts each function calls. The output is stored per project in `call-graph-data.json` and consumed by permission traversal, capital analysis, and dependency detection.

- **Backend**: `callGraph.ts` (Slither runner + parser), `callGraphHeuristics.ts` (resolution heuristic engine)
- **Tool**: Slither's `--print slithir`
- **Env config**:
  - `SLITHER_VENV_PATH` — default `~/.slither-venv/`
  - `SLITHER_PATH` — default `$SLITHER_VENV_PATH/bin/slither`
  - `ETHERSCAN_API_KEY_FOR_DISCOVERY` / `L2B_ETHERSCAN_API_KEY` — **only required for Ethereum mainnet**. For L2s routed through Blockscout-style explorers (Base, Arbitrum, Optimism, Polygon, Gnosis, Scroll, Linea, Blast, zkSync, Avalanche, Celo) Slither accepts a placeholder key; the parser runs Slither with `<chain>:0x...` addresses via the `CHAIN_TO_SLITHER_NETWORK` map in `callGraph.ts` and lets the explorer resolve source without an API key. Add new chains to that map as needed.

### How it works

1. Runs Slither on each non-external contract to get SlithIR output
2. Parses the output into `contracts → functions → calls`
3. Starts from ABI functions only (public/external) to avoid pulling in library noise
4. Follows `INTERNAL_CALL` and `LIBRARY_CALL` chains transitively
5. Collects `HIGH_LEVEL_CALL`s reachable from each public function
6. Resolves storage variables to addresses using `discovered.json`
7. Classifies each call as view or write using the target ABI (or caller inference)

### Implementation details

- **ABI-driven parsing**: only captures calls from the target contract's public interface
- **Function overloading**: merges calls from overloaded functions with the same name
- **View inference**: if the caller is view/pure, an external call must also be view
- **Contract name matching**: Slither's output uses `INFO:Printers:Contract X` or `Contract X` formats for the main contract — the parser handles both
- **Nested object resolution**: `resolveStorageVariable` extracts addresses from struct-like objects (e.g. `{ aggregator: "eth:0x…", decimals: 8 }`) and resolves when exactly one address is found
- **REF_ propagation**: parent type substitutions propagate through synthetic Slither `REF_`/`TMP_` references, so the same internal function called with different arguments produces separate call entries
- **Context-aware deduplication**: the visited-set key includes type substitutions to prevent merging calls with different argument contexts
- **SafeERC20 wrapper synthesis** — OpenZeppelin's `safeTransfer`/`safeTransferFrom`/`safeApprove`/`forceApprove`/`safeIncreaseAllowance`/`safeDecreaseAllowance` route the underlying token call through `_callOptionalReturn` → `Address.functionCall` (low-level `call`), so Slither emits **no HIGH_LEVEL_CALL** for the real transfer/approve. Without a workaround, any function whose only external call goes through SafeERC20 is dropped entirely (the ABI-driven walker only keeps functions with ≥1 reachable HLC), and `safeApprove` mis-resolves to the `allowance()` pre-check inside the wrapper. `synthesizeSafeERC20Call()` in `callGraph.ts` emits a synthetic HLC per SafeERC20 `LIBRARY_CALL` by mapping `safeTransfer → transfer`, `safeTransferFrom → transferFrom`, `safeApprove/forceApprove → approve`, etc. The first LIBRARY_CALL argument is the token; a `CONVERT TMP_X = CONVERT srcVar to IERC20` alias tracker unwraps the Slither temp back to the caller's state variable name. If the wrapper sits inside another library that forwards its IERC20 param, the caller's `typeSubstitutions.get('IERC20')` is used as a fallback so the synthesized call still carries the real token name.
- **LIBRARY_CALL argument propagation** — previously library bodies inherited the parent's `typeSubstitutions` unchanged. `collectHighLevelCalls` now builds a fresh `TypeSubstitutionMap` per library call via `buildTypeSubstitutionMap`, which fixes mis-labeled HLCs for any library taking interface-typed parameters (SafeERC20 is the common case; generic protocol libraries benefit too)

### Timeout handling

Each contract gets a fixed window to complete Slither analysis. If it exceeds the limit, the process is SIGKILL-ed (not SIGTERM — Slither can ignore SIGTERM during compile) and the contract is recorded as skipped.

- **Env var**: `SLITHER_TIMEOUT_MS` — override the per-contract timeout (default: `2 * 60 * 1000` ms = 2 minutes)
- **Effect on output**: skipped contracts are written to `call-graph-data.json` with `skipped: true` instead of an `externalCalls` array

Skipped entry shape:
```json
{
  "contracts": {
    "eth:0x...": {
      "skipped": true,
      "skipReason": "Slither timeout after 120s"
    }
  }
}
```

**Terminal output** — skipped contracts emit a red warning during the analysis run, and a summary block lists all timed-out contracts at the end. If a contract is missing from the call graph, check `call-graph-data.json` for a `skipped: true` entry on that address.

### Heuristic Resolution Engine

When a direct `discovered.json` lookup fails, `callGraphHeuristics.ts` runs a set of heuristics in order and picks the highest-confidence result:

1. **VariableChainHeuristic** (100%) — follows Slither variable assignment chains to find state variables, handles nested struct fields
2. **DependencyFieldHeuristic** (90 / 65 / 45%) — catches getters that forward to a dependency (e.g. `Voter.rewardToken()` returns `minter.rewardToken()` at runtime) and internal/immutable fields that aren't stored as discovery values. Only fires when `storageVariable` is NOT a key in the caller's own `values`. Walks each dependency address held in the caller's `values` and looks for a field with the same name; if found and its value points at a contract whose ABI contains the called function, returns that as the match. Solves multi-branch disambiguation (Liquity-v2's per-branch `SortedTroves`, per-branch `PriceFeed`) that the interface-name heuristic was resolving by first-match-wins
3. **DiscoveredValuesScanHeuristic** (95 / 70 / 50%) — scans the caller contract's discovered values for `eth:` addresses, matches against contracts whose ABI contains the called function
4. **InterfaceNameHeuristic** (90 / 60 / 40%) — strips an `I` prefix from the interface name and matches against contract names
5. **FunctionSignatureHeuristic** (99 / 50 / 30%) — finds every contract whose ABI contains the called function

**Escape hatch for untracked internal/immutable state variables**: when a field can't be read via any getter (declared `internal` / `immutable` with no public accessor — e.g. Aerodrome's `Voter.rewardToken` = `IVotingEscrow(_ve).token()` captured in the constructor), discovery can't populate it. Add a `fields.<name>.handler` entry in `config.jsonc` (typically `"type": "hardcoded"` with the known address) so the field enters `discovered.json.values` and `VariableChainHeuristic` resolves it at 100%. This is the preferred fix over heuristics when the field-name on the caller doesn't match any name on its dependency chain.

### `call-graph-data.json` shape

```json
{
  "contracts": {
    "eth:0x...": {
      "externalCalls": [
        {
          "callerFunction": "deposit",
          "storageVariable": "token",
          "interfaceType": "IERC20",
          "calledFunction": "transferFrom",
          "resolvedAddress": "eth:0x...",
          "resolvedContractName": "USDC",
          "isViewCall": false,
          "callerIsView": false
        }
      ]
    }
  }
}
```

### Shared traversal helpers

Exported from `callGraph.ts` and used by `functionAnalysis.ts` and `projectAnalysis.ts`:

- `traverseWithPaths(callGraphData, startContract, startFunction)` — BFS traversal with path tracking, returns reachable contracts and their shortest paths. **Upgrade-aware**: when `startFunction` is an upgrade function (detected via `isUpgradeFunction()` in `types.ts`), seeds the BFS queue with every caller function on the contract, since a new implementation can execute any code path
- `findContractGraph(callGraphData, contract)` — case-insensitive contract graph lookup
- `buildExternalAddressSet(tags)` / `buildTagsByAddress(tags)` — build lookup structures from contract tags
- `isExternalAddress(address, externalAddresses)` / `findTag(tagsByAddress, address)` — address matching with `eth:` normalization
- `getCallGraphContractName(callGraphData, address)` — resolve contract name from call graph data
- `extractChainAddresses(value)` — extract all chain-prefixed addresses from a value (handles flat strings and one-level-deep object fields)

## Enhanced Traversal & Function Analysis

Owner-chain traversal and per-function impact/dependency analysis, built on the call graph + permission data.

| Endpoint | Backend | Purpose |
|---|---|---|
| `GET /api/projects/:project/enhanced-traversal` | `enhancedTraversal.ts` | Backward BFS → governance chain terminals (owners) per permissioned function |
| `GET /api/projects/:project/function-analysis` | `functionAnalysis.ts` | Forward BFS → reachable contracts with funds + external dependencies |

### Enhanced Traversal

`enhancedTraversal.ts` builds a unified graph from call-graph edges (caller → callee) plus permission edges (owner → function). This is the same graph used forward for capital analysis in `capitalAnalysis.ts` — see [Scoring & Review: Capital Analysis](scoring-and-review.md#capital-analysis--enhanced-graph-forward-traversal).

- **Backward BFS** from each permissioned function collapses chains into `CollapsedChainStep[]` — used for governance chain display in `FunctionFolder`
- **Response**: `ApiEnhancedTraversalResponse` — `contracts[address][functionName] → FunctionTraversalResult`

**Exported utilities:**

- `buildEnhancedGraph(callGraphData, functionsData, dataAccess, discovered?)` — builds the unified edge array. When `discovered` is passed, permission edges whose target is a shared implementation are fanned out to one edge per proxy using the impl (target = proxy, not impl), and `$self` paths are re-resolved per proxy. This lets backward traversal from any proxy find the correct owner chain for factory-deployed patterns like Aave ATokens.
- `buildIndices(edges)` — produces an `EnhancedGraph` with `forwardIndex` and `backwardIndex` (both keyed by normalized contract address)
- `EnhancedEdge` — `{ sourceContract, sourceFunction?, targetContract, targetFunction, edgeType: 'permission' | 'callgraph' | 'dependency', isViewCall? }`

**Dependency edges.** Each manual `dependencies` entry in `functions.json` (literal or path-form) emits synthetic edges `(target, func) → (depAddr, callerFn)` for every `callerFn` that appears on the dep target in the call graph. The target function is heuristic (all entry points on the dep contract) rather than hardcoded to `latestAnswer`, so any interface works. `isViewCall: true` by convention — dep reads are view; BFS propagates view-only through the hop and any non-view downstream call correctly flips the path.

Without these edges, a manual dep is a terminal leaf: `/dependencies` shows the declared address but transitive reachables (oracle wrapper → Chronicle aggregator → underlying token) stay invisible and per-function capital analysis under-counts reachable capital. Capital analysis's forward BFS filters dep edges by `sourceFunction` like callgraph, and the backward traversal used for ownership chains explicitly **excludes** dep edges — a dep is not ownership.

For leaf targets that Slither couldn't analyse (e.g. bare Chainlink aggregators with no `externalCalls`), no edges are emitted. In that case `functionAnalysis.augmentTraversalWithManualDepSeeds` still surfaces the dep itself as a reachable in `/dependencies`, so nothing is lost.

### Enhanced Graph Edges endpoint

`GET /api/projects/:project/enhanced-graph-edges` → `ApiEnhancedGraphEdgesResponse` returns the **raw** edge set (callgraph + permission + dependency) the BFS consumes, exposed read-only for the Call Graph Walker UI. Same edges, just flattened with resolved contract names so the frontend can label nodes without a second round-trip.

- `getEnhancedGraphEdges(paths, configReader, templateService, projectName)` builds it. The ~70 lines of file loading + name/type maps + impl↔proxy maps were extracted from `resolveEnhancedTraversal` into the shared `loadEnhancedGraphInputs()` (returns `null` when `discovered.json` is unreadable; both functions degrade gracefully).
- **Stable edge identity**: `enhancedEdgeKey(e)` = `${from}|${to}|${edgeType}` where `from`/`to` are node ids (`address` or `address.function`). This is stable across call-graph regeneration (unlike anything index-based) and is the key the planned edge-override file (`call-graph-overrides.json`) will use to suppress/inject edges inside `buildEnhancedGraph`.

### Call Graph Walker

`packages/protocolbeat/src/apps/discovery/defidisco/callgraph/` — top-down visual tracer that replaced the list-style `CallGraphPanel`. Pure modules (`model.ts`, `layout.ts`, `buildCallgraph.ts`, `rules.ts` — no React, unit-testable) + `view/` components + `overridesStore.ts` (zustand/localStorage, view state only: notes + collapsed contracts). Edge add/remove rules are server-persisted — see "Call-graph edge overrides" below.

- `buildCallgraph` is the only API-shape-aware module. It renders **callgraph edges from `ApiCallGraphResponse`** (keeps the rich optimistic/unresolved/view metadata) plus **permission + dependency edges from the enhanced-graph-edges endpoint**. Permission edges are contract-level (`from` = owner contract node); to wire a function-rooted trace into a contract's ownership powers it adds implicit faint **membership** edges (function node → its owner-hub contract node, only for contracts that own ≥1 permission/dependency edge). This is what makes the permission over-flare (see [permissions.md](permissions.md) § known limitation) visible and traceable.
- `CallEdge.id` IS the backend `enhancedEdgeKey` for backend-backed edges (callgraph/permission/dependency); UI-only edges (unresolved placeholders, user-drawn edges, membership links) use a UI-unique id and leave `edgeType` undefined. So removing an edge in the UI maps 1:1 to a suppressible backend edge.
- **Upstream callers + re-focus navigation:** the start function shows one level of its direct **callers** above it (negative BFS levels in `computeLayout`, gated by `upDepth`, default 1), in addition to the callee fan-out below. Caller nodes carry an `isCaller` cue (dashed border + "↑ caller" tag) — informational only. Interaction is uniform across all nodes: **single-click selects + inspects** (and highlights the path-from-start to a downstream node), **double-click re-focuses** (takes the node as the new trace start via `setStartId` — its own callers then appear above, callees below, so you can walk the graph in either direction). Double-click on `unresolved:*` placeholder nodes is a no-op. (Open-in-code moved off double-click to the DetailSidebar "↗ open in code" action.) Layout positions span the full `minLvl..maxLvl` range (lanes mode offsets y by `-minLvl`). `upDepth` is the lever for showing more caller levels at once if needed later.
- **Re-focus re-centers the scroll.** A guarded effect in `CallGraphView` (keyed on `startId`, fires once per new start) sets the scroll container's `scrollLeft` to horizontally center the new start node (`PAD_X + pos.x + nodeWidth/2 − clientWidth/2`) and `scrollTop` to bring it + its caller row into view. `PAD_X`/`PAD_Y` are module constants shared between the effect and the canvas layout.
- **In-node function switcher.** Each function node shows a "⇄ N other fns ▾" dropdown listing the **other write functions on the same contract**; picking one re-focuses on it (`onReFocus`). The full write-function set per contract is **seeded from the contract ABI** in `buildCallgraph` (`parseAbiFunction` on `ApiProjectContract.abis[].entries[].value`, skipping events/errors and view/pure) — these seeded nodes are marked `CallNode.seeded` so they're selectable/focusable but **kept out of the StartPicker**, which stays scoped to graph-connected functions (`connectedIds` from non-membership edges). `writeFnsByContract` (built in `CallGraphView` from the node map, write-only) feeds each node its sibling list. Function-node heights in `nodeHeight` were bumped to accommodate the switcher row so edge endpoints stay aligned.
### Call-graph edge overrides (the over-flare fix)

Researcher-authored rules that add/remove edges from the enhanced graph, persisted per project in `call-graph-overrides.json` and **re-applied on every recompute** (manual or the CI monitor). This is the durable fix for the permission over-flare: a researcher cuts the spurious edge(s) in the walker and the capital/governance numbers correct everywhere at once.

- **Existence vs attributes (key principle):** an edge is *curated where it's born*. callgraph edges have no hand-editable source, so the overrides file owns their **existence** (`addEdge`/`removeEdge`). permission/dependency edges are born from `functions.json` (owner definitions / `dependencies`), so they're **removed at the source**, not via overrides — the walker steers you there ("edit at source"). What the overrides file owns *for all edge types* is **attributes**, currently `scope`.
- **`scope` attribute (the principled over-flare fix):** `EdgeScope = 'forward' | 'backward' | 'both'` (default `both`). `'backward'` = the relationship is real for governance/ownership chains but does **not** propagate forward capital reach. So the Aave flare is fixed by scoping Pool's outgoing ownership edges to `backward`: AToken's owner chain still shows Pool, but Pool reaching `setLiquidationGracePeriod` no longer flares capital to every AToken. This is correct where `removeOutgoing` was an over-cut (it also killed legitimate governance reach). **Honored in traversal**: `capitalAnalysis.traverseForward` skips `scope==='backward'` edges; the backward governance `traverse` in `enhancedTraversal` skips `scope==='forward'` edges. `EnhancedEdge.scope` is set by `applyEdgeOverrides`.
- **Backend module** `callGraphOverrides.ts`: file CRUD (`getCallGraphOverrides` / `updateCallGraphOverrides` / `getEdgeOverrideRules`) + a pure, extensible **rule engine** (`applyEdgeOverrides`). Rules are a discriminated union; each `type` has one handler in `RULE_HANDLERS`. **Adding a rule = add a variant + one handler entry**, nothing else.
- **Rule types:** `addEdge` / `removeEdge` (existence — single callgraph edges, keyed by node ids); `setEdgeScope` (single) / `setOutgoingScope` / `setIncomingScope` (bulk by node, optional `edgeType` filter) set the `scope` attribute; `setEdgeCap` (single) / `setOutgoingCap` / `setIncomingCap` set an edge-centric `ImpactCap`; `setEdgeMitigation` appends `Mitigation[]` to an edge. `RuleBase` carries `id`, `note?`, `enabled?`.
- **Edge-centric caps & mitigations (relationship constraints):** the principle is *anchor a constraint where it originates* — function-intrinsic caps/mitigations (true for every caller) stay on the function in `functions.json`; relationship constraints (a delay on one owner→fn edge, a cap that only applies because of who calls) live on the edge here. `EnhancedEdge.cap` / `EnhancedEdge.mitigations` are set by the rules above. **Caps** resolve to USD in `projectAnalysis.buildResolvedEdgeCaps` (keyed by `enhancedEdgeKey`) and fold per-edge in `capitalAnalysis.traverseForward` via `minDefined(sourcePathCap, targetFuncCap, edgeCap)` — same merge as function caps; a cap on a `scope:'backward'` edge is a no-op (edge skipped before the fold). **Mitigations** merge in `getMitigationsForOwner` from the owner→fn permission edge (the edge IS the scope — the relationship counterpart to a `scopedTo` function mitigation) and transitively via `collectDownstreamScopedMitigations`; function + edge mitigations dedupe by visible identity through the shared `mitigationDedupKey` (`mitigationUtils.ts`, backend twin of `defiscan-frontend/.../shared.tsx`) so an edge mitigation identical to a function one never double-counts. Full design + as-built notes in [docs/developers/designs/edge-centric-constraints.md](../designs/edge-centric-constraints.md). (`scopedTo` is unchanged — the migration was a deliberately deferred Phase 3.)
- **Single chokepoint:** `buildEnhancedGraph(callGraphData, functionsData, dataAccess, discovered?, edgeOverrides?)` applies the rules as its final step, so all four callers (`resolveEnhancedTraversal`, `ProjectAnalysis` ×2, `v2Scoring`) feed the corrected edge set to capital, governance, dependency, and mitigation analysis. Each caller loads rules via `getEdgeOverrideRules(paths, project)`.
- **Stable identity:** rules key on node ids (`enhancedEdgeKey` semantics), so they survive call-graph regeneration. `applyEdgeOverrides` returns `unmatchedRuleIds` (enabled non-`addEdge` rules that matched nothing) so the UI can flag stale cuts after a regen.
- **Endpoints:** `GET` / `PUT /api/projects/:project/call-graph-overrides` (PUT body = the rules array; empty/null deletes the file; respects `--readonly`).
- **Frontend:** the walker fetches rules via `getCallGraphOverrides`, applies them client-side with the mirrored engine in `callgraph/rules.ts` (`applyRulesToCallEdges`) so the rendered graph matches what analysis sees, and writes them back via `updateCallGraphOverrides` (react-query mutation with **optimistic update + rollback**, so edits reflect instantly; the localStorage edge store is gone — `overridesStore` now holds only view state: notes + collapsed contracts).
- **Edge editing is sidebar-driven, and the control differs by edge type (DetailSidebar Node tab = the edge editor).** Selecting a node lists its **Outgoing** and **Incoming** edges:
  - **callgraph** edges get a reversible **on/off toggle** (existence): off → `removeEdge` rule, row stays struck-through with a restore toggle (deletes the rule) — nothing vanishes. Manually-added edges show an "added" pill + remove ✕.
  - **permission/dependency** edges get a **scope segmented control** (`both` / `gov` / `capital`) → `setEdgeScope` rule, plus an "edit at source" hint (their *existence* is curated in `functions.json`, not here).
  - The Outgoing/Incoming section header offers a one-click **"owns → gov-only"** toggle when ownership edges are present (`setOutgoingScope`/`setIncomingScope` with `scope: 'backward'`, `edgeType: 'permission'`) — the over-flare fix.
  - Every live (non-suppressed) edge also gets an inline **cap editor** (`CapControl`, USD → `setEdgeCap`; a cap on a gov-only edge is flagged as no-effect) and **mitigation editor** (`EdgeMitigationControl`: list + remove, add a `delay` (seconds) or `other` (label/description) → `setEdgeMitigations`). On the canvas, `EdgePath` renders a **◆ (cap) / 🛡 (mitigation)** marker next to the label so edge-level constraints are visually distinct from node-level (function-intrinsic) ones.
  - **Cross-panel focus:** selecting a contract in the Values panel re-roots/centers the walker on it — `CallGraphView` watches the shared `usePanelStore.selected` with a self-echo guard (`selfPushedAddress`) so a single walker click selects without re-rooting; only external (Values-panel) selections re-root.
  - An inline **"＋ add outgoing edge"** form (searchable target picker + call/dependency type) creates `addEdge` rules.
  - To show suppressed edges, `buildCallgraph` returns both `edges` (post-override) and `rawEdges` (pre-override); the sidebar diffs them and computes per-edge scope via `rules.ts` helpers (`findRemoveEdgeRule`, `effectiveScope`). The standalone "Edges" tab was removed. The **Rules tab** is the full ledger with delete + stale-cut ⚠. The canvas drag-to-add handle still works as a secondary path.
- **Consistency note:** the `enhanced-graph-edges` endpoint returns the **raw** (pre-override) edge set plus `appliedRules` + `unmatchedRuleIds`; the walker applies rules itself over its complete edge set (callgraph from `ApiCallGraphResponse` + permission/dependency from the endpoint). The backend analysis applies the same rules independently in `buildEnhancedGraph`.

### Suggestion backlog (agent-proposed overrides, researcher-reviewed)

Agents don't apply edge overrides directly — they **propose** them into a separate `call-graph-suggestions.json`, and a researcher accepts/rejects each in the walker. The safety property is structural: `buildEnhancedGraph` never reads the suggestions file, so an unreviewed suggestion is inert by construction, not by convention.

- **Backend** `callGraphSuggestions.ts`: `RuleSuggestion = { id, rule: EdgeOverrideRule, reasoning, status: 'pending'|'accepted'|'rejected', createdBy?, createdAt, reviewedAt? }` stored in `call-graph-suggestions.json`. `acceptSuggestion` promotes `rule` into `call-graph-overrides.json` (carrying `reasoning` into the rule's `note`, preserving provenance) and marks it accepted; `rejectSuggestion` marks rejected; both are no-ops on already-resolved suggestions (idempotent). Endpoints: `GET /api/projects/:project/call-graph-suggestions`, `POST .../call-graph-suggestions` (add — parity/programmatic; the usual agent path is a direct file write), `POST .../call-graph-suggestions/:id/:action` (`accept`|`reject`, gated on `--readonly`).
- **Agent path:** a skill appends to `call-graph-suggestions.json` directly (file write, like other skills edit `functions.json`) — no running server needed at agent time.
- **Frontend:** a **Suggestions ("inbox") tab** in the DetailSidebar (pending-count badge; auto-opens when there are pending suggestions and no trace started). Each card shows `describeRule(rule)` + the agent's reasoning + `createdBy`, a **⊙ focus** button, a stale flag (`ruleMatchesAnyEdge` — rule matches no current edge), and **✓ accept / ✕ reject**. Accept promotes via the overrides mutation; the inbox + overrides + enhanced-edges queries refetch. Resolved suggestions stay listed (dimmed) for an audit trail.
- **⊙ focus highlights the exact edge by action:** `focusSuggestion(rule)` re-roots/centers the walker on the rule's node (`ruleFocusNode`) **and** sets a `previewEdge`, which `EdgePath` renders **red for `removeEdge`** and **green for `addEdge`** (thick, overrides path/kind colouring). For an `addEdge` the proposed edge doesn't exist yet, so `CallGraphView` injects a synthetic edge + endpoint nodes (`displayEdges`/`displayNodes`) into the render set only; the real edge/data sets are untouched. The highlight clears on background click / new trace. (Scope-rule suggestions just focus the node, no edge colour.)

### Function Analysis

`functionAnalysis.ts` iterates all write functions from `discovered.json` ABIs (the same set shown in the UI's permissions section), ensuring dependency detection covers every write function visible to reviewers.

- **Impact** (permissioned functions or functions with dependencies): forward BFS via the call graph, filtered to contracts that have funds. Returns `callPath: CallPathStep[]` (shortest path)
- **Dependencies** (all write functions): three sources merged and deduplicated:
  1. **Call-graph** (`dependencyType: 'callgraph'`) — auto-detected external contracts reached via forward BFS. Has a `callPath` showing the code-level execution trace
  2. **Write** (`dependencyType: 'write'`) — external contracts that own a permissioned function, detected via `buildWriteDependencyLookup()`. Resolves `ownerDefinitions` and filters to addresses marked `isExternal`. Empty `callPath` (authority relationship, not execution)
  3. **Manual** — dependencies explicitly listed in `functions.json`. `isAutoDetected: false`
- **Deduplication**: call-graph deps win over write-deps for the same address (richer path info). Manual deps are always preserved
- **Pre-loaded data**: accepts optional `FunctionAnalysisPreloadedData` to avoid redundant file I/O when callers (e.g. `projectAnalysis.ts`) have already loaded functions, call graph, funds, or contract tags data
- **Response**: `ApiFunctionAnalysisResponse` — `contracts[address][functionName] → FunctionAnalysis`

### Key types

Defined in both backend and frontend `types.ts`:

- `FunctionTraversalResult`, `TraversalTerminal`, `OwnershipChainStep` — enhanced traversal
- `FunctionImpactEntry`, `FunctionDependencyEntry`, `FunctionAnalysis`, `CallPathStep` — function analysis
- `FunctionDependencyEntry.dependencyType` — `'callgraph' | 'write'`
