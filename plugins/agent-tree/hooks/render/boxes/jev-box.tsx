import type { RenderElement } from 'claude-code'

import type { JevFlag, JevSnapshot } from '../../../types'
import { elapsed, isJevCalling, spinner } from '../../activity'
import { ALERT_FLAGS, ALERT_P, HEALTH_LEVELS } from '../../jev-core'
import { SEP } from '../../stats'
import { BORDER_STYLE, FRAME_COLUMNS, boxRow, fitRows, partsWidth } from '../layout'
import type { BoxRow } from '../layout'
import { JEV_OFF, clockTime, probabilityBar } from '../sections/jev'
import { clip, oneLine, widthOf } from '../text'
import { COLORS } from '../theme'
import type { Kit } from '../theme'

/** The Jev box's title (PRD M-L6). */
export const JEV_TITLE = 'JEV · advisory'

/** The title where JEV_TITLE and Jev's activity do not fit side by side. */
const JEV_SHORT_TITLE = 'JEV'

/** Jev's activity while no call is in flight (PRD M-L6). */
export const JEV_IDLE = 'idle'

/** Columns between two parts of a line: the title and the activity, two flags. */
export const PART_GAP = 2

/** The longest compact flag bar (PRD M-L6), however wide the box. */
export const MAX_FLAG_BAR = 10

/** The shortest compact flag bar drawn; with less room the flags show their numbers only. */
export const MIN_FLAG_BAR = 3

/** What the Jev box draws from (C7c): Jev's snapshot, the animation frame, the time it is drawn at. */
export type JevView = {
  jev: JevSnapshot
  /** The `frame` state, 0 to 3: the spinner glyph of a call in flight (PRD M-L4). */
  frame: number
  now: number
}

export const clamp01 = (p: number): number => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0)

const padEnd = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - widthOf(text)))

export const labelOf = (flag: JevFlag): string => oneLine(flag.label) || oneLine(flag.key) || '?'

/** The shared pane/HUD alert rule, using the displayed (clamped) probability. */
export const flagColor = (flag: JevFlag): string =>
  ALERT_FLAGS.includes(flag.key) && clamp01(flag.p) >= ALERT_P ? COLORS.fail : COLORS.jev

const widestLabel = (flags: readonly (JevFlag | undefined)[]): number =>
  flags.reduce((widest, flag) => (flag === undefined ? widest : Math.max(widest, widthOf(labelOf(flag)))), 0)

/** Jev's activity while its call is in flight (PRD M-L6): `◐ calling now… 2s`, the spinner glyph of `frame` and the time since the claim. */
export function callingText(jev: JevSnapshot, frame: number, now: number): string {
  return `${spinner(frame)} calling now… ${elapsed(now, jev.inFlightSince)}`
}

/**
 * The first line: `JEV · advisory` and Jev's activity side by side, the
 * activity `◐ calling now… 2s` in inverse video with the title bold while a
 * call is in flight, else `idle`; `JEV` and the activity where both do not
 * fit; the activity alone, cut, where even that does not.
 */
function headParts(view: JevView, inner: number): BoxRow[] {
  const isCalling = isJevCalling(view.jev, view.now)
  const state = isCalling
    ? boxRow(callingText(view.jev, view.frame, view.now), COLORS.jev, { inverse: true })
    : boxRow(JEV_IDLE, COLORS.jev)
  const title = (text: string): BoxRow => boxRow(text, COLORS.jev, { bold: isCalling })

  for (const parts of [
    [title(JEV_TITLE), state],
    [title(JEV_SHORT_TITLE), state],
  ]) {
    if (partsWidth(parts, PART_GAP) <= inner) {
      return parts
    }
  }

  return [{ ...state, text: clip(state.text, inner) }]
}

/** The second line: `calls n · last HH:mm:ss` (the last attempt, C4f); `calls 0 · waiting for events`, dim, before the first. */
function countsRow(jev: JevSnapshot, inner: number): BoxRow {
  return jev.lastAt === undefined
    ? boxRow(clip(`calls ${jev.calls}${SEP}waiting for events`, inner), COLORS.jev, { dim: true })
    : boxRow(clip(`calls ${jev.calls}${SEP}last ${clockTime(jev.lastAt)}`, inner), COLORS.jev)
}

/** `looping      ███░░ 0.41 split`: the label padded to its column, a bar of `bar` cells (none under MIN_FLAG_BAR), the probability, sharp or split; a looping or stuck flag from ALERT_P in the fail red. */
function flagPart(flag: JevFlag, labelWidth: number, bar: number): BoxRow {
  const p = clamp01(flag.p)
  const cells = bar >= MIN_FLAG_BAR ? `${probabilityBar(p, bar)} ` : ''

  return boxRow(`${padEnd(labelOf(flag), labelWidth)} ${cells}${p.toFixed(2)} ${flag.sharp ? 'sharp' : 'split'}`, flagColor(flag))
}

