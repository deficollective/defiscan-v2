// Agent-proposed call-graph edge overrides, pending researcher review.
//
// SAFETY MODEL: suggestions live in their own file (`call-graph-suggestions.json`)
// that `buildEnhancedGraph` NEVER reads — so an unreviewed suggestion is inert by
// construction, not by convention. Agents append suggestions here (file write);
// only researcher acceptance promotes a rule into `call-graph-overrides.json`
// (the only file analysis consumes). The agent's reasoning is carried into the
// promoted rule's `note`, preserving provenance.

import type { DiscoveryPaths } from '@l2beat/discovery'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { EdgeOverrideRule } from './callGraphOverrides'
import {
  getCallGraphOverrides,
  updateCallGraphOverrides,
} from './callGraphOverrides'

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected'

export interface RuleSuggestion {
  id: string
  /** The exact rule the agent proposes (same union analysis would apply). */
  rule: EdgeOverrideRule
  /** Agent's explanation — shown in the inbox, carried into the rule note on accept. */
  reasoning: string
  status: SuggestionStatus
  /** Which agent/skill produced it. */
  createdBy?: string
  createdAt: string
  reviewedAt?: string
}

export interface CallGraphSuggestionsFile {
  version: string
  suggestions: RuleSuggestion[]
}

const EMPTY: CallGraphSuggestionsFile = { version: '1.0', suggestions: [] }

function suggestionsPath(paths: DiscoveryPaths, project: string): string {
  return path.join(paths.discovery, project, 'call-graph-suggestions.json')
}

export function getCallGraphSuggestions(
  paths: DiscoveryPaths,
  project: string,
): CallGraphSuggestionsFile {
  const filePath = suggestionsPath(paths, project)
  if (!fs.existsSync(filePath)) return { ...EMPTY }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as CallGraphSuggestionsFile
    return {
      version: parsed.version ?? '1.0',
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    }
  } catch (error) {
    console.error('Error parsing call-graph-suggestions.json:', error)
    return { ...EMPTY }
  }
}

function writeSuggestions(
  paths: DiscoveryPaths,
  project: string,
  file: CallGraphSuggestionsFile,
): void {
  const filePath = suggestionsPath(paths, project)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2))
}

/** Append a suggestion (used by the agent path / tests). */
export function addSuggestion(
  paths: DiscoveryPaths,
  project: string,
  input: { rule: EdgeOverrideRule; reasoning: string; createdBy?: string },
): RuleSuggestion {
  const file = getCallGraphSuggestions(paths, project)
  const suggestion: RuleSuggestion = {
    id: crypto.randomUUID(),
    rule: input.rule,
    reasoning: input.reasoning,
    status: 'pending',
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  }
  file.suggestions.push(suggestion)
  writeSuggestions(paths, project, file)
  return suggestion
}

/**
 * Promote a pending suggestion into the active overrides file (carrying the
 * reasoning into the rule's note) and mark it accepted. No-op if not pending.
 */
export function acceptSuggestion(
  paths: DiscoveryPaths,
  project: string,
  id: string,
): CallGraphSuggestionsFile {
  const file = getCallGraphSuggestions(paths, project)
  const s = file.suggestions.find((x) => x.id === id)
  if (!s) throw new Error(`Suggestion ${id} not found`)
  if (s.status === 'pending') {
    const overrides = getCallGraphOverrides(paths, project)
    const promoted: EdgeOverrideRule = {
      ...s.rule,
      note: s.rule.note ?? s.reasoning,
    }
    updateCallGraphOverrides(paths, project, [...overrides.rules, promoted])
    s.status = 'accepted'
    s.reviewedAt = new Date().toISOString()
    writeSuggestions(paths, project, file)
  }
  return file
}

export function rejectSuggestion(
  paths: DiscoveryPaths,
  project: string,
  id: string,
): CallGraphSuggestionsFile {
  const file = getCallGraphSuggestions(paths, project)
  const s = file.suggestions.find((x) => x.id === id)
  if (!s) throw new Error(`Suggestion ${id} not found`)
  if (s.status === 'pending') {
    s.status = 'rejected'
    s.reviewedAt = new Date().toISOString()
    writeSuggestions(paths, project, file)
  }
  return file
}

/** Drop suggestions by status (e.g. clear resolved ones from the inbox). */
export function clearSuggestions(
  paths: DiscoveryPaths,
  project: string,
  status?: SuggestionStatus,
): CallGraphSuggestionsFile {
  const file = getCallGraphSuggestions(paths, project)
  file.suggestions = status
    ? file.suggestions.filter((s) => s.status !== status)
    : []
  writeSuggestions(paths, project, file)
  return file
}
