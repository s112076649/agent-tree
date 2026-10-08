// The pane's layout (PRD M-L1, M-L2, section 12): pure functions, no `$` and
// no elements. Which variant a width draws, how wide each box is, and how
// many text lines each box may draw in the body rows the surface gave (the
// row budget). The boxes under boxes/ draw what this decides; their lines
// are fitted with the text.ts helpers.

import { SPINNER as SPINNER_GLYPHS, spinner } from '../activity'
import { clip, widthOf } from './text'

/** Two columns from WIDE_COLUMNS body columns, one column below (PRD M-L2). */
export type Variant = 'wide' | 'narrow'

/** From this many body columns the pane draws the wide variant (PRD M-L2). */
export const WIDE_COLUMNS = 88

/** The advisor column's width in the wide variant, borders included; the usage box below it is as wide. */
export const ADVISOR_COLUMNS = 30

/** Every box's border: `┌ ┐ └ ┘ │ ─`, the box-drawing glyphs of PRD section 12. */
export const BORDER_STYLE = 'single'

/** Between the two columns, and between boxes side by side. */
export const GAP = 1

/** Rows a box's border takes: its top and its bottom line. */
export const BORDER_ROWS = 2

/** Columns a box takes from its width: a border and one cell of padding on each side. */
export const FRAME_COLUMNS = 4

/** The main box's lines: the title with the model, effort and turn; the status. */
export const MAIN_LINES = 2

/** A wide subagent box's lines: the role, type and model, the description, the status. */
export const AGENT_BOX_LINES = 4

/** The status row below everything (PRD M-L8). */
const STATUS_ROWS = 1

/** The legend row above everything (wide). */
const LEGEND_ROWS = 1

/** The `│` row from the main box down to the Jev box (wide). */
const TRUNK_ROWS = 1

/** The rows from the Jev box down to the subagent boxes: the label, the fan, the arrows (wide). */
export const FAN_ROWS = 3

/** The widest a subagent box grows on a wide pane: they stay small. */
const MAX_AGENT_BOX = 26

/** Subagent boxes one line holds on the narrowest wide pane. */
const MIN_AGENT_BOXES = 3

/** The spinner of a running box, one glyph per frame (PRD M-L3; activity.ts keeps it, C7b). */
export const SPINNER = SPINNER_GLYPHS

/** The `paneColumns` option's bounds and default, as the manifest declares them (PRD M-L2). */
const PANE_COLUMNS = { min: 60, max: 160, fallback: 92 } as const

/**
 * The `paneColumns` option as the body columns `$.ui.open` asks the dock for
 * (PRD M-L2): a whole number within 60 to 160 (the d.ts asks for a positive
 * whole number), 92 when unreadable. A numeric string counts as its number,
 * as for the other number options.
 */
export function paneColumns(value: unknown): number {
  const columns =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN

  if (!Number.isFinite(columns)) {
    return PANE_COLUMNS.fallback
  }

  return Math.min(PANE_COLUMNS.max, Math.max(PANE_COLUMNS.min, Math.round(columns)))
}

/** The variant `bodyColumns` draws: wide from WIDE_COLUMNS, else narrow. */
export function variant(bodyColumns: number): Variant {
  return bodyColumns >= WIDE_COLUMNS ? 'wide' : 'narrow'
}

/** How wide each part is drawn, borders included, and the text room inside each box. */
export type Geometry = {
  variant: Variant
  /** The body's columns. */
  width: number
  /** The left column (wide) or the one column (narrow): the main, Jev and subagent boxes; the log box below. */
  column: number
  columnInner: number
  /** The advisor column and the usage box below it: ADVISOR_COLUMNS (wide), or the one column (narrow). */
  side: number
  sideInner: number
  /** One subagent box (wide), or the one subagents box (narrow). */
  agentBox: number
  agentInner: number
  /** Subagent boxes on one line of the row (wide); 1 in the narrow variant. */
  perLine: number
}

/** The geometry of a pane `width` body columns wide. */
export function geometry(width: number): Geometry {
  const total = Math.max(1, Math.floor(width))
  const inner = (outer: number): number => Math.max(1, outer - FRAME_COLUMNS)

  if (variant(total) === 'wide') {
    const column = total - ADVISOR_COLUMNS - GAP
    const agentBox = Math.min(MAX_AGENT_BOX, Math.floor((column - GAP * (MIN_AGENT_BOXES - 1)) / MIN_AGENT_BOXES))

    return {
      variant: 'wide',
      width: total,
      column,
      columnInner: inner(column),
      side: ADVISOR_COLUMNS,
      sideInner: inner(ADVISOR_COLUMNS),
      agentBox,
      agentInner: inner(agentBox),
      perLine: Math.floor((column + GAP) / (agentBox + GAP)),
    }
  }

  return {
    variant: 'narrow',
    width: total,
    column: total,
    columnInner: inner(total),
    side: total,
    sideInner: inner(total),
    agentBox: total,
    agentInner: inner(total),
    perLine: 1,
  }
}

