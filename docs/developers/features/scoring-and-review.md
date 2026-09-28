# Scoring & Review

## ProjectAnalysis API

`ProjectAnalysis` (`packages/l2b/src/implementations/discovery-ui/defidisco/projectAnalysis.ts`) is the single backend authority for admin and dependency analysis. Every consumer — the researcher UI, `FunctionFolder`, and the review compiler — goes through it (via HTTP or direct call).

See [Architecture: Data Pipeline](../architecture.md#data-pipeline) for where this fits in the end-to-end flow.

### HTTP Endpoints

| Endpoint | Response | Consumers |
|---|---|---|
| `GET /admins` | `ApiAdminsResponse` | ScoringSection, FunctionFolder, ReviewCompiler |
| `GET /admins?contract=X` | filtered `ApiAdminsResponse` | FunctionFolder |
| `GET /dependencies` | `ApiDependenciesResponse` | ScoringSection, FunctionFolder, ReviewCompiler |
| `GET /dependencies?contract=X` | filtered `ApiDependenciesResponse` | FunctionFolder |

### Key Types

```typescript
// --- Admins ---
interface ApiAdminsResponse {
  totals: { adminCount: number; totalCapitalAtRisk: number; totalTokenValueAtRisk: number }
  admins: AdminEntry[]
}

interface AdminEntry {
  address: string;  name: string;  type: ApiAddressType
  isExternal: boolean;  isGovernance: boolean;  entity: string | null
  functions: AdminFunctionEntry[]
  totalDirectCapital: number;  totalDirectTokenValue: number
  totalReachableCapital: number;  totalReachableTokenValue: number
  uniqueContractsAffected: number
}

interface AdminFunctionEntry {
  contractAddress: string;  contractName: string;  functionName: string
  impact: Impact;  mitigations?: Mitigation[]
  chains: CollapsedChain[]          // pre-collapsed ownership chains
  directFundsUsd: number;  directTokenValueUsd: number
  reachableContracts: ReachableContract[]
  totalReachableFundsUsd: number;  totalReachableTokenValueUsd: number
  unresolvedCallsCount: number
}

// --- Dependencies ---
interface ApiDependenciesResponse {
  totals: { dependencyCount: number }
  dependencies: DependencyEntry[]
}

interface DependencyEntry {
  address: string;  name: string;  entity: string | null
  isAutoDetected: boolean;  dependencyType: 'callgraph' | 'write' | undefined
  viewOnlyPath: boolean;  calledFunctions: string[]
  functions: DependencyFunctionEntry[]
  totalFundsAtRisk: number;  totalTokenValueAtRisk: number
}
```

Types are defined in `projectAnalysis.ts` and mirrored in `packages/protocolbeat/src/api/types.ts` for the frontend.

### Design Principles

1. **Single source of truth.** All admin/dependency computation happens in `ProjectAnalysis`. If data needs to change, change it there — never in the compiler or the frontend.
2. **Per-contract filtering via query param.** The backend always builds the full graph (sub-second) and filters the response. Project-wide and per-contract queries share the same code path.
3. **Pre-collapsed chains.** Ownership chains are collapsed server-side — chains with identical contract sequences are merged and function names grouped per step.
4. **Tag enrichment is server-side.** `isExternal`, `isGovernance`, and `entity` are pre-resolved so consumers never need to join contract-tags data.

### Admin Type Mapping

`mapAdminType()` maps raw discovery types to user-facing types:

- Zero address → `Revoked`
- Any type with `immutable` proxy → `Immutable`
- `Untemplatized` / `Unknown` with non-immutable proxy → `Upgradeable`

## Scoring UI

The scoring dashboard lives in the DeFiScan panel (`V2ScoringSection.tsx`). It fetches `getAdmins(project)` and `getDependencies(project)` via React Query and renders four inventory sections: **Contracts**, **Functions**, **Dependencies**, **Owners**.

### Shared module

`scoringShared.tsx` is the **single source of truth** for every scoring UI utility and display component. Do not duplicate code from this file.

- **Utilities**: `formatUsdValue`, `formatDelay`, `hasCapitalData`, `hasTokenValueData`, `isZeroAddress`, `getAdminTypeColor`, `getImpactColor`, `computeDeduplicatedCapital`
- **Components**: `TreeNode`, `FundsDisplay`, `TokenValueDisplay`, `FunctionCapitalBreakdown`
- **`OwnerSection`** — shared between the Owners and Dependencies sections to render an owner/admin card with type badges, proxy tags, capital-at-risk, and expandable function list

Components consume `AdminEntry` and `AdminFunctionEntry` directly — there are no intermediate scoring types.

### Section architecture

- **Owners** (`AdminsInventoryBreakdown.tsx`): filters out external owners (they live in Dependencies). By default shows only "key owners" — EOAs, EOAPermissioned, Multisigs, and governance-tagged contracts. A "Show all contracts" checkbox reveals the rest.
- **Dependencies** (`DependencyInventoryBreakdown.tsx`): regular dependencies use the local `DependencySection`; external owners are extracted from the admins response (`admin.isExternal === true`) and rendered with the shared `OwnerSection`. A "Show immutable" toggle (on by default) applies to external owners.

### Capital & Token Value display

- **Capital at risk** (green) shows contract funds (balances + positions).
- **Token value** (yellow) shows protocol token market cap, displayed separately — never summed with capital.
- Both are computed server-side in `capitalAnalysis.ts` via `getContractFunds()` and `getContractTokenValue()`.
- Token market cap is pre-computed during funds fetching and stored in `funds-data.json` under `tokenInfo.tokenValue`.
- Header totals use `computeDeduplicatedCapital()` to avoid double-counting contracts that appear under multiple admins.
- Functions marked `'no-impact'` are excluded from all capital calculations.

### Capital Analysis — Enhanced Graph Forward Traversal

`CapitalAnalysisCalculator` in `capitalAnalysis.ts` computes per-admin capital using the **enhanced graph** (call graph + permission edges) from `enhancedTraversal.ts`. This is the same unified graph used for backward governance-chain resolution, traversed forward to find every contract reachable from an admin's function.

**Why not call-graph only?** Generic admin functions like Timelock's `queueTransaction`/`executeTransaction` take arbitrary calldata — Slither can't statically resolve their targets. Without permission edges, these functions would show $0 reachable capital. The enhanced graph adds permission edges (e.g., Timelock → CometProxyAdmin.changeAdmin) so capital propagates transitively through the ownership chain.

**How it works:**

1. `ProjectAnalysis` builds the enhanced graph via `buildEnhancedGraph()` + `buildIndices()`
2. `CapitalAnalysisCalculator` receives the graph along with funds data, functions data, and a contract name map
3. For each admin function, `traverseForward()` does a BFS through the forward index. Call-graph edges are followed where `sourceFunction` matches the current function; permission edges (contract-level, no `sourceFunction`) are followed from the current contract
4. Cycles are handled via visited `(contract:function)` pairs (this correctly handles circular ownership like Governor ↔ Timelock)
5. `fundsAtRisk` is true for a reachable contract only if at least one called function on that contract has an impact score

**Admin capital:**

```
totalDirectCapital    = Σ min(funds(contract), directContractCaps[contract]) for each contract where the admin has permissions
totalReachableCapital = totalDirectCapital + Σ min(funds(contract), contractCaps[contract]) for reachable contracts (where fundsAtRisk = true)
```

`directContractCaps[contract]` is the max `impactCapUsd` across the admin's functions on that contract (least restrictive wins); `undefined` (uncapped) if any impactful function on that contract is uncapped. Same rule applies per-contract for reachable totals, aggregated across all functions in the admin's traversal.

**Cap propagation through BFS** (`traverseForward`):
- Each edge's effective cap = `minDefined(pathCap, targetFunctionCap, edgeCap)` — i.e. the source-side cap chain, the target function's own `impactCapUsd`, **and** any edge-anchored cap (`EnhancedEdge.cap`) all constrain what calling that edge can do. Without the target-cap term a transitive reacher (e.g. Governor → Timelock → UNI.setMinter) would miss the cap on `setMinter` and show full UNI market cap.
- View-call edges (`isViewCall === true`) contribute `edgeReachCap = 0`. Since reads cannot move funds, a view edge is a no-op in the per-contract `max` merge — it doesn't flip a capped contract to uncapped (the UNI `balanceOf` scenario), and a contract reached only via view calls ends up with `effectiveCapUsd = 0` (correctly shows $0 at risk).
- Per-contract cap merging uses `max` across edges: the least-restrictive reach wins, and `undefined` (uncapped) dominates any numeric cap.

### Edge-anchored caps & mitigations

Researchers can attach impact caps and mitigations directly to edges via override rules in `call-graph-overrides.json`, alongside (and in addition to) function-intrinsic caps in `functions.json`. The principle, with the full design in [docs/developers/designs/edge-centric-constraints.md](../designs/edge-centric-constraints.md): function-intrinsic constraints (true for every caller) stay on the function; relationship constraints (a timelock delay on one owner→fn edge, a cap that only applies because of *who* calls) live on the edge.

- **Edge caps** (`setEdgeCap` / `setOutgoingCap` / `setIncomingCap` rules → `EnhancedEdge.cap`) are resolved to USD in `projectAnalysis.buildResolvedEdgeCaps` keyed by `enhancedEdgeKey`, then folded per-edge inside `capitalAnalysis.traverseForward` via `minDefined(pathCap, targetFuncCap, edgeCap)` — same monotonic min/max semantics as function caps. Effects on TVS: a cap on a hub edge bounds the propagation from that edge alone (the surgical alternative to `scope:'backward'`, which zeros propagation entirely). A cap on a `scope:'backward'` edge is a no-op because the edge is skipped before the fold; this is documented and surfaced in the walker UI.
- **Edge mitigations** (`setEdgeMitigation` rule → `EnhancedEdge.mitigations`) are merged into `getMitigationsForOwner`'s result from the owner→function permission edge **plus** transitively in `collectDownstreamScopedMitigations` on callgraph/dependency edges. The merged set deduplicates through the **shared `mitigationDedupKey`** ([`mitigationUtils.ts`](../../../packages/l2b/src/implementations/discovery-ui/defidisco/mitigationUtils.ts), backend twin of the frontend `shared.tsx` helper). After merging, `delayRef → delaySeconds` is resolved for any delay mitigation lacking it — including edge-anchored delays — so admin-view badges render the correct number even when the timelock lives on the edge.
- **Effect on radar / TVS**: edge caps and edge-anchored delay mitigations participate in the same `effectiveCapUsd` and `functionDelaySeconds` pipelines as their function-level counterparts (no special-casing). What does change is *attribution*: moving a caller-relationship timelock onto the edge keeps the curator/owner admin row's delay badge while eliminating the spurious propagation onto downstream dependency rows (Morpho Blue, Chainlink, …). See [permissions.md § Edge-anchored mitigations & impact caps](permissions.md) for the dedup + leak-prevention details and the `func.delay` synthesis caveat.

### Shared-implementation fan-out

Factory-deployed proxy patterns (Aave ATokens, debt tokens, similar shared-impl designs) break the normal "1 impl = 1 proxy" mapping that capital analysis originally assumed. When N proxies share one impl:

- One admin entry on the impl (e.g. `burn` with owner `$self.POOL`) is fanned out to **N admin rows** — one per proxy — at `getAdmins` time. Each row's `contractAddress` is the proxy, and `$self` paths rebind to that proxy for owner resolution.
- `directFundsUsd` on each fanned-out row reads the **proxy's** balance (via proxy-keyed `getContractFunds`), not the impl's — so dollar amounts reflect actual user deposits, not any tokens mistakenly sent to the impl itself.
- Permission edges in `buildEnhancedGraph` also fan out (edge target = each proxy, not the single impl), so backward governance-chain resolution from any proxy finds the owner chain correctly.
- Project-level `totalCapitalAtRisk` dedups across the N rows via `resolveAddr` in `computeAdminTotals`, so shared-impl fan-out never inflates the aggregate — only the per-admin attribution is corrected.

Entries at unique-impl addresses (most of the codebase) pass through unchanged: `implToProxies[IMPL].size == 1` so the fan-out expands to a single proxy row. Full verification across 12 projects in [docs/developers/designs/shared-impl-fan-out.md](../designs/shared-impl-fan-out.md).

### Upgrade Function Detection

Upgrade functions (`upgradeTo`, `upgradeToAndCall`, `proxy__upgradeTo`, `proxy__upgradeToAndCall`, `upgradeBeacon`) replace the entire contract implementation, giving the caller arbitrary control over every function on the contract. Standard BFS would only follow edges from the upgrade function itself — which misses the point.

`isUpgradeFunction(functionName)` is exported from `types.ts`. When `traverseForward()` starts from an upgrade function, it seeds the BFS queue with **every** source function on the contract, correctly modelling that a new implementation can execute any code path. The same pattern applies in `traverseWithPaths()` for function-level analysis.

An `isUpgrade` flag flows through `FunctionCapitalAnalysis` → `AdminFunctionEntry` → `CompiledAdminFunction` so both protocolbeat and defiscan-frontend can render an "UPGRADE" badge next to upgrade function names.

## Review Builder

The Review Builder stores content across **three sibling files** per project:

- **`review-config.json`** — Protocol metadata, entity descriptions for admins/dependencies/fund-holding contracts, section content
- **`resources.json`** — Resources, audits, and lines of code
- **`governance.json`** — Governance configuration

Each file has its own backend CRUD module under `packages/l2b/src/implementations/discovery-ui/defidisco/` (`reviewConfig.ts`, `resources.ts`, `governance.ts`) with legacy-fallback reads that migrate any inline fields out of `review-config.json` on first write. The split exists specifically so automated review regeneration can safely wipe and rewrite `review-config.json` without touching resources or governance.

### `review-config.json` — Data Structure

```json
{
  "version": "1.0",
  "lastModified": "2026-02-18T10:30:00.000Z",
  "publishedAt": "2025-09-30T15:00:00.000Z",
  "protocolSlug": "liquity-v2",
  "protocolName": "Liquity V2",
  "tokenName": "BOLD",
  "chain": "Ethereum",
  "projectType": "lending",
  "description": "Liquity V2 is an immutable borrowing protocol...",
  "admins": {
    "eth:0x1234...": { "name": "Core Team Multisig", "description": "A 3-of-5 Gnosis Safe..." }
  },
  "dependencies": {
    "eth:0x5678...": { "name": "Chainlink ETH/USD Feed", "description": "Price feed..." }
  },
  "funds": {
    "eth:0x9abc...": { "name": "Treasury", "description": "Main protocol treasury..." }
  },
  "sections": { "codeAndAudits": { "title": "Code & Audits", "subsections": [] } },
  "dataKeys": {}
}
```

### Key Types

- `ReviewProjectType`: `'stablecoin' | 'lending' | 'dex' | 'bridge' | 'derivatives' | 'yield' | 'liquid-staking' | 'cdp' | 'other'`
- `EntityDescription`: `{ name?, description }` — used for admins, dependencies, and funds
- `ResourceType`: `'frontend' | 'website' | 'docs' | 'source-code' | 'github' | 'x' | 'license' | 'defiscan-v1' | 'other'`
- `ResourceEntry`: `{ url, type, label?, frontendSubtype?, licenseScope? }`
- `AuditEntry`: `{ url, author, date, scope?, bounty? }`

### API Endpoints

- `GET`/`PUT /api/projects/:project/review-config`
- `PUT /api/projects/:project/review-config/entity` — partial update for a single admin/dependency/funds entry
- `GET`/`PUT /api/projects/:project/resources`
- `GET`/`PUT /api/projects/:project/audits`
- `GET`/`PUT /api/projects/:project/governance`
- `POST /api/projects/:project/count-lines-of-code` — recomputes LoC and persists to `resources.json`

### Timestamps (three-timestamp model)

`CompiledReview` carries three distinct timestamps. They answer three different questions and must not be collapsed into one.

| Field          | Question answered                                   | Source                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publishedAt`  | When was this review first published?               | Set once, the first time `review-config.json` is created. Preserved forever across every subsequent write.                                                                                                  |
| `lastModified` | When did a researcher last edit review content?     | Max of `review-config.json.lastModified`, `resources.json.lastModified`, and the filesystem mtime of `governance.json`.                                                                                     |
| `compiledAt`   | How fresh is the on-chain data in this review?      | `discovered.json.timestamp × 1000` — the Unix-seconds stamp the discovery engine writes at the top of its output. **Not** wall-clock compile time.                                                          |

**Why the split**: before this model every frontend timestamp was `compiledAt: new Date().toISOString()` set at compile time, which bumped on every recompile — including monitor cycles that found no diff and researcher edits that didn't touch on-chain state. That made "Updated X minutes ago" meaningless. Splitting into three fields lets the hero card say "updated by a researcher", the code section say "on-chain data as of", and the landing page rank "recently edited" protocols correctly.

**Where each field is set**:

- `publishedAt` — `writeReviewConfig` reads the existing file on every save and carries the old `publishedAt` forward; if absent, it falls back to `lastModified`, then to `new Date().toISOString()`. The `/generate-review` skill bypasses this API chokepoint (it writes via the `Write` tool directly after moving the old file to `/tmp`), so the skill itself extracts `publishedAt` via `jq` into `/tmp/review-config-$0-publishedAt.txt` before the move and re-emits it in the freshly generated JSON.
- `lastModified` — bumped by `writeReviewConfig` (researcher saves from the Review Builder), `updateResources`/`updateAudits` via `writeResourcesFile(..., { bumpLastModified: true })`, and any write to `governance.json` (mtime is the signal). **Not bumped by `updateLinesOfCode`**, which calls `writeResourcesFile(..., { bumpLastModified: false })` and preserves the existing value — LoC is a compile-time side effect, not a researcher edit.
- `compiledAt` — computed at the `reviewCompiler.buildCompiledReview` return site from `discovery.timestamp ?? 0`. A researcher-triggered recompile that doesn't run a fresh discovery cycle keeps this field frozen. Only a monitor discovery run (or a manual `l2b discover`) bumps it.

**Frontend consumers**:

- `HeroSection` "Latest activity" → newest `activity[].timestamp` (hidden when no events). Not from any of the three compiled timestamps.
- `TimestampsFooter` (rendered as the final section of `ReportView`, below Protocol Activity) → three pills side-by-side: Published (`publishedAt`, with `(last modified <date>)` parenthetical appended from `lastModified`) / Latest activity (newest `activity[].timestamp`, renders "Not monitored" when empty) / On-chain data (`compiledAt`)
- `ActivityView` "Last Verified" → `compiledAt` (semantically matches: "the last time we verified on-chain state")
- `LandingPage` "recently updated" ordering → `lastModified`
- Gallery cards use `activity[].timestamp` (via the shared `getLatestActivityTimestamp` helper in `pages/review/views/activityTimestamp.ts`) for the "Last Activity" subtext on each card. The previous UPDATED status badge (< 7 days) was removed — the gallery and hero now render a `VERIFIED` / `UNVERIFIED` pill driven by `CompiledReview.verified` instead.

**Schema notes**:

- `ReviewConfig.publishedAt?: string` is **optional** on the type for backwards compatibility, but `getReviewConfig` backfills it to `lastModified` on read, so in-memory instances always have a value.
- `ResourcesFile.lastModified?: string` is also optional — legacy `resources.json` files that predate this model return `undefined` from `getResourcesLastModified`, at which point the compiler falls back to `reviewConfig.lastModified`. The first researcher edit stamps the field.
- `governance.json` has no schema change — we use filesystem mtime because it has no compile-time mutation path, so mtime cleanly tracks researcher edits.

### Verified / Unverified status

Reviews carry a researcher-attestation flag that drives the `VERIFIED` / `UNVERIFIED` pill on Gallery cards and the report Hero:

- `ReviewConfig.verified?: boolean` — optional in the type. **Missing field reads as `true`** (legacy reviews were researcher-curated). New AI-generated reviews must explicitly write `false`.
- `CompiledReview.verified: boolean` — sourced as `reviewConfig.verified ?? true` in `buildCompiledReview`. Mirrored into `ProtocolSummary.verified` in `index.json` by `compile-data.ts` so Gallery filtering and the pill render without loading every full review.
- The frontend `StatusPill` (`pages/review/views/StatusPill.tsx`) is the single place colors and labels live; it has two variants (`'card'` for Gallery, `'hero'` for the report hero).

**Lifecycle rules**:

1. **First-time creation** (no prior `review-config.json`): the `/generate-review` skill writes `verified: false`. The protocol enters the system as a draft awaiting researcher review.
2. **Regeneration**: the skill **preserves** the prior value via the out-of-band `/tmp/review-config-$0-verified.txt` file (the existing review-config is moved aside before generation, so the field has to be captured separately). Re-running the skill on a Verified protocol keeps it Verified.
3. **Researcher edits via the editor panels**: do NOT change `verified`. `writeReviewConfig` reads the existing file and copies the field over when the incoming payload doesn't include it, so a description tweak doesn't accidentally re-flip the flag. Only an explicit toggle does.
4. **Explicit toggle**: the **Mark as Verified / Mark as Unverified** button in `TerminalExtensions` (protocolbeat) reads the current config via `getReviewConfig`, flips `verified`, and PUTs the full config through the same `updateReviewConfig` endpoint used by the editors. No separate API.

The previous `ACTIVE` / `UPDATED` status (driven by a 7-day window on the newest activity event) was abandoned with this change. `getLatestActivityTimestamp` is still used for the "Last Activity" subtext on Gallery cards and the hero/footer "Latest activity" lines — those are independent informative timestamps and unaffected.

### Resources

Resources (frontends, docs, GitHub, X, source code, licenses, DeFiScan V1 reviews, other) are stored in `resources.json` as a flat array. The file uses a wrapper object `{ resources, audits, linesOfCode? }` — legacy bare arrays are read transparently and migrated on first write. Each add/edit/delete auto-saves immediately (the Resources editor owns its own React Query and does not go through the Review Builder's Save button).

### Audits & Bug Bounties

Security audits and bug bounty programs share the same `AuditEntry` shape inside `resources.json`:

- `url`: official link to the audit report or bounty page
- `author`: auditing firm (e.g. `"Trail of Bits"`) or bounty platform (e.g. `"Immunefi"`)
- `date`: `"YYYY-MM"` or `"YYYY-MM-DD"`
- `scope`: short description (e.g. `"Core contracts"`, `"Bug Bounty Program"`)
- `bounty`: max USD payout for bug bounty entries (e.g. `500000` = $500K)

Bug bounty entries should always be separate rows — never merge bounty info into an audit entry. The max `bounty` across all entries is displayed as the "Bug Bounty" stat in the public frontend's Source Code section.

### Lines of Code

The LoC metric is computed by `countLinesOfCode.ts` using **declaration-level deduplication**. Every flattened Solidity file under `.flat/` is parsed with a brace-depth tracker that extracts top-level `library`, `contract`, `abstract contract`, and `interface` blocks. Each declaration is counted once by name across all files.

This is necessary because flattened files inline shared libraries (OpenZeppelin's `Address`, etc.) into every contract, causing naive line counting to overcount by 2–3x. Per-file dedup by source hash doesn't fix this either, because different contracts genuinely share inlined libraries — only declaration-level dedup removes the double-counting.

- **Storage**: `linesOfCode?: number` on `resources.json`, and `totals.linesOfCode` on `compiled-review.json`
- **Auto-run**: `reviewCompiler.compile()` runs the counter inline (failure is non-fatal; a warning is logged and the field is left undefined)
- **Manual recount**: the "Count Lines of Code" button in the terminal panel, or `POST /api/projects/:project/count-lines-of-code`
- **Frontend display**: `CodeQualitySection.tsx` in defiscan-frontend renders `{count.toLocaleString()} LoC` (or a muted `—` when undefined)

### Source Code Coverage

`totals.coverage` and `totals.verifiedContractCount` on `compiled-review.json` report the share of protocol contracts with Etherscan-verified source. Computed in `reviewCompiler.computeCoverage(discovery)` by walking `discovered.json.entries`, excluding EOAs, and treating an entry as verified when `entry.unverified !== true`. `coverage` is a rounded 0–100 percentage; a project with no contracts yields `0`. Rendered in `CodeQualitySection.tsx` as a percentage plus a proportionally filled progress bar.

## Governance

Governance configuration lives in `governance.json` — a sibling of `review-config.json` — so that regenerating the review never touches it.

```typescript
interface GovernanceConfig {
  framework: string                // e.g. "Compound Governor Bravo"
  voteExecution: 'onchain' | 'offchain'
  votingUnit: string               // e.g. "COMP token"
  proposalRequirements: string     // who can submit proposals
  votingProcess: string            // 1–2 sentences, ≤150 chars
  proposalPeriod: GovernanceDuration
  executionDelay: GovernanceDuration
}

type GovernanceDurationUnit = 'seconds' | 'blocks' | 'minutes' | 'hours' | 'days'

type GovernanceDuration =
  | { kind: 'fieldRef'; ref: { contractAddress: string; fieldName: string; unit?: GovernanceDurationUnit } }
  | { kind: 'fixed'; value: string }
  | { kind: 'none' }
```

**`fieldRef` durations** are resolved against `discovered.json` numeric fields at compile time — the same mechanism as function delays. This keeps on-chain governance parameters (Timelock delays, Governor voting periods) in sync with reality. Use `fixed` for free text like `"~3 days (configurable)"` when there is no on-chain source, and `none` for N/A.

**`unit`** describes how the raw on-chain value is converted to seconds. Default is `seconds`. Factors: `seconds`=1, `blocks`=12 (Ethereum block time), `minutes`=60, `hours`=3600, `days`=86400. Use `blocks` for Compound/OZ Governor `votingPeriod` / `votingDelay` — their on-chain values are block counts, not seconds. The unit is input-only: it never appears on `CompiledGovernanceDuration`, and downstream consumers only see the converted seconds.

**Backend**: `governance.ts` handles CRUD with a legacy fallback that reads from `review-config.json.governance` for old configs and strips the legacy key on the next write. `governanceCompiler.ts` resolves field refs via `resolveDelayFromDiscovered()` (shared with function-mitigation delays) and multiplies by the unit factor before emitting the compiled value.

**Endpoints**: `GET`/`PUT /api/projects/:project/governance`.

**Frontend**: `ReviewGovernanceEditor.tsx` is self-contained — it owns its own React Query and does not plumb through `ReviewConfig`. `ReviewConfig` intentionally has no `governance` field. The editor's Unit dropdown must stay in sync with `governanceCompiler.ts`'s `unitToSecondsFactor`.

## Review Compiler

`reviewCompiler.ts` is a thin assembly layer. It calls `ProjectAnalysis` internally (same process, no HTTP), overlays human-written descriptions and sibling data (resources, audits, governance, activity feed), and writes `compiled-review.json` — a self-contained artifact that the public frontend renders without further joining.

- **Location**: `packages/l2b/src/implementations/discovery-ui/defidisco/reviewCompiler.ts`
- **Endpoint**: `POST /api/projects/:project/compile-review`
- **Bulk endpoint**: `POST /api/compile-all-reviews` — compiles every DeFi project (used by the Home page button)
- **Guards**: compilation is skipped silently if `review-config.json` or `call-graph-data.json` is missing
- **Timestamps**: the compiler assembles `publishedAt` / `lastModified` / `compiledAt` at the `buildCompiledReview` return site. `compiledAt` is sourced from `discovered.json.timestamp` (not `new Date()`), so researcher-triggered recompiles without a fresh discovery run keep it frozen. See [Timestamps](#timestamps-three-timestamp-model) for the full model.
- **Template variables**: `{{variableName}}` in descriptions is resolved against `dataKeys` at compile time
- **Cross-entity totals**: `adminTotals` and `dependencyTotals` carry deduplicated capital (each contract counted at most once, using `Math.max`) — these remain the canonical cross-admin / cross-dependency aggregates produced by the compiler. **`AdminsSection.tsx` does NOT use `review.adminTotals` for its "Impacted TVS" headline anymore.** It computes a per-admin sum (`Σ totalReachableCapital + totalReachableTokenValue`) over the *active, non-governance* admins that the section actually displays. Reason: `adminTotals` is computed across the full admin set including governance-tagged admins, but the Admins section explicitly filters those out for display, so the deduplicated total over-counts relative to what the user sees on screen. The trade-off: the per-admin sum can over-report when two displayed admins share reachable contracts (no cross-admin dedup at this scope). This is an accepted accuracy trade-off — the headline stays consistent with the displayed admin set; cross-admin dedup at the governance-excluded scope would require a separate compiler-side aggregate, which we have not yet built. Other sections (key findings, gallery cards, landing page) continue to use `adminTotals` / `dependencyTotals` as before.
- **Mitigations**: each compiled function carries `mitigations?: Mitigation[]` resolved by `ProjectAnalysis.getMitigationsForOwner()` (direct + transitive). The compiler passes them through as-is. Mitigations with an `impactCap` have their `impactCapUsd` pre-resolved
- **Impact caps**: `CompiledReachableContract.effectiveCapUsd?: number` is set during capital analysis. Frontend fund sums apply `Math.min(fundsUsd, effectiveCapUsd)` per reachable contract. Unified shape `{ value, unit, multiplier? }` — `value` is hardcoded|fieldRef, `unit` is `usd`|`scaler{factor}`|`token{tokenAddress}`, `multiplier` is a decimal (default 1). Examples: hardcoded USD `{ value:{mode:'hardcoded',amount:5e6}, unit:{kind:'usd'} }`; hardcoded 1M ZCHF priced via funds-data `{ value:{mode:'hardcoded',amount:1e6}, unit:{kind:'token',tokenAddress:ZCHF} }`; 2% of UNI supply `{ value:{mode:'fieldRef',contractAddress:UNI,fieldName:'totalSupply'}, unit:{kind:'token',tokenAddress:UNI}, multiplier:0.02 }`. Legacy shapes accepted via `normalizeImpactCap()` for backward compat

If admin or dependency data needs to change, modify `ProjectAnalysis` — not the compiler.

### Mitigations Display (public frontend)

- **`MitigationBadge`** renders a single mitigation as a colored pill: `delay` (cyan, formatted duration), `valueRange` (indigo, min/max), `relativeValue` (amber, max change %), `other` (gray, truncated description or `label`). Capped mitigations additionally render an emerald "$XM Max Impact" badge.
- **`MitigationsSummary`** is a responsive overflow component for table cells — it measures available width via `ResizeObserver` and renders as many badges as fit, with a `+N` indicator. Only works inside `<table>` cells.
- **Report card inline badges** — Admin and dependency cards on the Report view render mitigation badges inline after the entity name via `aggregateMitigationsByImpact`. Because report cards use `<button>` elements (not table cells), they cannot use `MitigationsSummary`.
- **`aggregateMitigationsByImpact()` (canonical entity-level)** in `shared.tsx` is the helper used by every entity-level surface (`AdminCards`, `AdminsSection`, `DependencyCards`, `DependenciesSection`, and `MitigationsSummary` itself). It computes each function's TVS impact (direct + per-reachable-contract `min(usd, effectiveCapUsd)`), drops mitigations whose only source functions all evaluate to $0 impact, dedupes the survivors via `mitigationDedupKey`, and sorts by descending max source-function impact.
- **`deduplicateMitigations()` (plain dedup)** in `shared.tsx` is the same dedup over `mitigationDedupKey` without the impact filter — kept for the few non-aggregated call sites that already operate in a per-function context.
- **`mitigationDedupKey(m)`** is the canonical visible-identity key used by both helpers above. Mirrors what `MitigationBadge` paints: `label:<label>` if a label exists, otherwise `delay:<seconds>` / `valueRange:<min>:<max>:<unit>` / `relativeValue:<maxChangePercent>` / `other:<description>`. **`scopedTo` is intentionally excluded** — scope only appears in the tooltip, never on the badge itself, so two same-shape mitigations scoped to different admins now collapse to one badge (previous behavior preserved them as separate badges, which double-counted visually).

### Key Findings

`getKeyFindings()` in `src/utils/keyFindings.ts` generates info cards on the Report view. Each finding is produced by a self-contained detector in the `DETECTORS` array (`detectImmutability`, `detectEOAs`, `detectMultisigs`, `detectTotalValueSecured`, `detectDependencies`, `detectMitigations`) — add a new finding type by writing a new detector and appending it to the array. Shared helpers (`isProtocolCodeImmutable`, `collectMitigations`, `deduplicateMitigations`, `formatMitigationTypeList`) live in the same file.

- **Mitigations** — shown when any admin or dependency function carries mitigations. Reports coverage (all / some) and distinct mitigation type labels (Timelocks, Value Ranges, Relative Value Caps, Other Constraints)
- **TVS (Total Value Secured)** — replaces the old TVL-only finding. Title is the combined TVS (e.g. "$220M TVS"). Detail text breaks the value down into TVL + token market cap, or either one alone. `TVS = totalCapitalAtRisk + (totalTokenValue ?? totalTokenValueAtRisk)`

## Radar Scoring

`deriveRadarData(review)` in `packages/defiscan-frontend/src/utils/radar.ts` derives the five-axis radar chart shown on the Report hero and Gallery cards from a `CompiledReview`. Each axis is scored 0–100 — every axis can reach a perfect 100 in the best case.

Axes: `ADMIN CONTROL`, `DEPENDENCIES`, `ACCESS`, `VERIFIABILITY`, `GOVERNANCE`.

### ADMIN CONTROL

Continuous per-admin risk model — no discrete tiers. Admin types `Immutable` (hardcoded protocol-internal callers — function callers fixed at deploy time, not upgradeable, no key-holder) and `Revoked` (ownership renounced to `0x0`) are filtered out by `hasMeaningfulImpact` — they aren't trust-risk admins and don't contribute to the score. Only the remaining admins with reachable impact ≥ `DUST_USD` ($1) are considered; if none, score is **100**. This also means fully-immutable protocols (Liquity v2, Uniswap v2, Aerodrome, etc.) correctly score 100 on this axis.

For each impacting admin:

1. **Effective impact** — sum each function's impact (`directFundsUsd + directTokenValueUsd + Σ min(rc.usd, rc.effectiveCapUsd)` over `fundsAtRisk` reachable contracts), each attenuated by that function's own delay mitigation. `functionDelaySeconds(f)` takes the **shortest** `delaySeconds` across the function's `delay` mitigations (fastest path wins). `delayAttenuation`: `≥7d → ×0`, `≥3d → ×0.4`, `≥1d → ×0.7`, else `×1`. The per-function sum is capped at the admin's deduplicated `totalReachableCapital + totalReachableTokenValue` to avoid double-counting shared reachable contracts.
2. **Risk multiplier** (`adminRiskMultiplier`) — "how many independent keys must be compromised": `EOA`/`EOAPermissioned` → **1.0**; `Multisig` with threshold `T` → `max(0.35, 1 − 0.15·(T−1))` (T1→1.0, T2→0.85, T3→0.70, T4→0.55, T5→0.40, T6+→0.35); `Multisig` with no parsed threshold → **0.7**; any other contract type → **0.5**. A 1/N multisig anchors at 1.0, same as an EOA.
3. **Per-admin risk** = `riskMultiplier · fundShare`, where `fundShare = min(1, effectiveImpact / TVS)` (`TVS = totalCapitalAtRisk + totalTokenValue`; if TVS is `0`, share is 1 when impact > 0 else 0).

The score is set by the **single worst admin**: `score = round(100 · (1 − max(adminRisk_i)))`. Risks are not combined across admins — capital analysis over-flares (many admins each show 100% of TVS reachable), so any cross-admin combination (`1 − Π(1 − riskᵢ)`, decaying tails, etc.) would over-penalise multi-admin protocols on what is largely a data artifact. Until over-flare is addressed, the worst admin is the only honest signal. A worst-case admin (EOA, 100% of TVS, no delay) lands at **0**; a 7-day timelock on every fund path lifts an otherwise-maximal admin back to **100**.

The multisig threshold and size come from structured fields on `CompiledAdmin` — `multisigThreshold` (`values.$threshold`) and `multisigSize` (`values.$members.length`) — populated by `reviewCompiler` straight off the Gnosis Safe discovery entry, not parsed from the display name (which researchers can override).

### DEPENDENCIES

Worst-exposure driven (`computeDependencies`). No dependencies → **100**.

1. **Group by `entity`** (fall back to address when untagged) — depending on a protocol with N contracts is one dependency risk, not N. Drop entries with impact below `DUST_USD` ($1).
2. **Within an entity, exposure = `min(1, Σ contract TVS shares)`** — an entity's contracts cover disjoint capital (losing the entity loses all of them), so contract shares are additive, capped at the whole TVS. Per-contract share = `(totalFundsAtRisk + totalTokenValueAtRisk) / TVS` (`TVS = totalCapitalAtRisk + totalTokenValue`; if TVS is `0`, share is 1).
3. `worst` = highest entity exposure. `tail` = `Σ(all entity exposures) − worst`.
4. **`score = clamp(0, 100, 100·(1 − 0.65·worst) − 7.5·√tail)`**

The single worst entity is the primary signal — one entity that can touch most of the TVL *defines* the dependency risk. `DEP_K_WORST = 0.65` caps a fully-exposed protocol at `35` before any tail. `DEP_K_TAIL = 7.5` applies a concave (`√`) penalty for every other exposed entity, so dependency-heavy protocols degrade smoothly instead of cratering to 0. Low-impact dependencies barely move the score (a protocol whose worst entity touches 30% of TVS with a negligible tail scores ~79).

### ACCESS

Count of `resources[].type === 'frontend'`: `0 → 20`, `1 → 50`, `2–3 → 75`, `4+ → 100`.

### VERIFIABILITY

Additive, four components, total clamped to 100 and rounded.

| Component | Weight | Tiers |
|---|---|---|
| **Coverage** | 70 | Linear: `(coverage / 100) · 70` (so `100% → 70`, `90% → 63`, `50% → 35`, `0% → 0`). `totals.coverage` is stored as a percentage `0–100`. **Missing → 56** (neutral fallback of `80% · 0.7` when `totals.coverage` is `undefined`, distinct from a real `0`) |
| **Audits** | 10 | `0 → 0`, `1 → 4`, `2 → 7`, `3 → 9`, `4+ → 10` |
| **LoC** (inverse — smaller = more auditable) | 10 | `≤5k → 10`, `≤10k → 8`, `≤20k → 5`, `≤50k → 3`, `>50k → 1`, **missing (0) → neutral 5** |
| **Bug bounty** (`max(audits[].bounty)` USD) | 10 | `$0 → 0`, `<$100k → 2`, `<$500k → 5`, `<$1M → 7`, `≥$1M → 10` |

Component weights sum to `70 + 10 + 10 + 10 = 100`.

### GOVERNANCE

Three branches:

1. **No `governance.json`** (`review.governance === undefined`) → neutral **55**. Distinguishes "researcher hasn't filled it in" from "filled in with constrained governance".
2. **Off-chain governance** (`voteExecution === 'offchain'`) → reuses **ADMIN CONTROL**. Off-chain votes (Snapshot, etc.) have no on-chain enforcement; the executing multisig signers can ignore the vote, so governance risk collapses into pure admin risk. Score equals `computeControl(review)`.
3. **On-chain governance** (`voteExecution === 'onchain'`) → continuous formula:
   - `worstShare` = highest governance admin's reachable capital share of TVS. Iterates `admins` filtered by `isGovernance && hasMeaningfulImpact` (so the `Immutable`/`Revoked` filter applies — fully-immutable protocols with governance have `worstShare = 0`). If no governance admin clears the filter, `worstShare = 0` → score **100** (governance has no fund reach).
   - `delay` = `durationSeconds(proposalPeriod) + durationSeconds(executionDelay)`.
   - `delayMitigation` is **linear** between 1 day and 10 days: `clamp(0, 1, 1 − (delay − 1d) / 9d)`. `≤1d` → factor `1` (full impact survives); `≥10d` → factor `0` (impact fully mitigated, users had time to exit).
   - `score = round(100 · (1 − worstShare · delayMitigation))`.

   So an on-chain governance with a 10+ day delay scores 100 regardless of fund reach; one with 100% reach and no delay scores 0. Linear in both axes between.

**Duration handling:** `durationSeconds(d)` resolves a `CompiledGovernanceDuration` to seconds:
- `kind === 'none'` → 0
- `kind === 'fieldRef'` → `d.seconds` when `d.resolved === true`, else 0
- `kind === 'fixed'` → parsed from `d.value` via regex `(\d+)\s*(second|minute|hour|day|week)s?` (all matches summed; handles strings like `"4 days"`, `"2 days 6 hours"`). Range syntax like `"3-14 Days"` is pre-normalised to the **lower bound** before the main parse (`"3-14 Days"` → `"3 Days"`) — the minimum is the worst-case guaranteed delay for risk scoring; crediting the upper bound would overstate enforcement.

**Why the off-chain → ADMIN CONTROL branch:** off-chain "delays" (a Snapshot voting period, a stated multisig cooldown) aren't enforceable — the actual control sits with whoever signs the executing transaction. Crediting an off-chain voting period as if it were a timelock would overstate enforcement, so off-chain governance is scored exactly as if the executing admins were the protocol's only governance — which they effectively are.

**Why no impact = 100 for on-chain governance:** if no `isGovernance`-tagged admin clears the `hasMeaningfulImpact` filter (so `worstShare = 0`), the formula yields `100 · (1 − 0)` = **100**. This rewards protocols where governance exists but is structurally constrained from touching user funds, and replaces the prior "fall back to all impacting admins" hack — which conflated regular admin risk with governance impact.
