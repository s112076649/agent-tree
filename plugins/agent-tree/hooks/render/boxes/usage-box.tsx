import type { RenderElement } from 'claude-code'

import { SEP, formatCost, formatDuration, formatTokens, limitSegments } from '../../stats'
import { countRunning } from '../../tree'
import { BORDER_STYLE, FRAME_COLUMNS, boxRow, fitRows } from '../layout'
import type { BoxRow } from '../layout'
import { statsLines } from '../sections/stats'
import type { StatsView } from '../sections/stats'
import { clip, packSegments, widthOf } from '../text'
import type { Kit } from '../theme'

/** The longest bar the usage box draws, however wide it is. */
export const MAX_GAUGE = 10

/** With room for fewer cells the box draws the stats segments instead, without bars. */
const MIN_GAUGE = 3

/** A bar's used and free cells: block elements of PRD M-L9. */
const USED = '▓'

const FREE = '░'

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** `▓▓▓▓▓▓░░░░`: `cells` wide, `percent` of them used (rounded, within 0 to 100). */
export function gaugeBar(percent: number | undefined, cells: number): string {
  const room = Math.max(0, Math.floor(cells))
  const share = isFiniteNumber(percent) ? Math.min(100, Math.max(0, percent)) / 100 : 0
  const used = Math.round(share * room)

  return USED.repeat(used) + FREE.repeat(room - used)
}

/** One bar line: its label, how full, and what follows the bar. */
type Gauge = { label: string; percent?: number; tail: string }

/**
 * The bar lines: `ctx` (percent, then tokens/window; `--` for what is not
 * read yet), then one per rate-limit window as stats.ts labels it (`5h`,
 * `7d`). No context window read yet: no ctx bar.
 */
function gaugesOf(view: StatsView): Gauge[] {
  const stats = view.stats
  const gauges: Gauge[] = []

  if (isFiniteNumber(stats.contextWindow)) {
    const percent = isFiniteNumber(stats.contextPercent) ? `${stats.contextPercent}%` : '--'
    const gauge: Gauge = {
      label: 'ctx',
      tail: `${percent} ${formatTokens(stats.contextTokens)}/${formatTokens(stats.contextWindow)}`,
    }

    if (isFiniteNumber(stats.contextPercent)) {
      gauge.percent = stats.contextPercent
    }

    gauges.push(gauge)
  }

  for (const limit of stats.rateLimits) {
    // limitSegments' `5h 57%`: the label, then the percent after the last space.
    const segment = limitSegments([limit])[0]

    if (segment !== undefined) {
      const cut = segment.lastIndexOf(' ')
      gauges.push({ label: segment.slice(0, cut), percent: limit.percentUsed, tail: segment.slice(cut + 1) })
    }
  }

  return gauges
}

const padEnd = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - widthOf(text)))

/**
 * The usage box's rows (PRD M-L8): a bar line for the context and for each
 * rate-limit window, labels and bars aligned (`ctx ▓░░░░░░░░░ 6% 61k/1M`,
 * `5h  ▓▓▓▓▓▓░░░░ 57%`), `ctx --` while no window is read, then the cost,
 * `agents running/total` and the session's length, packed. When the bars
 * would be under three cells, the stats line's segments, packed, instead.
 */
export function usageRows(view: StatsView, inner: number): BoxRow[] {
  const gauges = gaugesOf(view)
  const labelWidth = gauges.reduce((widest, gauge) => Math.max(widest, widthOf(gauge.label)), 0)
  const tailWidth = gauges.reduce((widest, gauge) => Math.max(widest, widthOf(gauge.tail)), 0)
  const cells = Math.min(MAX_GAUGE, inner - labelWidth - tailWidth - 2)

  if (gauges.length > 0 && cells < MIN_GAUGE) {
    return statsLines(view, inner).map(text => boxRow(text))
  }

  const elapsed = isFiniteNumber(view.stats.startedAt) ? view.now - view.stats.startedAt : undefined
  const lines = isFiniteNumber(view.stats.contextWindow) ? [] : ['ctx --']

  lines.push(...gauges.map(gauge => `${padEnd(gauge.label, labelWidth)} ${gaugeBar(gauge.percent, cells)} ${gauge.tail}`))
  lines.push(
    ...packSegments(
      [formatCost(view.stats.costUsd), `agents ${countRunning(view.tree)}/${view.tree.agents.length}`, formatDuration(elapsed)],
      inner,
      SEP,
    ),
  )

  return lines.map(text => boxRow(clip(text, inner)))
}

/** The usage box (a dim border, the terminal's own text color): its first `lines` rows. */
export function renderUsageBox(els: Kit, view: StatsView, width: number, lines: number): RenderElement {
  const { Box, Text } = els

  return (
    <Box flexDirection="column" borderStyle={BORDER_STYLE} borderDimColor paddingX={1} width={width}>
      {fitRows(usageRows(view, width - FRAME_COLUMNS), lines).map(row => (
        <Text wrap="truncate-end">{row.text}</Text>
      ))}
    </Box>
  )
}
