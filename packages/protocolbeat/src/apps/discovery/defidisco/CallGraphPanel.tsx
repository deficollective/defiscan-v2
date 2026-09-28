// Replacement for the existing CallGraphPanel.tsx — delegates to the new
// visual graph view. Keep this file's exported name (`CallGraphPanel`) so the
// PanelId mapping in ProjectPage.tsx keeps working with no other changes.

import { CallGraphView } from './callgraph/view/CallGraphView'

export function CallGraphPanel(): JSX.Element {
  return <CallGraphView />
}
