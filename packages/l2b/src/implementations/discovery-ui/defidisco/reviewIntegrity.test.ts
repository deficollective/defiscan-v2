import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  checkReviewIntegrity,
  gitFirstCommitDate,
  resolvePublishedAt,
} from './reviewIntegrity'

const NOW = new Date('2026-09-28T12:00:00.000Z')

function base() {
  return {
    project: 'demo',
    reviewConfig: {
      publishedAt: '2026-05-13T11:17:10.000Z',
      lastModified: '2026-09-28T10:41:02.000Z',
      verified: false,
      protocolSlug: 'demo',
      description: 'TVS is {{tvs}}.',
      dataKeys: { tvs: 'v2score.inventory.admins.totalCapitalAtRisk' },
    },
    audits: [
      { url: 'https://x/a.pdf', author: 'Certora', date: '2025-12' },
      { url: 'https://x/b.pdf', author: 'Sigma Prime', date: '2023' },
    ],
    compiled: {
      publishedAt: '2026-05-13T11:17:10.000Z',
      lastModified: '2026-09-28T11:24:12.000Z',
      compiledAt: '2026-09-28T11:17:09.000Z',
      metadata: { description: 'TVS is $7.01B.' },
      admins: [{ name: 'A', description: 'ok' }],
    },
    publishedAtSource: 'config' as const,
    now: NOW,
  }
}

describe('checkReviewIntegrity', () => {
  it('returns no warnings for a consistent review', () => {
    assert.deepEqual(checkReviewIntegrity(base()), [])
  })

  it('flags a publishedAt that came from a fallback', () => {
    const i = base()
    i.reviewConfig.publishedAt = undefined as unknown as string
    i.publishedAtSource = 'lastModified'
    const codes = checkReviewIntegrity(i).map((w) => w.code)
    assert.ok(codes.includes('MISSING_PUBLISHED_AT'))
  })

  it('flags a missing verified field', () => {
    const i = base()
    const { verified: _v, ...withoutVerified } = i.reviewConfig
    i.reviewConfig = withoutVerified as typeof i.reviewConfig
    const codes = checkReviewIntegrity(i).map((w) => w.code)
    assert.deepEqual(codes, ['MISSING_VERIFIED'])
  })

  it('flags publishedAt after lastModified and future timestamps', () => {
    const i = base()
    i.compiled.publishedAt = '2026-09-28T11:30:00.000Z'
    i.compiled.compiledAt = '2027-01-01T00:00:00.000Z'
    const codes = checkReviewIntegrity(i).map((w) => w.code)
    assert.ok(codes.includes('PUBLISHED_AFTER_MODIFIED'))
    assert.ok(codes.includes('FUTURE_TIMESTAMP'))
  })

  it('flags hand-typed round timestamps', () => {
    const i = base()
    i.reviewConfig.publishedAt = '2026-05-12T19:00:00.000Z'
    i.compiled.publishedAt = i.reviewConfig.publishedAt
    const codes = checkReviewIntegrity(i).map((w) => w.code)
    assert.deepEqual(codes, ['PLACEHOLDER_TIMESTAMP'])
  })

  it('flags bad audit dates and missing authors', () => {
    const i = base()
    i.audits = [
      { url: 'https://x/c.pdf', author: '', date: '2026-13' },
      { url: 'https://x/d.pdf', author: 'Z', date: '2027-01' },
      { url: 'https://x/e.pdf', author: 'Y', date: 'Jan 2026' },
    ]
    const codes = checkReviewIntegrity(i).map((w) => w.code)
    assert.equal(codes.filter((c) => c === 'AUDIT_DATE_INVALID').length, 3)
    assert.equal(codes.filter((c) => c === 'AUDIT_MISSING_AUTHOR').length, 1)
  })

  it('flags unresolved template output and dataKey drift', () => {
    const i = base()
    i.compiled.admins = [{ name: 'A', description: 'cap is {{x}} and (N/A)' }]
    i.reviewConfig.description = 'uses {{missing}}'
    i.reviewConfig.dataKeys = { tvs: 'unused.path' }
    const codes = checkReviewIntegrity(i).map((w) => w.code)
    assert.ok(codes.includes('UNRESOLVED_TEMPLATE'))
    assert.ok(codes.includes('DATA_KEY_UNUSED'))
    assert.ok(codes.includes('DATA_KEY_UNDEFINED'))
  })

  it('flags a slug that differs from the folder', () => {
    const i = base()
    i.reviewConfig.protocolSlug = 'other'
    assert.deepEqual(
      checkReviewIntegrity(i).map((w) => w.code),
      ['SLUG_MISMATCH'],
    )
  })
})

describe('resolvePublishedAt', () => {
  it('prefers the config value', () => {
    const r = resolvePublishedAt(
      { discovery: '/nonexistent' } as never,
      'demo',
      { publishedAt: '2026-01-01T00:00:00.000Z' },
      '2026-02-01T00:00:00.000Z',
    )
    assert.deepEqual(r, { value: '2026-01-01T00:00:00.000Z', source: 'config' })
  })

  it('falls back to the first git commit, then to lastModified', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'))
    const projectDir = path.join(root, 'demo')
    fs.mkdirSync(projectDir)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    fs.writeFileSync(path.join(projectDir, 'review-config.json'), '{}')
    git('add', '.')
    execFileSync('git', ['commit', '-q', '-m', 'add'], {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-03-01T10:00:00Z',
        GIT_COMMITTER_DATE: '2026-03-01T10:00:00Z',
      },
    })
    assert.equal(gitFirstCommitDate(projectDir), '2026-03-01T10:00:00.000Z')
    const r = resolvePublishedAt(
      { discovery: root } as never,
      'demo',
      {},
      '2026-04-01T00:00:00.000Z',
    )
    assert.deepEqual(r, { value: '2026-03-01T10:00:00.000Z', source: 'git' })

    const untracked = path.join(root, 'nogit')
    fs.mkdirSync(untracked)
    const r2 = resolvePublishedAt(
      { discovery: root } as never,
      'nogit',
      {},
      '2026-04-01T00:00:00.000Z',
    )
    assert.deepEqual(r2, {
      value: '2026-04-01T00:00:00.000Z',
      source: 'lastModified',
    })
    fs.rmSync(root, { recursive: true, force: true })
  })
})
