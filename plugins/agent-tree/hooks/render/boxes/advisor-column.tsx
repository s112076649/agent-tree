import type { RenderElement } from 'claude-code'

import type { AdvisorCall, AdvisorSnapshot } from '../../../types'
import { isInFlight, spinner } from '../../activity'
import { MAX_RECENT_CALLS } from '../../advisor-core'
import { formatTokens } from '../../stats'
import { BORDER_STYLE, FRAME_COLUMNS, boxRow, fitRows } from '../layout'
import type { BoxRow } from '../layout'
import { ADVICE_NOTE, NO_CALLS, clockTime } from '../sections/advisor'
import { clip, oneLine, packSegments, shortModel } from '../text'
import { COLORS } from '../theme'
import type { Kit } from '../theme'

/** The advisor box's title; the model follows it once a transcript read named it (PRD M-L5). */
export const ADVISOR_TITLE = 'FABLE ADVISOR'

/** The activity line while no advisor call is in flight (PRD M-L5). */
export const ADVISOR_IDLE = 'on call · idle'

/** What the advisor box draws from (C7c): the advisor, the animation frame, the time it is drawn at. */
export type AdvisorView = {
  advisor: AdvisorSnapshot
  /** The `frame` state, 0 to 3: the spinner glyph of a call in flight (PRD M-L4). */
  frame: number
  now: number
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** `21.1s`: a call's latency as the advisor line has drawn it since C3. */
const latencyText = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * The activity line of a call in flight (PRD M-L5): `◆ advising now (3.2 s)`,
 * the time since its server_tool_use block to a tenth of a second, then the
 * spinner glyph of `frame`.
 */
export function advisingText(advisor: AdvisorSnapshot, frame: number, now: number): string {
  const since = advisor.inFlightSince
  const seconds = isFiniteNumber(since) ? `${(Math.max(0, now - since) / 1000).toFixed(1)} s` : '--'

  return `◆ advising now (${seconds}) ${spinner(frame)}`
}

/** One call of the latest five (PRD M-L5): `◇ 14:35:51  21.1s`; `--` when its start was not seen. */
export function recentCallText(call: AdvisorCall): string {
  return `◇ ${clockTime(call.at)}  ${isFiniteNumber(call.latencyMs) ? latencyText(call.latencyMs) : '--'}`
}

/** `read 62k tok` and `out 969 tok` as far as known; `tok n/a (<reason>)` when the transcript could not give them (as the advisor line words them). */
function tokenSegments(advisor: AdvisorSnapshot): string[] {
  const reason = oneLine(advisor.tokensUnavailable ?? advisor.error)

  if (reason !== '') {
    return [`tok n/a (${reason})`]
  }

  return [
    isFiniteNumber(advisor.inputTokens) ? `read ${formatTokens(advisor.inputTokens)} tok` : '',
    isFiniteNumber(advisor.outputTokens) ? `out ${formatTokens(advisor.outputTokens)} tok` : '',
  ].filter(segment => segment !== '')
}

/** `last 14:35:51 (21.1s)`: the latest result and its latency; nothing before the first result. */
function lastText(advisor: AdvisorSnapshot): string | undefined {
  if (!isFiniteNumber(advisor.lastCallAt)) {
    return undefined
  }

  const last = `last ${clockTime(advisor.lastCallAt)}`

  return isFiniteNumber(advisor.lastLatencyMs) ? `${last} (${latencyText(advisor.lastLatencyMs)})` : last
}

/**
 * The advisor box's rows (PRD M-L5, C7c), fitted to the box's text room:
 * - the title `FABLE ADVISOR <model>`, bold while a call is in flight;
 * - the activity: `◆ advising now (3.2 s) ◐` in inverse video while a call is
 *   in flight, else `on call · idle`;
 * - `calls n · read k tok · out k tok`, packed onto as many lines as it takes;
 * - `last HH:mm:ss (21.1s)` once a result came;
 * - the latest five calls whose result came, newest first, `◇ HH:mm:ss  21.1s`;
 * - `advice: encrypted by API`.
 * Before the first call: the title, `advisor: no calls yet` and the advice
 * note, both dim (C4b).
 */
export function advisorRows(view: AdvisorView, inner: number): BoxRow[] {
  const advisor = view.advisor
  // A stale flag (activity.ts IN_FLIGHT_STALE_MS) is drawn as no call in flight.
  const isActive = isInFlight(advisor, view.now)
  const model = shortModel(advisor.model)
  const title = boxRow(clip(model === '' ? ADVISOR_TITLE : `${ADVISOR_TITLE} ${model}`, inner), COLORS.advisor, { bold: isActive })
  const line = (text: string, style: { dim?: boolean; inverse?: boolean } = {}): BoxRow => boxRow(clip(text, inner), COLORS.advisor, style)

  if (advisor.calls <= 0) {
    return [title, line(NO_CALLS, { dim: true }), line(ADVICE_NOTE, { dim: true })]
  }

  const activity = isActive ? line(advisingText(advisor, view.frame, view.now), { inverse: true }) : line(ADVISOR_IDLE)
  const figures = packSegments([`calls ${advisor.calls}`, ...tokenSegments(advisor)], inner).map(text => line(text))
  const last = lastText(advisor)
  // State written before C7c has no list; one longer than the contract's five is drawn as its latest five.
  const recent = (advisor.recentCalls ?? [])
    .slice(-MAX_RECENT_CALLS)
    .reverse()
    .map(call => line(recentCallText(call)))

  return [title, activity, ...figures, ...(last === undefined ? [] : [line(last)]), ...recent, line(ADVICE_NOTE)]
}

/**
 * The advisor box (purple): its first `lines` rows. While a call is in flight
 * (PRD M-L5, C7c) the border is lit and the title bold; otherwise the border
 * is dim, as the main box's (C7b).
 */
export function renderAdvisorColumn(els: Kit, view: AdvisorView, width: number, lines: number): RenderElement {
  const { Box, Text } = els

  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={COLORS.advisor}
      borderDimColor={!isInFlight(view.advisor, view.now)}
      paddingX={1}
      width={width}
    >
      {fitRows(advisorRows(view, width - FRAME_COLUMNS), lines).map(row => (
        <Text color={row.color} dimColor={row.dim} bold={row.bold} inverse={row.inverse} wrap="truncate-end">
          {row.text}
        </Text>
      ))}
    </Box>
  )
}