/** The spinner glyph of `frame` (activity.ts spinner): 0 to 3, any other whole number taken round. */
export function spinnerGlyph(frame: number): string {
  return spinner(frame)
}

/** One text line of a box and how it is drawn. */
export type BoxRow = {
  text: string
  /** A color of theme.ts; the terminal's own when absent. */
  color?: string
  dim: boolean
  bold: boolean
  /** Drawn in inverse video (C7c: the advisor's and Jev's call in flight, PRD M-L5, M-L6, M-L9); absent otherwise. */
  inverse?: boolean
}

/** A BoxRow of `text`, plain unless `style` says otherwise. */
export function boxRow(text: string, color?: string, style: { dim?: boolean; bold?: boolean; inverse?: boolean } = {}): BoxRow {
  const row: BoxRow =
    color === undefined
      ? { text, dim: style.dim === true, bold: style.bold === true }
      : { text, color, dim: style.dim === true, bold: style.bold === true }

  return style.inverse === true ? { ...row, inverse: true } : row
}

/**
 * At most `room` of `rows`: the first ones; with `pinLast`, from two rows
 * of room the last row takes the place of the last one kept (the Jev
 * area's error row, C4f).
 */
export function fitRows<T>(rows: readonly T[], room: number, pinLast: boolean = false): T[] {
  const keep = Math.max(0, Math.floor(room))
  const last = rows[rows.length - 1]

  if (rows.length <= keep) {
    return rows.slice()
  }

  if (!pinLast || keep < 2 || last === undefined) {
    return rows.slice(0, keep)
  }

  return [...rows.slice(0, keep - 1), last]
}

/** Columns `parts` take side by side, `gap` columns between two. */
export function partsWidth(parts: readonly BoxRow[], gap: number): number {
  return parts.reduce((sum, part) => sum + widthOf(part.text), 0) + gap * Math.max(0, parts.length - 1)
}

/**
 * The parts of a row of parts side by side (the legend, the status row) that
 * fit in `width` columns with `gap` columns between two: the leading ones
 * that fit whole; the first alone, cut to the width, when even it does not.
 */
export function fitParts(parts: readonly BoxRow[], width: number, gap: number): BoxRow[] {
  const room = Math.max(1, Math.floor(width))
  const kept: BoxRow[] = []

  for (const part of parts) {
    if (partsWidth([...kept, part], gap) > room) {
      break
    }

    kept.push(part)
  }

  const first = parts[0]

  return kept.length === 0 && first !== undefined ? [{ ...first, text: clip(first.text, room) }] : kept
}

/** What the boxes would draw with no budget: text lines per box, and how many subagents there are. */
export type BudgetInput = {
  geometry: Geometry
  /** `scroll.bodyRows` of the Pane props: no budget when absent. */
  bodyRows?: number
  want: { jev: number; advisor: number; usage: number; log: number }
  agentCount: number
}

/** What each part may draw: text lines per box (0 leaves the box out), and the rows it all takes. */
export type RowBudget = {
  /** The legend row (wide). */
  legend: boolean
  /** The `│` row between the main box and the Jev box (wide); with a row budget, only with the fan. */
  trunk: boolean
  /** The three rows down to the subagent boxes (wide); with a row budget, only with the trunk. */
  fan: boolean
  main: number
  jev: number
  /** Wide: lines of subagent boxes; narrow: lines of the subagents box. */
  agents: number
  advisor: number
  usage: number
  log: number
  /** The rows the drawing takes: at most `bodyRows`, unless the parts always drawn take more. */
  height: number
}

const boxRows = (lines: number): number => (lines > 0 ? lines + BORDER_ROWS : 0)

/** The rows `lines` of subagents take: wide, a line of boxes each (an empty-state box is one line high); narrow, one box. */
function agentRowsOf(geo: Geometry, agentCount: number, lines: number): number {
  if (geo.variant === 'narrow') {
    return boxRows(lines)
  }

  return lines * boxRows(agentCount === 0 ? 1 : AGENT_BOX_LINES)
}

