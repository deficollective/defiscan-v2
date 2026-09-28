import type {
  CompiledAdmin,
  CompiledAdminFunction,
  CompiledGovernanceDuration,
  CompiledReview,
} from '../types'

const DAY = 86_400
const HOUR = 3_600

// Trace capital under $1 USD is ignored — upstream capital math occasionally
// leaks sub-cent floating-point dust (e.g. Lido Oracle Committee EOAs show
// ~$3e-5 reachable capital each), which should not trigger EOA detection or
// inflate governance impact share.
const DUST_USD = 1

function adminImpact(a: CompiledAdmin): number {
  return (a.totalReachableCapital ?? 0) + (a.totalReachableTokenValue ?? 0)
}

// `Immutable` callers are hardcoded into the bytecode (protocol-internal
// contract → contract calls); `Revoked` is ownership renounced to the zero
// address. Neither has a key-holder, neither is upgradeable, neither can
// act adversarially — so they are not trust-risk admins and should not
// drive ADMIN CONTROL or governance-impact scoring.
const NON_RISK_ADMIN_TYPES: ReadonlySet<string> = new Set([
  'Immutable',
  'Revoked',
])

function hasMeaningfulImpact(a: CompiledAdmin): boolean {
  if (NON_RISK_ADMIN_TYPES.has(a.adminType)) return false
  return adminImpact(a) >= DUST_USD
}

function computeVerifiability(review: CompiledReview): number {
  const { totals, audits = [] } = review
  const coverage = totals.coverage
  const loc = totals.linesOfCode ?? 0
  const auditCount = audits.length
  const maxBounty = audits.reduce((m, a) => Math.max(m, a.bounty ?? 0), 0)

  // Linear in coverage: 100% → 70, 0% → 0. `totals.coverage` is a
  // percentage (0–100), not a fraction. Missing data falls back to a
  // neutral 80% (≈56) so legacy reviews without `totals.coverage`
  // aren't punished.
  const coverageScore = ((coverage ?? 80) / 100) * 70

  const auditScore =
    auditCount === 0
      ? 0
      : auditCount === 1
        ? 4
        : auditCount === 2
          ? 7
          : auditCount === 3
            ? 9
            : 10

  const locScore =
    loc === 0
      ? 5
      : loc <= 5000
        ? 10
        : loc <= 10000
          ? 8
          : loc <= 20000
            ? 5
            : loc <= 50000
              ? 3
              : 1

  const bountyScore =
    maxBounty === 0
      ? 0
      : maxBounty < 100_000
        ? 2
        : maxBounty < 500_000
          ? 5
          : maxBounty < 1_000_000
            ? 7
            : 10

  return Math.min(
    100,
    Math.round(coverageScore + auditScore + locScore + bountyScore),
  )
}

const FIXED_UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
}

