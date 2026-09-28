import type { DiscoveryPaths } from '@l2beat/discovery'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { AuditEntry, ReviewConfig } from './types'

/**
 * Review integrity checks.
 *
 * The compiled review shows three dates (published, last modified, on-chain
 * data) and a verified badge. Each of them used to have a silent fallback:
 * a missing publishedAt turned into the last edit time, and a missing
 * verified flag turned into "verified". Both produced wrong public output
 * without anyone noticing. This module makes those cases explicit: it
 * resolves publishedAt from git history when the config lacks it, and it
 * returns a list of warnings that the compiler logs and includes in its
 * response, so a bad review cannot compile quietly.
 */

export interface IntegrityWarning {
  code:
    | 'MISSING_PUBLISHED_AT'
    | 'PUBLISHED_AFTER_MODIFIED'
    | 'FUTURE_TIMESTAMP'
    | 'PLACEHOLDER_TIMESTAMP'
    | 'MISSING_VERIFIED'
    | 'AUDIT_DATE_INVALID'
    | 'AUDIT_MISSING_AUTHOR'
    | 'UNRESOLVED_TEMPLATE'
    | 'DATA_KEY_UNUSED'
    | 'DATA_KEY_UNDEFINED'
    | 'SLUG_MISMATCH'
  message: string
}

export type PublishedAtSource = 'config' | 'git' | 'lastModified'

export interface ResolvedPublishedAt {
  value: string
  source: PublishedAtSource
}

/**
 * First commit that added review-config.json for this project, as an ISO
 * string, or undefined when git is unavailable or the file is untracked.
 */
