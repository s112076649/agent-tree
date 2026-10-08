import type { RenderElement } from 'claude-code'

import type { LogEntry, LogKind } from '../../../types'
import { GAP_COLUMNS, TIME_COLUMNS, logLines } from '../../log'
import { BORDER_STYLE, FRAME_COLUMNS, boxRow } from '../layout'
import type { BoxRow } from '../layout'
import { clip } from '../text'
import { COLORS } from '../theme'
import type { Kit } from '../theme'

/** What the session log box says while the session has no events (PRD M-L7). */
export const NO_EVENTS = 'no events yet'

/** The color a line's text is drawn in (PRD M-L7): a failure (a Jev error too) in the fail red, Jev's lines green, the advisor's purple; the terminal's own for the rest. */
function colorOf(kind: LogKind): string | undefined {
  switch (kind) {
    case 'fail':
      return COLORS.fail
    case 'jev':
      return COLORS.jev
    case 'advisor':
      return COLORS.advisor
    default:
      return undefined
  }
}

/** The last `room` of `log`, oldest first; all of it when `room` is left out. */
function lastOf(log: readonly LogEntry[], room: number | undefined): LogEntry[] {
  if (room === undefined) {
    return log.slice()
  }

  const keep = Math.max(0, Math.floor(room))

  return keep >= log.length ? log.slice() : log.slice(log.length - keep)
}

/**
 * The session log box's lines (PRD M-L7), each a row of parts side by side,
 * fitted to the box's text room: the last `room` events when given (all of
 * them otherwise), oldest first, so the newest is at the bottom. A line is
 * its time `HH:mm:ss`, dim, and its `who  text`, in the color of its kind
 * and cut with `~` where the room ends; one part, cut, where the box is too
 * narrow for both. Dim `no events yet` while the log is empty.
 */
export function logRows(log: readonly LogEntry[], inner: number, room?: number): BoxRow[][] {
  if (log.length === 0) {
    const placeholder = [[boxRow(clip(NO_EVENTS, inner), undefined, { dim: true })]]

    return room === undefined || room >= 1 ? placeholder : []
  }

  const shown = lastOf(log, room)
  const isSplit = inner >= TIME_COLUMNS + GAP_COLUMNS + 1

  return logLines(shown, inner).map(line => {
    const color = colorOf(line.entry.kind)

    return isSplit
      ? [boxRow(line.time, undefined, { dim: true }), boxRow(line.body, color)]
      : [boxRow(clip(`${line.time}${' '.repeat(GAP_COLUMNS)}${line.body}`, inner), color)]
  })
}

/** The session log box (a dim border): the last `lines` events (logRows), a line of two parts as a row of Texts; wide, it stretches to the usage box's height beside it. */
export function renderLogBox(els: Kit, log: readonly LogEntry[], width: number, lines: number): RenderElement {
  const { Box, Text } = els
  const text = (part: BoxRow): RenderElement => (
    <Text color={part.color} dimColor={part.dim} wrap="truncate-end">
      {part.text}
    </Text>
  )

  return (
    <Box flexDirection="column" borderStyle={BORDER_STYLE} borderDimColor paddingX={1} width={width}>
      {logRows(log, width - FRAME_COLUMNS, lines).map(parts => {
        const [only] = parts

        return parts.length === 1 && only !== undefined ? (
          text(only)
        ) : (
          <Box flexDirection="row" gap={GAP_COLUMNS}>
            {parts.map(text)}
          </Box>
        )
      })}
    </Box>
  )
}