/** The rows of the drawing `budget` describes. */
function heightOf(geo: Geometry, agentCount: number, budget: Omit<RowBudget, 'height'>): number {
  if (geo.variant === 'narrow') {
    const boxes = [budget.main, budget.jev, budget.advisor, budget.log, budget.usage].map(boxRows)

    return boxes.reduce((sum, rows) => sum + rows, 0) + agentRowsOf(geo, agentCount, budget.agents) + STATUS_ROWS
  }

  const left =
    boxRows(budget.main) +
    (budget.trunk ? TRUNK_ROWS : 0) +
    boxRows(budget.jev) +
    (budget.fan ? FAN_ROWS : 0) +
    agentRowsOf(geo, agentCount, budget.agents)
  const bottom = budget.usage > 0 ? boxRows(Math.max(budget.usage, budget.log)) : boxRows(budget.log)

  return (budget.legend ? LEGEND_ROWS : 0) + Math.max(left, boxRows(budget.advisor)) + bottom + STATUS_ROWS
}

/**
 * The row budget (PRD M-L1, M-L2). With no `bodyRows` every box draws all
 * its lines. With `bodyRows`, the status row, the main box and the first
 * subagent line are always drawn (past the rows if need be: the body
 * scrolls; narrow, two lines when there are two subagents or more, the
 * latest and `+k more`); then, while rows are left, in this order: the Jev
 * box line by line, more subagent lines, the advisor box (narrow; wide, it
 * stands beside the left column and is cut to its height), the usage box,
 * then (wide) the connectors (the trunk row and the fan rows, together) and
 * the legend; the log box takes what is left (wide, beside the usage box, at
 * least its height).
 */
export function rowBudget(input: BudgetInput): RowBudget {
  const geo = input.geometry
  const isWide = geo.variant === 'wide'
  const count = Math.max(0, Math.floor(input.agentCount))
  const agentsWant = isWide ? (count === 0 ? 1 : Math.ceil(count / Math.max(1, geo.perLine))) : Math.max(1, count)
  const want = {
    jev: Math.max(0, input.want.jev),
    advisor: Math.max(0, input.want.advisor),
    usage: Math.max(0, input.want.usage),
    log: Math.max(0, input.want.log),
  }
  const bodyRows = input.bodyRows

  if (bodyRows === undefined || !Number.isFinite(bodyRows)) {
    const full = {
      legend: isWide,
      trunk: isWide,
      fan: isWide,
      main: MAIN_LINES,
      jev: want.jev,
      agents: agentsWant,
      advisor: want.advisor,
      usage: want.usage,
      log: want.log,
    }

    return { ...full, height: heightOf(geo, count, full) }
  }

  const agentsMin = isWide ? 1 : Math.min(agentsWant, 2)
  let left = Math.floor(bodyRows) - STATUS_ROWS - boxRows(MAIN_LINES) - agentRowsOf(geo, count, agentsMin)

  /** Grows a box from `lines` toward `most`, a line at a time while rows are left: its first line costs its border too. */
  const grow = (lines: number, most: number): number => {
    let grown = lines

    while (grown < most) {
      const cost = grown === 0 ? BORDER_ROWS + 1 : 1

      if (cost > left) {
        break
      }

      left -= cost
      grown += 1
    }

    return grown
  }

  /** Takes `rows` when they are left. */
  const take = (rows: number): boolean => {
    if (rows > left) {
      return false
    }

    left -= rows

    return true
  }

  const jev = grow(0, want.jev)
  let agents = agentsMin

  while (agents < agentsWant && take(agentRowsOf(geo, count, agents + 1) - agentRowsOf(geo, count, agents))) {
    agents += 1
  }

  const narrowAdvisor = isWide ? 0 : grow(0, want.advisor)
  const usage = grow(0, want.usage)
  // The trunk and the fan come together: the trunk alone would run down to no arrow.
  const connectors = isWide && take(TRUNK_ROWS + FAN_ROWS)
  const legend = isWide && take(LEGEND_ROWS)
  const room = left > 0 ? left : 0
  // Wide, the log box stands beside the usage box: it has the usage box's
  // lines without a row more, and what is left below them.
  const logRoom = isWide && usage > 0 ? usage + room : room >= BORDER_ROWS + 1 ? room - BORDER_ROWS : 0
  const leftColumn =
    boxRows(MAIN_LINES) + (connectors ? TRUNK_ROWS + FAN_ROWS : 0) + boxRows(jev) + agentRowsOf(geo, count, agents)
  const advisor = isWide ? Math.min(want.advisor, Math.max(0, leftColumn - BORDER_ROWS)) : narrowAdvisor
  const budget = {
    legend,
    trunk: connectors,
    fan: connectors,
    main: MAIN_LINES,
    jev,
    agents,
    advisor,
    usage,
    log: Math.min(want.log, logRoom),
  }

  return { ...budget, height: heightOf(geo, count, budget) }
}
