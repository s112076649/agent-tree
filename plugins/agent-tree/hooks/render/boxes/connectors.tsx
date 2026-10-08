import type { RenderElement } from 'claude-code'

import { dotAt } from '../../activity'
import { clip, widthOf } from '../text'
import type { Kit } from '../theme'

// The lines between the boxes of the wide variant (PRD section 12), drawn
// dim. The trunk runs down from the main box past the Jev box to the fan,
// which spreads to the subagent boxes of the first line. While a subagent
// runs, a dot steps along the fan from the first box to the last, one step
// a frame (PRD M-L3, C7b); otherwise the lines stand still. Each row is a
// Text of its own, fitted to the left column; the boxes' borders stay the
// surface's (BoxProps has no way to put a `┬` into one).

/** The fan's label (PRD section 12). */
export const DELEGATE_LABEL = 'delegate to subagents'

/** The dot that moves along the fan while a subagent runs (PRD M-L3). */
export const DOT = '●'

const TRUNK = '│'

const ARROW = '▼'

/** The trunk's column: midway between the first box's centre and the last's. */
export function trunkColumn(centres: readonly number[]): number {
  const first = centres[0] ?? 0
  const last = centres[centres.length - 1] ?? first

  return Math.floor((first + last) / 2)
}

/** The trunk row between the main box and the Jev box: `│` at the trunk's column. */
export function trunkText(centres: readonly number[], width: number): string {
  return clip(`${' '.repeat(trunkColumn(centres))}${TRUNK}`, width)
}

/** The fan line's glyph at `column`, from the first centre to the last. */
function fanGlyph(column: number, centres: readonly number[], trunk: number): string {
  const first = centres[0]
  const last = centres[centres.length - 1]
  const isCentre = centres.includes(column)

  if (column === first && column === last) {
    return TRUNK
  }

  if (column === first) {
    return '┌'
  }

  if (column === last) {
    return '┐'
  }

  if (column === trunk) {
    return isCentre ? '┼' : '┴'
  }

  return isCentre ? '┬' : '─'
}

/**
 * The three rows from the Jev box down to the subagent boxes: the label,
 * centred on the trunk; the fan, `┌` over the first box and `┐` over the
 * last, `┬` over each box between, the trunk meeting it with `┴` (`┼` over
 * a box); `▼` over each box. With one box the fan is the trunk going
 * straight down. With a `frame` (a subagent runs) the fan cell dotAt names
 * is the dot.
 */
export function fanTexts(centres: readonly number[], width: number, frame?: number): string[] {
  const room = Math.max(1, Math.floor(width))
  const trunk = trunkColumn(centres)
  const label = clip(DELEGATE_LABEL, room)
  const start = Math.max(0, Math.min(trunk - Math.floor(widthOf(label) / 2), room - widthOf(label)))
  const first = centres[0] ?? trunk
  const last = centres[centres.length - 1] ?? first
  const cells = Array.from({ length: last - first + 1 }, (_, index) => fanGlyph(first + index, centres, trunk))
  const dot = frame === undefined ? -1 : dotAt(frame, cells.length)
  const fan = cells.map((cell, index) => (index === dot ? DOT : cell)).join('')
  const arrows = Array.from({ length: last + 1 }, (_, column) => (centres.includes(column) ? ARROW : ' ')).join('')

  return [
    clip(`${' '.repeat(start)}${label}`, room),
    clip(`${' '.repeat(first)}${fan}`, room),
    clip(arrows.trimEnd(), room),
  ]
}

function dimRows(els: Kit, texts: readonly string[]): RenderElement {
  const { Box, Text } = els

  return (
    <Box flexDirection="column">
      {texts.map(text => (
        <Text dimColor wrap="truncate-end">
          {text}
        </Text>
      ))}
    </Box>
  )
}

/** The trunk row, dim. */
export function renderTrunk(els: Kit, centres: readonly number[], width: number): RenderElement {
  return dimRows(els, [trunkText(centres, width)])
}

/** The label, fan and arrow rows, dim; the fan carries the dot of `frame` while a subagent runs (fanTexts). */
export function renderFan(els: Kit, centres: readonly number[], width: number, frame?: number): RenderElement {
  return dimRows(els, fanTexts(centres, width, frame))
}
