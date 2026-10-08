import type { RenderElement } from 'claude-code'

import type { ActivitySnapshot, AdvisorSnapshot, JevSnapshot, MainActivity, TreeSnapshot } from '../../../types'
import { isInFlight, isJevCalling } from '../../activity'
import { SEP } from '../../stats'
import { countRunning } from '../../tree'
import { boxRow, fitParts, partsWidth } from '../layout'
import type { BoxRow } from '../layout'
import { clip, oneLine, shortModel } from '../text'
import { COLORS } from '../theme'
import type { Kit } from '../theme'

/** Columns between the status row's parts. */
export const STATUS_GAP = 2

/** The most columns of a tool name in the status row: a long MCP tool name is cut there, so the word stays. */
export const STATUS_TOOL_COLUMNS = 16

/** What the status row draws from. */
export type StatusView = {
  tree: TreeSnapshot
  /** The main loop's phase and tool (C7b). */
  activity: ActivitySnapshot
  advisor: AdvisorSnapshot
  jev: JevSnapshot
  /** The time it is drawn at: an advisor or Jev call in flight longer than activity.ts IN_FLIGHT_STALE_MS is not one (C7c). */
  now: number
}

/** What the advisor does, in the status row (PRD M-L8, C7c): `advising` while its call is in flight, else `on call`. */
export function advisorWord(advisor: AdvisorSnapshot, now: number): string {
  return isInFlight(advisor, now) ? 'advising' : 'on call'
}

/** What Jev does, in the status row (PRD M-L8, C7c): `calling` while its call is in flight, else `idle`. */
export function jevWord(jev: JevSnapshot, now: number): string {
  return isJevCalling(jev, now) ? 'calling' : 'idle'
}

/** What the main loop does, in the status row (PRD M-L8, C7b): `thinking`, `tooling Read`; nothing while idle. */
export function mainWord(main: MainActivity): string {
  if (main.phase === 'idle') {
    return ''
  }

  const tool = main.phase === 'tooling' ? clip(oneLine(main.tool), STATUS_TOOL_COLUMNS) : ''

  return tool === '' ? main.phase : `${main.phase} ${tool}`
}

/**
 * The status row's forms, widest first (PRD M-L8), two columns between parts:
 * - `main [opus-5-5 · high · tooling Read]`, `subagents [2/4]`, `fable [advising · 4]`, `jev [calling · 3]`;
 * - the same without the effort;
 * - short: `main [opus-5-5]`, `sub [2/4]`, `fable [4]`, `jev [3]`.
 * The main loop's word (mainWord) is in the first two only; idle has none.
 * The advisor's word is `advising` while its call is in flight, else `on
 * call`; Jev's `calling`, else `idle` (C7c); both in the first two forms only.
 * Jev off is `jev [off]`, dim.
 */
export function statusForms(view: StatusView): BoxRow[][] {
  const model = shortModel(view.tree.main.model) || '--'
  const effort = oneLine(view.tree.main.effort)
  const word = mainWord(view.activity.main)
  const agents = `${countRunning(view.tree)}/${view.tree.agents.length}`
  const isJevOn = view.jev.enabled
  const jevState = isJevOn ? `${jevWord(view.jev, view.now)}${SEP}${view.jev.calls}` : 'off'
  const jevShort = isJevOn ? String(view.jev.calls) : 'off'
  const jev = (state: string): BoxRow => boxRow(`jev [${state}]`, COLORS.jev, { dim: !isJevOn })
  const main = (facts: readonly string[]): BoxRow => boxRow(`main [${facts.filter(fact => fact !== '').join(SEP)}]`, COLORS.main)
  const mainShort = main([model])
  const mainFull = main([model, effort, word])
  const mainMiddle = main([model, word])
  const rest = [
    boxRow(`subagents [${agents}]`, COLORS.sub),
    boxRow(`fable [${advisorWord(view.advisor, view.now)}${SEP}${view.advisor.calls}]`, COLORS.advisor),
    jev(jevState),
  ]

  return [
    [mainFull, ...rest],
    [mainMiddle, ...rest],
    [mainShort, boxRow(`sub [${agents}]`, COLORS.sub), boxRow(`fable [${view.advisor.calls}]`, COLORS.advisor), jev(jevShort)],
  ]
}

/** The widest form that fits in `width`; else the short form's leading parts that fit (fitParts). */
export function statusParts(view: StatusView, width: number): BoxRow[] {
  const forms = statusForms(view)
  const fits = forms.find(form => partsWidth(form, STATUS_GAP) <= width)

  return fits ?? fitParts(forms[forms.length - 1] ?? [], width, STATUS_GAP)
}

/** The status row below everything (PRD M-L8): each part in its box's color. */
export function renderStatusRow(els: Kit, view: StatusView, width: number): RenderElement {
  const { Box, Text } = els

  return (
    <Box flexDirection="row" gap={STATUS_GAP}>
      {statusParts(view, width).map(part => (
        <Text color={part.color} dimColor={part.dim} wrap="truncate-end">
          {part.text}
        </Text>
      ))}
    </Box>
  )
}
