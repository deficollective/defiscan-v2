// Canonical visible-identity key for a mitigation — two mitigations that render
// as the same badge collapse to one. This MUST stay in sync with the frontend
// twin in defiscan-frontend/src/pages/review/views/explorer/shared.tsx
// (mitigationDedupKey) and protocolbeat's MitigationBadge. Descriptions and
// `scopedTo` only appear in tooltips, so they don't differentiate badges and
// are intentionally excluded from the key.
//
// Used to dedup function-intrinsic mitigations against edge-centric mitigations
// when both are merged for an owner (see projectAnalysis.getMitigationsForOwner),
// so an edge mitigation visibly identical to a function mitigation does not
// double-count. See docs/developers/designs/edge-centric-constraints.md.

import type { Mitigation, MitigationValue } from './types'

function displayMitigationValue(
  val: MitigationValue | string | undefined,
): string {
  if (val === undefined) return ''
  if (typeof val === 'string') return val
  if (val.mode === 'fieldRef') return val.fieldPath ?? ''
  return val.value ?? ''
}

export function mitigationDedupKey(m: Mitigation): string {
  if (m.label) return `label:${m.label}`
  switch (m.type) {
    case 'delay':
      return `delay:${m.delaySeconds ?? ''}`
    case 'valueRange':
      return `valueRange:${displayMitigationValue(m.valueRange?.min)}:${displayMitigationValue(
        m.valueRange?.max,
      )}:${m.valueRange?.unit ?? ''}`
    case 'relativeValue':
      return `relativeValue:${displayMitigationValue(m.relativeValue?.maxChangePercent)}`
    case 'other':
      return `other:${m.description}`
  }
}
