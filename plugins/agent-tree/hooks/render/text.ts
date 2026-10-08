// The pane's text, fitted to a width: pure, no `$` and no elements. Widths
// are terminal columns (a CJK character or an emoji takes two), and a cut is
// marked with `~` so every glyph the pane draws itself stays ASCII or
// box-drawing.

import type { AgentNode } from '../../types'
import { SEP } from '../stats'

/** How a row is colored: running, finished, or failed (failed and killed). */
export type Tone = 'run' | 'done' | 'fail'

function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
    return 0
  }

  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) {
    return 0
  }

  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)

  return isWide ? 2 : 1
}

/** Terminal columns `text` takes. */
export function widthOf(text: string): number {
  let width = 0

  for (const char of text) {
    width += charWidth(char.codePointAt(0) ?? 0)
  }

  return width
}

/** `text` cut to `width` columns, the cut marked with `~`. */
export function clip(text: string, width: number): string {
  const room = Math.max(1, Math.floor(width))

  if (widthOf(text) <= room) {
    return text
  }

  let kept = ''
  let used = 0

  for (const char of text) {
    const width = charWidth(char.codePointAt(0) ?? 0)

    if (used + width > room - 1) {
      break
    }

    kept += char
    used += width
  }

  return `${kept}~`
}

/** One line of plain text: control characters (a newline in a description) become spaces. */
export function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
}

/** The width a pane draws into: its body columns, else the viewport's, else 80. */
export function paneWidth(bodyColumns: unknown, viewportColumns: unknown): number {
  for (const value of [bodyColumns, viewportColumns]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.floor(value)
    }
  }

  return 80
}

/** Segments joined by ` · `, a new line wherever the next would not fit. */
export function packSegments(segments: readonly string[], width: number, separator: string = SEP): string[] {
  const lines: string[] = []
  let line = ''

  for (const segment of segments) {
    const joined = line === '' ? segment : `${line}${separator}${segment}`

    if (widthOf(joined) <= width) {
      line = joined
      continue
    }

    if (line !== '') {
      lines.push(line)
    }

    line = clip(segment, width)
  }

  if (line !== '') {
    lines.push(line)
  }

  return lines
}

/** A model id without the `claude-` lead and a date tail: `claude-sonnet-5-5` is `sonnet-5-5`. */
export function shortModel(model: string | undefined): string {
  return oneLine(model)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
}

export function toneOf(status: string): Tone {
  if (status === 'failed' || status === 'killed') {
    return 'fail'
  }

  return status === 'completed' ? 'done' : 'run'
}

/** A row's running time: `12s`, `3m04s`, `1h02m`; `--` when unknown. */
export function formatAge(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return '--'
  }

  const seconds = Math.floor(Math.max(0, ms) / 1000)
  const two = (value: number): string => String(value).padStart(2, '0')

  if (seconds < 60) {
    return `${seconds}s`
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m${two(seconds % 60)}s`
  }

  return `${Math.floor(seconds / 3600)}h${two(Math.floor(seconds / 60) % 60)}m`
}

/** How long a node ran: its reported duration once finished, else from its start to its end or `now`. */
export function durationOf(node: AgentNode, now: number): number | undefined {
  const isRunning = node.status === 'running'

  if (!isRunning && node.durationMs !== undefined && Number.isFinite(node.durationMs)) {
    return node.durationMs
  }

  if (node.startedAt === undefined || !Number.isFinite(node.startedAt)) {
    return undefined
  }

  return (isRunning ? now : (node.endedAt ?? now)) - node.startedAt
}

/** At most `room` rows: the latest ones, the first kept row given up for a `+k more` line. */
export function limitRows<T>(rows: readonly T[], room: number | undefined): { shown: T[]; hidden: number } {
  if (room === undefined || !Number.isFinite(room) || rows.length <= room) {
    return { shown: rows.slice(), hidden: 0 }
  }

  const keep = Math.max(0, Math.floor(room) - 1)

  return { shown: rows.slice(rows.length - keep), hidden: rows.length - keep }
}