function parseFixedDuration(value: string | undefined): number {
  if (!value) return 0
  // Range syntax like "3-14 Days" expresses a min/max window — use the
  // lower bound, which is the worst-case guaranteed delay for risk scoring.
  // Pre-normalise "N1-N2 unit" → "N1 unit" before the main parse.
  const normalized = value.replace(
    /(\d+(?:\.\d+)?)\s*-\s*\d+(?:\.\d+)?(\s*(?:second|minute|hour|day|week)s?)/gi,
    '$1$2',
  )
  const re = /(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?/gi
  let total = 0
  for (const m of normalized.matchAll(re)) {
    const n = Number.parseFloat(m[1])
    const factor = FIXED_UNIT_SECONDS[m[2].toLowerCase()]
    if (!Number.isNaN(n) && factor) total += n * factor
  }
  return total
}

function durationSeconds(d: CompiledGovernanceDuration | undefined): number {
  if (!d) return 0
  if (d.kind === 'none') return 0
  if (d.kind === 'fieldRef')
    return d.resolved && typeof d.seconds === 'number' ? d.seconds : 0
  if (d.kind === 'fixed') return parseFixedDuration(d.value)
  return 0
}

function computeGovernance(review: CompiledReview): number {
  const { admins, totals, governance } = review

  // Without a documented governance process there's nothing to score —
  // return a neutral 55 (researcher hasn't filled in governance.json yet,
  // or the protocol genuinely has no governance layer). This is preferable
  // to either rewarding (95) or penalising (low) the absence.
  if (governance === undefined) return 55

  // Off-chain governance has no on-chain enforcement — Snapshot votes can
  // be ignored by the executing multisig signers, so governance risk
  // collapses into admin risk. Score it identically to ADMIN CONTROL.
  if (governance.voteExecution === 'offchain') {
    return computeControl(review)
  }

  // On-chain governance: worst governance contract's fund-impact share of
  // TVS, mitigated by the total proposal + execution delay (longer delay =
  // more time for users to exit).
  const tvs = totals.totalCapitalAtRisk + (totals.totalTokenValue ?? 0)
  const govAdmins = admins.filter(
    (a) => a.isGovernance && hasMeaningfulImpact(a),
  )
  let worstShare = 0
  for (const a of govAdmins) {
    const imp = adminImpact(a)
    const share = tvs > 0 ? Math.min(1, imp / tvs) : imp > 0 ? 1 : 0
    if (share > worstShare) worstShare = share
  }

  // Linear mitigation: ≤1 day → no mitigation (factor 1, full impact);
  // ≥10 days → full mitigation (factor 0, no impact); linear in between.
  const delay =
    durationSeconds(governance.proposalPeriod) +
    durationSeconds(governance.executionDelay)
  const delayMitigation = Math.max(
    0,
    Math.min(1, 1 - (delay - 1 * DAY) / (9 * DAY)),
  )

  const effectiveImpact = worstShare * delayMitigation
  return Math.round(100 * (1 - effectiveImpact))
}

// A timelock long enough to let users exit neutralises an admin action.
// Tiers express how much of the action's fund impact survives the delay.
function delayAttenuation(delaySeconds: number): number {
  if (delaySeconds >= 7 * DAY) return 0
  if (delaySeconds >= 3 * DAY) return 0.4
  if (delaySeconds >= 1 * DAY) return 0.7
  return 1
}

// Shortest delay gating a function's fund-impacting paths — an attacker takes
// the fastest route, so a single undelayed path means the function is undelayed.
function functionDelaySeconds(f: CompiledAdminFunction): number {
  const delays = (f.mitigations ?? [])
    .filter((m) => m.type === 'delay' && typeof m.delaySeconds === 'number')
    .map((m) => m.delaySeconds as number)
  return delays.length > 0 ? Math.min(...delays) : 0
}

function functionImpactUsd(f: CompiledAdminFunction): number {
  let impact = f.directFundsUsd + f.directTokenValueUsd
  for (const rc of f.reachableContracts) {
    if (!rc.fundsAtRisk) continue
    const raw = rc.fundsUsd + rc.tokenValueUsd
    impact +=
      rc.effectiveCapUsd !== undefined ? Math.min(raw, rc.effectiveCapUsd) : raw
  }
  return impact
}

// "How many independent keys must be compromised." EOA and a 1/N multisig
// both anchor at 1.0 (worst case); each extra required signer buys safety.
function adminRiskMultiplier(a: CompiledAdmin): number {
  if (a.adminType === 'EOA' || a.adminType === 'EOAPermissioned') return 1
  if (a.adminType === 'Multisig') {
    const t = a.multisigThreshold
    if (t === undefined || t < 1) return 0.7
    return Math.max(0.35, 1 - 0.15 * (t - 1))
  }
  return 0.5
}

function computeControl(review: CompiledReview): number {
  const { admins, totals } = review
  const tvs = totals.totalCapitalAtRisk + (totals.totalTokenValue ?? 0)

  const impacting = admins.filter(hasMeaningfulImpact)
  if (impacting.length === 0) return 100

  // Worst admin sets the score. Capital analysis over-flares — many admins
  // all show 100% of TVS reachable — so combining risks across admins isn't
  // meaningful yet; the single worst admin is the honest signal.
  let worstRisk = 0
  for (const a of impacting) {
    let effectiveImpact = 0
    for (const f of a.functions) {
      const raw = functionImpactUsd(f)
      if (raw <= 0) continue
      effectiveImpact += raw * delayAttenuation(functionDelaySeconds(f))
    }
    // Per-function sums can double-count shared reachable contracts — cap at
    // the admin's deduplicated reachable total.
    effectiveImpact = Math.min(effectiveImpact, adminImpact(a))

    const fundShare =
      tvs > 0
        ? Math.min(1, effectiveImpact / tvs)
        : effectiveImpact > 0
          ? 1
          : 0
    worstRisk = Math.max(worstRisk, adminRiskMultiplier(a) * fundShare)
  }

  return Math.round(100 * (1 - worstRisk))
}

// Dependency score is worst-exposure driven. DEP_K_WORST sets how hard a
// fully-exposed entity hits — it caps the score at 100·(1−DEP_K_WORST).
// DEP_K_TAIL is the concave penalty applied to every other exposed entity.
const DEP_K_WORST = 0.65
const DEP_K_TAIL = 7.5

function computeDependencies(review: CompiledReview): number {
  const { dependencies, totals } = review
  const tvs = totals.totalCapitalAtRisk + (totals.totalTokenValue ?? 0)

  // Group by entity (fall back to address when untagged) — depending on a
  // protocol with N contracts is one dependency risk, not N. Within an
  // entity the contracts cover disjoint capital (losing the entity loses
  // all of them), so exposure is the summed TVS share, capped at 1.
  const exposureByEntity = new Map<string, number>()
  for (const d of dependencies) {
    const impact = (d.totalFundsAtRisk ?? 0) + (d.totalTokenValueAtRisk ?? 0)
    if (impact < DUST_USD) continue
    const key = d.entity ?? d.address
    const share = tvs > 0 ? Math.min(1, impact / tvs) : 1
    exposureByEntity.set(
      key,
      Math.min(1, (exposureByEntity.get(key) ?? 0) + share),
    )
  }

  const shares = [...exposureByEntity.values()].sort((a, b) => b - a)
  if (shares.length === 0) return 100

  // The single worst entity defines the dependency risk; everything beyond
  // it is a concave (√) tail, so dependency-heavy protocols degrade smoothly
  // rather than cratering to 0.
  const worst = shares[0]
  const tail = shares.reduce((s, x) => s + x, 0) - worst
  const score = 100 * (1 - DEP_K_WORST * worst) - DEP_K_TAIL * Math.sqrt(tail)
  return Math.round(Math.max(0, Math.min(100, score)))
}

export function deriveRadarData(review: CompiledReview) {
  const { resources = [] } = review

  const frontendCount = resources.filter((r) => r.type === 'frontend').length

  const control = computeControl(review)
  const deps = computeDependencies(review)
  const access =
    frontendCount === 0
      ? 20
      : frontendCount === 1
        ? 50
        : frontendCount <= 3
          ? 75
          : 100
  const verifiability = computeVerifiability(review)
  const governance = computeGovernance(review)

  return [
    { axis: 'ADMIN CONTROL', value: control },
    { axis: 'DEPENDENCIES', value: deps },
    { axis: 'ACCESS', value: access },
    { axis: 'VERIFIABILITY', value: verifiability },
    { axis: 'GOVERNANCE', value: governance },
  ]
}
