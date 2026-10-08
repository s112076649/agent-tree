import type { RenderElement } from 'claude-code'

import type { ActivitySnapshot, AdvisorSnapshot, JevSnapshot, LogEntry, StatsSnapshot, TreeSnapshot } from '../../types'
import { advisorRows, renderAdvisorColumn } from './boxes/advisor-column'
import { boxCentres, isDrawnRunning, renderAgentsBox, renderAgentsRow } from './boxes/agents-row'
import { renderFan, renderTrunk } from './boxes/connectors'
import { jevBoxRows, renderJevBox } from './boxes/jev-box'
import { renderLegend } from './boxes/legend'
import { logRows, renderLogBox } from './boxes/log-box'
import { renderMainBox } from './boxes/main-box'
import { renderStatusRow } from './boxes/status-row'
import { renderUsageBox, usageRows } from './boxes/usage-box'
import { GAP, geometry, rowBudget } from './layout'
import type { Geometry, RowBudget } from './layout'
import type { Kit } from './theme'

/** Everything the pane draws: the five snapshots, the session log, the time durations run to, the animation frame, the rows the body shows. */
export type PaneData = {
  tree: TreeSnapshot
  stats: StatsSnapshot
  advisor: AdvisorSnapshot
  jev: JevSnapshot
  /** What each loop is doing right now (C7b): the main loop's phase, tool and time; the tools in flight. */
  activity: ActivitySnapshot
  /** The session log (C7d, PRD M-L7), oldest first: the log box draws the last lines that fit; the same lines wide and narrow. */
  log: readonly LogEntry[]
  now: number
  /** The `frame` state, 0 to 3: which spinner glyph a running box shows (PRD M-L4). */
  frame: number
  /** `scroll.bodyRows` of the Pane props: the boxes are fitted to it (layout.ts rowBudget); without it every row is drawn. */
  bodyRows?: number
}

/** The row budget of `data` at `geo`: what each box would draw (its rows at its text room), fitted to the body rows. */
export function paneBudget(data: PaneData, geo: Geometry): RowBudget {
  return rowBudget({
    geometry: geo,
    bodyRows: data.bodyRows,
    want: {
      jev: jevBoxRows(data, geo.columnInner, geo.variant === 'wide').length,
      advisor: advisorRows(data, geo.sideInner).length,
      usage: usageRows(data, geo.sideInner).length,
      log: logRows(data.log, geo.columnInner).length,
    },
    agentCount: data.tree.agents.length,
  })
}

/**
 * The wide pane (PRD M-L1, section 12): the legend; a row of the left column
 * (the main box, the trunk, the Jev box, the fan, the subagent boxes) and the
 * advisor column; the session log box and the usage box side by side; the
 * status row. While a subagent runs the fan carries the moving dot (C7b).
 */
function renderWide(els: Kit, data: PaneData, geo: Geometry, budget: RowBudget): RenderElement {
  const { Box } = els
  const centres = boxCentres(data.tree, geo, budget.agents)
  const view = { tree: data.tree, activity: data.activity, frame: data.frame, now: data.now }
  const hasBottom = budget.log > 0 || budget.usage > 0
  const dotFrame = data.tree.agents.some(isDrawnRunning) ? data.frame : undefined

  return (
    <Box flexDirection="column" width={geo.width}>
      {budget.legend ? renderLegend(els, geo.width) : null}
      <Box flexDirection="row" gap={GAP} alignItems="flex-start">
        <Box flexDirection="column" width={geo.column}>
          {renderMainBox(els, data, geo.column)}
          {budget.trunk ? renderTrunk(els, centres, geo.column) : null}
          {budget.jev > 0 ? renderJevBox(els, data, geo.column, budget.jev, true) : null}
          {budget.fan ? renderFan(els, centres, geo.column, dotFrame) : null}
          {renderAgentsRow(els, view, geo, budget.agents)}
        </Box>
        {budget.advisor > 0 ? renderAdvisorColumn(els, data, geo.side, budget.advisor) : null}
      </Box>
      {hasBottom ? (
        <Box flexDirection="row" gap={GAP}>
          {budget.log > 0 ? renderLogBox(els, data.log, budget.usage > 0 ? geo.column : geo.width, budget.log) : null}
          {budget.usage > 0 ? renderUsageBox(els, data, geo.side, budget.usage) : null}
        </Box>
      ) : null}
      {renderStatusRow(els, data, geo.width)}
    </Box>
  )
}

/**
 * The narrow pane (PRD M-L2): one column, the main box, the Jev box, the
 * subagents one line each, the advisor box, the session log, the usage box,
 * the status row.
 */
function renderNarrow(els: Kit, data: PaneData, geo: Geometry, budget: RowBudget): RenderElement {
  const { Box } = els
  const view = { tree: data.tree, activity: data.activity, frame: data.frame, now: data.now }

  return (
    <Box flexDirection="column" width={geo.width}>
      {renderMainBox(els, data, geo.column)}
      {budget.jev > 0 ? renderJevBox(els, data, geo.column, budget.jev, false) : null}
      {renderAgentsBox(els, view, geo, budget.agents)}
      {budget.advisor > 0 ? renderAdvisorColumn(els, data, geo.side, budget.advisor) : null}
      {budget.log > 0 ? renderLogBox(els, data.log, geo.column, budget.log) : null}
      {budget.usage > 0 ? renderUsageBox(els, data, geo.side, budget.usage) : null}
      {renderStatusRow(els, data, geo.width)}
    </Box>
  )
}

/**
 * The Agent Tree pane (PRD section 12, M-L1, M-L2): bordered boxes, two
 * columns from 88 body columns (layout.ts variant), one column below; each
 * box draws the lines the row budget gives it.
 */
export function renderPane(els: Kit, data: PaneData, width: number): RenderElement {
  const geo = geometry(width)
  const budget = paneBudget(data, geo)

  return geo.variant === 'wide' ? renderWide(els, data, geo, budget) : renderNarrow(els, data, geo, budget)
}