export function gitFirstCommitDate(
  projectDir: string,
  fileName = 'review-config.json',
): string | undefined {
  try {
    if (!fs.existsSync(path.join(projectDir, fileName))) return undefined
    const out = execFileSync(
      'git',
      ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', fileName],
      { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    )
      .toString()
      .trim()
    if (!out) return undefined
    const lines = out.split('\n').filter(Boolean)
    const oldest = lines[lines.length - 1]
    const d = new Date(oldest)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  } catch {
    return undefined
  }
}

/**
 * publishedAt = when the review was first created. Order of preference:
 * 1. the explicit field in review-config.json,
 * 2. the git commit that added review-config.json,
 * 3. lastModified, as a last resort (and a warning is raised).
 */
export function resolvePublishedAt(
  paths: DiscoveryPaths,
  project: string,
  reviewConfig: Pick<ReviewConfig, 'publishedAt'>,
  lastModified: string,
): ResolvedPublishedAt {
  if (reviewConfig.publishedAt) {
    return { value: reviewConfig.publishedAt, source: 'config' }
  }
  const fromGit = gitFirstCommitDate(path.join(paths.discovery, project))
  if (fromGit) return { value: fromGit, source: 'git' }
  return { value: lastModified, source: 'lastModified' }
}

const ISO_DAY = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/
const ROUND_TIME = /T\d{2}:00:00(\.000)?Z$/

export interface IntegrityInput {
  project: string
  reviewConfig: Pick<
    ReviewConfig,
    'publishedAt' | 'verified' | 'protocolSlug' | 'dataKeys' | 'lastModified'
  >
  audits: AuditEntry[]
  compiled: {
    publishedAt: string
    lastModified: string
    compiledAt: string
    metadata?: { description?: string }
    admins?: { name?: string; description?: string }[]
    dependencies?: { name?: string; description?: string }[]
    funds?: { name?: string; description?: string }[]
  }
  publishedAtSource: PublishedAtSource
  now?: Date
}

/** Pure check. Returns an empty list when the review is consistent. */
export function checkReviewIntegrity(
  input: IntegrityInput,
): IntegrityWarning[] {
  const w: IntegrityWarning[] = []
  const now = input.now ?? new Date()
  const { reviewConfig, compiled } = input

  if (input.publishedAtSource !== 'config') {
    w.push({
      code: 'MISSING_PUBLISHED_AT',
      message:
        `review-config.json has no publishedAt. Using ${input.publishedAtSource === 'git' ? 'the first git commit of the file' : 'lastModified'} (${compiled.publishedAt}). ` +
        'Write the real first-publication time into review-config.json so it stops depending on history.',
    })
  }

  if (reviewConfig.verified === undefined) {
    w.push({
      code: 'MISSING_VERIFIED',
      message:
        'review-config.json has no verified field. It compiles as unverified. Set verified explicitly (false until a researcher signs off).',
    })
  }

  if (compiled.publishedAt > compiled.lastModified) {
    w.push({
      code: 'PUBLISHED_AFTER_MODIFIED',
      message: `publishedAt (${compiled.publishedAt}) is later than lastModified (${compiled.lastModified}).`,
    })
  }

  const limit = new Date(now.getTime() + 5 * 60_000).toISOString()
  for (const [name, value] of [
    ['publishedAt', compiled.publishedAt],
    ['lastModified', compiled.lastModified],
    ['compiledAt', compiled.compiledAt],
  ] as const) {
    if (value > limit) {
      w.push({
        code: 'FUTURE_TIMESTAMP',
        message: `${name} (${value}) is in the future.`,
      })
    }
  }

  for (const [name, value] of [
    ['publishedAt', reviewConfig.publishedAt],
    ['lastModified', reviewConfig.lastModified],
  ] as const) {
    if (typeof value === 'string' && ROUND_TIME.test(value)) {
      w.push({
        code: 'PLACEHOLDER_TIMESTAMP',
        message: `${name} (${value}) is a round hour, which usually means it was typed by hand. Use the real time.`,
      })
    }
  }

  const today = now.toISOString().slice(0, 10)
  for (const a of input.audits) {
    const label = a.url.split('/').pop() ?? a.url
    if (!a.author || !a.author.trim()) {
      w.push({
        code: 'AUDIT_MISSING_AUTHOR',
        message: `Audit ${label} has no author.`,
      })
    }
    if (!a.date || !ISO_DAY.test(a.date) || a.date > today || a.date < '2015') {
      w.push({
        code: 'AUDIT_DATE_INVALID',
        message: `Audit ${label} has date "${a.date}". Expected YYYY, YYYY-MM or YYYY-MM-DD, not in the future.`,
      })
    }
  }

  const texts: [string, string | undefined][] = [
    ['description', compiled.metadata?.description],
  ]
  for (const group of ['admins', 'dependencies', 'funds'] as const) {
    for (const e of compiled[group] ?? []) {
      texts.push([`${group}:${e.name ?? '?'}`, e.description])
    }
  }
  for (const [where, text] of texts) {
    if (!text) continue
    if (text.includes('{{') || text.includes('(N/A)')) {
      w.push({
        code: 'UNRESOLVED_TEMPLATE',
        message: `${where} still contains an unresolved value ("{{...}}" or "(N/A)").`,
      })
    }
  }

  const dataKeys = reviewConfig.dataKeys ?? {}
  const used = new Set<string>()
  const scan = (o: unknown): void => {
    if (typeof o === 'string') {
      for (const m of o.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1])
    } else if (Array.isArray(o)) o.forEach(scan)
    else if (o && typeof o === 'object')
      Object.values(o as Record<string, unknown>).forEach(scan)
  }
  const { dataKeys: _dk, ...rest } = reviewConfig as Record<string, unknown>
  scan(rest)
  for (const k of Object.keys(dataKeys)) {
    if (!used.has(k))
      w.push({
        code: 'DATA_KEY_UNUSED',
        message: `dataKeys.${k} is defined but never used.`,
      })
  }
  for (const k of used) {
    if (!(k in dataKeys))
      w.push({
        code: 'DATA_KEY_UNDEFINED',
        message: `{{${k}}} is used but not defined in dataKeys.`,
      })
  }

  if (
    reviewConfig.protocolSlug &&
    reviewConfig.protocolSlug !== input.project
  ) {
    w.push({
      code: 'SLUG_MISMATCH',
      message: `protocolSlug "${reviewConfig.protocolSlug}" differs from the project folder "${input.project}".`,
    })
  }

  return w
}
