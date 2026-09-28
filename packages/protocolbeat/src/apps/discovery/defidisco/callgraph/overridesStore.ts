// Ephemeral, view-only UI state for the callgraph walker: per-node researcher
// notes and which contracts are collapsed. Persisted to localStorage so a
// researcher's working view survives reloads.
//
// NOTE: edge add/remove rules are NO LONGER here — those are durable analysis
// inputs and live server-side in `call-graph-overrides.json` (see api.ts
// get/updateCallGraphOverrides + the backend callGraphOverrides.ts). This store
// is only for things that should NOT affect capital/governance analysis.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface OverridesState {
  /** Project slug → node id → free-form note. */
  notes: Record<string, Record<string, string>>
  /** Project slug → contract addresses collapsed into a single node. */
  collapsedContracts: Record<string, string[]>

  setNote: (project: string, nodeId: string, text: string) => void
  toggleCollapsed: (project: string, contract: string) => void
  setCollapsed: (project: string, contracts: string[]) => void
  resetProject: (project: string) => void
}

export const useCallgraphOverridesStore = create<OverridesState>()(
  persist(
    (set) => ({
      notes: {},
      collapsedContracts: {},

      setNote: (project, nodeId, text) =>
        set((s) => ({
          notes: {
            ...s.notes,
            [project]: { ...(s.notes[project] ?? {}), [nodeId]: text },
          },
        })),

      toggleCollapsed: (project, contract) =>
        set((s) => {
          const cur = new Set(s.collapsedContracts[project] ?? [])
          if (cur.has(contract)) cur.delete(contract)
          else cur.add(contract)
          return {
            collapsedContracts: {
              ...s.collapsedContracts,
              [project]: Array.from(cur),
            },
          }
        }),

      setCollapsed: (project, contracts) =>
        set((s) => ({
          collapsedContracts: { ...s.collapsedContracts, [project]: contracts },
        })),

      resetProject: (project) =>
        set((s) => ({
          notes: { ...s.notes, [project]: {} },
          collapsedContracts: { ...s.collapsedContracts, [project]: [] },
        })),
    }),
    // v3: edge rules moved server-side; this store no longer holds them.
    { name: 'callgraph-view-state-v3' },
  ),
)