/**
 * The flags two to a line (PRD M-L6, the wide box): each line's two parts
 * PART_GAP apart, each column's labels padded alike, the longest bars (up to
 * MAX_FLAG_BAR cells) with which every line fits; no bars when even
 * MIN_FLAG_BAR cells do not fit; one flag a line, cut, when two do not.
 */
function flagLines(flags: readonly JevFlag[], inner: number): BoxRow[][] {
  const pairs = Array.from({ length: Math.ceil(flags.length / 2) }, (_, index) => flags.slice(index * 2, index * 2 + 2))
  const widths = [widestLabel(pairs.map(pair => pair[0])), widestLabel(pairs.map(pair => pair[1]))]

  for (let bar = MAX_FLAG_BAR; bar >= MIN_FLAG_BAR - 1; bar -= 1) {
    const cells = bar < MIN_FLAG_BAR ? 0 : bar
    const lines = pairs.map(pair => pair.map((flag, side) => flagPart(flag, widths[side] ?? 0, cells)))

    if (lines.every(parts => partsWidth(parts, PART_GAP) <= inner)) {
      return lines
    }
  }

  const widest = widestLabel(flags)

  return flags.map(flag => {
    const part = flagPart(flag, widest, 0)

    return [{ ...part, text: clip(part.text, inner) }]
  })
}

/** `health 0.9 needs attention`, ` low confidence` added and the line dim below LOW_CONFIDENCE (C4a). */
export function healthRow(score: number, isLowConfidence: boolean, inner: number): BoxRow {
  const top = HEALTH_LEVELS.length - 1
  const shown = Math.round(Math.min(top, Math.max(0, score)) * 10) / 10
  const level = HEALTH_LEVELS[Math.round(shown)] ?? HEALTH_LEVELS[0]
  const text = `health ${shown.toFixed(1)} ${level}${isLowConfidence ? ' low confidence' : ''}`

  return boxRow(clip(text, inner), COLORS.jev, { dim: isLowConfidence })
}

/**
 * The Jev box's lines (PRD M-L6, C7c), each a row of parts side by side,
 * fitted to the box's text room:
 * - Jev off: one dim line, `Jev off — enable in /plugin configure agent-tree@agent-tree`;
 * - `JEV · advisory` and `◐ calling now… 2s` (in inverse video) or `idle`;
 * - `calls n · last HH:mm:ss`;
 * - the wide box (`isWide`) only: the four flags two to a line, with compact
 *   bars, then the health score;
 * - after a failure, `JEV error: …` in the fail red, last (C4f: the flags and
 *   health of the answer before it stay).
 * At most `room` lines when given: the first ones, and from two lines the
 * error line stays last (layout.ts fitRows).
 */
export function jevBoxRows(view: JevView, inner: number, isWide: boolean, room?: number): BoxRow[][] {
  const jev = view.jev

  if (!jev.enabled) {
    const off = [[boxRow(clip(JEV_OFF, inner), COLORS.jev, { dim: true })]]

    return room === undefined ? off : fitRows(off, room)
  }

  const hasError = typeof jev.error === 'string' && jev.error !== ''
  const lines = [headParts(view, inner), [countsRow(jev, inner)]]

  if (isWide) {
    lines.push(...flagLines(jev.flags, inner))

    if (typeof jev.health === 'number' && Number.isFinite(jev.health)) {
      lines.push([healthRow(jev.health, jev.healthLowConfidence === true, inner)])
    }
  }

  if (hasError) {
    lines.push([boxRow(clip(`JEV error: ${oneLine(jev.error)}`, inner), COLORS.fail)])
  }

  return room === undefined ? lines : fitRows(lines, room, hasError)
}

/**
 * The Jev box (green): its first `lines` lines (jevBoxRows), a line of
 * several parts as a row of Texts. While a call is in flight (PRD M-L6,
 * C7c) the border is lit and the title bold; otherwise the border is dim, as
 * the main box's (C7b).
 */
export function renderJevBox(els: Kit, view: JevView, width: number, lines: number, isWide: boolean): RenderElement {
  const { Box, Text } = els
  const text = (part: BoxRow): RenderElement => (
    <Text color={part.color} dimColor={part.dim} bold={part.bold} inverse={part.inverse} wrap="truncate-end">
      {part.text}
    </Text>
  )

  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={COLORS.jev}
      borderDimColor={!isJevCalling(view.jev, view.now)}
      paddingX={1}
      width={width}
    >
      {jevBoxRows(view, width - FRAME_COLUMNS, isWide, lines).map(parts => {
        const [only] = parts

        return parts.length === 1 && only !== undefined ? (
          text(only)
        ) : (
          <Box flexDirection="row" gap={PART_GAP}>
            {parts.map(text)}
          </Box>
        )
      })}
    </Box>
  )
}
