import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import type {
  ActivitySnapshot,
  AdvisorSnapshot,
  AgentNode,
  JevSnapshot,
  LogEntry,
  MainNode,
  StatsSnapshot,
  TreeSnapshot,
} from '../types'
import { EMPTY_ACTIVITY, IN_FLIGHT_STALE_MS } from './activity'
import { EMPTY_ADVISOR, MAX_RECENT_CALLS } from './advisor-core'
import { EMPTY_JEV } from './jev-core'
import { GAP_COLUMNS, MAX_LOG, formatLines } from './log'
import { ADVISOR_IDLE, ADVISOR_TITLE, advisingText, advisorRows, recentCallText } from './render/boxes/advisor-column'
import {
  NO_SUBAGENTS,
  agentBoxRows,
  agentLine,
  boxCentres,
  emptyBoxWidth,
  kindText,
  moreText,
  roleWord,
  shownAgents,
} from './render/boxes/agents-row'
import { DELEGATE_LABEL, fanTexts, trunkColumn, trunkText } from './render/boxes/connectors'
import { JEV_IDLE, JEV_TITLE, MAX_FLAG_BAR, MIN_FLAG_BAR, PART_GAP, callingText, jevBoxRows } from './render/boxes/jev-box'
import { LEGEND_TITLE, SWATCH, legendParts } from './render/boxes/legend'
import { NO_EVENTS, logRows } from './render/boxes/log-box'
import { MAIN_TITLE, mainFacts, mainLines, mainStatus } from './render/boxes/main-box'
import { STATUS_GAP, statusForms, statusParts } from './render/boxes/status-row'
import { MAX_GAUGE, gaugeBar, usageRows } from './render/boxes/usage-box'
import {
  ADVISOR_COLUMNS,
  GAP,
  MAIN_LINES,
  WIDE_COLUMNS,
  boxRow,
  fitParts,
  fitRows,
  geometry,
  paneColumns,
  partsWidth,
  rowBudget,
  variant,
} from './render/layout'
import type { BoxRow, Geometry, RowBudget } from './render/layout'
import { paneBudget, renderPane } from './render/pane'
import type { PaneData } from './render/pane'
import { clockTime } from './render/sections/jev'
import { statsLines } from './render/sections/stats'
import { clip, widthOf } from './render/text'
import { COLORS } from './render/theme'
import type { Kit } from './render/theme'
import { EMPTY_STATS, statusText } from './stats'
import { EMPTY_TREE, applyStep, applyToolCall, applyTurnComplete, emptyTree, upsertFromSpawn } from './tree'

// C7a: the pane's layout. The paneColumns option (PRD M-L2): the body
// columns both `$.ui.open` calls ask the dock for. The geometry, the row
// budget, each box's lines, the wide and the narrow composition. Drawn two
// ways: through the plugin (the kit's mount, terminal and desktop: the
// engine's own elements, never a surface's paint) and through plain-data
// element constructors (the d.ts's ElementConstructor: props with their
// children in, a plain element out) whose drawings are measured by a model
// of the flex layout for the shapes the pane draws. The model is not the
// surface's paint: the real drawing is the owner's screenshot round.

describe('the paneColumns option', () => {
  test('a whole number within 60 to 160; 92 when unreadable', () => {
    expect(paneColumns(59)).toBe(60)
    expect(paneColumns(161)).toBe(160)
    expect(paneColumns('abc')).toBe(92)
    expect(paneColumns(undefined)).toBe(92)

    expect(paneColumns(60)).toBe(60)
    expect(paneColumns(92)).toBe(92)
    expect(paneColumns(160)).toBe(160)
    expect(paneColumns(100.4)).toBe(100)
    expect(paneColumns(-5)).toBe(60)
    expect(paneColumns('120')).toBe(120)

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, null, true, '', '  ', ['100']]) {
      expect(paneColumns(value), String(value)).toBe(92)
    }
  })

  /** The world beneath the plugin: every `$.ui.open` it makes, answered drawn or not, and the panes the engine lists. */
  function opens(on: On, isPlaced: boolean): { id: string; columns: unknown }[] {
    const calls: { id: string; columns: unknown }[] = []

    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.panes', () => ({ value: [] }))
    on('ui.open', ($, e) => {
      calls.push({ id: e.id, columns: e.columns })

      return isPlaced ? { value: { isPlaced: true } } : { value: { isPlaced: false, reason: 'no room' } }
    })

    return calls
  }

  const toggle = ($: Engine) =>
    $.command.run({
      command: 'agent-tree',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })

  test('both opens ask for the option: session.start (autoOpen) and /agent-tree', { options: { autoOpen: true, paneColumns: 120 } }, async ($, on) => {
    const calls = opens(on, false)

    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })
    await toggle($)

    expect(calls).toEqual([
      { id: 'agent-tree', columns: 120 },
      { id: 'agent-tree', columns: 120 },
    ])
  })

  test('the option left out: both opens ask for 92', { options: { autoOpen: true } }, async ($, on) => {
    const calls = opens(on, false)

    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })
    await toggle($)

    expect(calls.map(call => call.columns)).toEqual([92, 92])
  })

  test('the narrowest the manifest allows is asked for as it stands: 60', { options: { autoOpen: true, paneColumns: 60 } }, async ($, on) => {
    const calls = opens(on, false)

    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })
    await toggle($)

    expect(calls.map(call => call.columns)).toEqual([60, 60])
  })
})

// The model of the flex layout the pane's shapes rely on (Ink's Box over
// Yoga): a Box is a row unless it says `column`; a bordered Box takes a
// column on each side and `paddingX` more; a Box with a `width` is that wide;
// without one it fills a column parent and wraps its content inside a row
// parent; children of a row sit side by side with `gap` / `columnGap`
// between and, unless `alignItems` is `flex-start`, stretch to the tallest;
// `flexWrap` starts a new line before a child that does not fit; a Text is
// one line, and a Text wider than the room it is given is a failure here
// (the real one would truncate it), so a drawing that paints is a drawing
// whose every text fits its box.

type Node = string | Drawn

type Drawn = { type: string; props: Record<string, unknown>; children: Node[] }

function flatChildren(children: unknown): Node[] {
  if (Array.isArray(children)) {
    return children.flatMap(flatChildren)
  }

  if (children === null || children === undefined || typeof children === 'boolean') {
    return []
  }

  return [typeof children === 'number' ? String(children) : (children as Node)]
}

/** An element constructor as the d.ts types it: props and children in, a plain element out. */
const standIn =
  (type: string) =>
  ({ children, ...props }: Record<string, unknown>): Drawn => ({ type, props, children: flatChildren(children) })

const KIT = { Box: standIn('Box'), Text: standIn('Text') } as unknown as Kit

const spaces = (count: number): string => ' '.repeat(Math.max(0, count))

const padTo = (text: string, width: number): string => text + spaces(width - widthOf(text))

const blockWidth = (block: readonly string[]): number => widthOf(block[0] ?? '')

/** `node` in `room` columns as one string per row. `inRow`: a child of a row, so a Box with no width is as wide as its content. `height`: stretched to a taller sibling. */
function paint(node: Node, room: number, inRow: boolean, height?: number): string[] {
  if (typeof node === 'string') {
    return [node]
  }

  if (node.type === 'Text') {
    const text = node.children.filter((child): child is string => typeof child === 'string').join('')

    if (widthOf(text) > room) {
      throw new Error(`Text ${JSON.stringify(text)} is ${widthOf(text)} wide in ${room}`)
    }

    return [text]
  }

  const props = node.props
  const hasBorder = props.borderStyle !== undefined
  const paddingX = typeof props.paddingX === 'number' ? props.paddingX : 0
  const gap = typeof props.gap === 'number' ? props.gap : typeof props.columnGap === 'number' ? props.columnGap : 0
  const explicit = typeof props.width === 'number' ? props.width : undefined
  const frame = (hasBorder ? 2 : 0) + 2 * paddingX

  if (explicit !== undefined && explicit > room) {
    throw new Error(`Box ${explicit} wide in ${room}`)
  }

  const inner = (explicit ?? room) - frame
  let body: string[]

  if (props.flexDirection === 'column') {
    body = node.children.flatMap(child => paint(child, inner, false).map(line => padTo(line, inner)))
  } else if (props.flexWrap === 'wrap') {
    const lines: Node[][] = [[]]
    let used = 0

    for (const child of node.children) {
      const width = blockWidth(paint(child, inner, true))
      const line = lines[lines.length - 1] ?? []

      if (line.length > 0 && used + gap + width > inner) {
        lines.push([child])
        used = width
      } else {
        line.push(child)
        used = line.length === 1 ? width : used + gap + width
      }
    }

    body = lines.flatMap(line => paintRow(line, inner, gap, props.alignItems === 'flex-start'))
  } else {
    body = paintRow(node.children, inner, gap, props.alignItems === 'flex-start')
  }

  const content = body.reduce((most, line) => Math.max(most, widthOf(line)), 0)
  const width = explicit ?? (inRow ? content + frame : room)

  if (width > room) {
    throw new Error(`Box ${width} wide in ${room}`)
  }

  let lines = body.map(line => padTo(line, width - frame))

  while (height !== undefined && lines.length < height - (hasBorder ? 2 : 0)) {
    lines.push(spaces(width - frame))
  }

  if (hasBorder) {
    lines = [
      `┌${'─'.repeat(width - 2)}┐`,
      ...lines.map(line => `│${spaces(paddingX)}${line}${spaces(paddingX)}│`),
      `└${'─'.repeat(width - 2)}┘`,
    ]
  } else if (paddingX > 0) {
    lines = lines.map(line => `${spaces(paddingX)}${line}${spaces(paddingX)}`)
  }

  return lines
}

/** The children of a row side by side: top-aligned, or each stretched to the tallest. */
function paintRow(children: Node[], inner: number, gap: number, isTopAligned: boolean): string[] {
  const blocks = children.map(child => paint(child, inner, true))
  const tallest = blocks.reduce((most, block) => Math.max(most, block.length), 0)
  const painted = isTopAligned
    ? blocks
    : children.map((child, index) => ((blocks[index]?.length ?? 0) < tallest ? paint(child, inner, true, tallest) : (blocks[index] ?? [])))

  return Array.from({ length: tallest }, (_, row) =>
    painted.map(block => block[row] ?? spaces(blockWidth(block))).join(spaces(gap)),
  )
}

/** Every element of a drawing, outermost first. */
function elementsOf(node: Node): Drawn[] {
  return typeof node === 'string' ? [] : [node, ...node.children.flatMap(elementsOf)]
}

/** The pane of `data` at `width` through the plain-data constructors, as the model paints it: one string per row. */
function draw(data: PaneData, width: number): string[] {
  return paint(renderPane(KIT, data, width) as unknown as Drawn, width, false)
}

/** What a mounted pane drew, as the model paints it. */
async function drawnBy(ui: Pick<Mounted, 'drawn'>, width: number): Promise<string[]> {
  return paint((await ui.drawn()) as unknown as Drawn, width, false)
}

const trimmed = (lines: readonly string[]): string[] => lines.map(line => line.trimEnd())

/** `trimmed`, the times of the log's lines (the plugin's own clock, the machine's) written `hh:mm:ss`. */
const masked = (lines: readonly string[]): string[] => trimmed(lines).map(line => line.replace(/\d\d:\d\d:\d\d/g, 'hh:mm:ss'))

// What the drawings are made from: a main loop on opus at high effort, three
// subagents of three kinds in turn, a context at 41 percent and two rate
// limits, an advisor with four calls, Jev with four flags and a health score;
// neither the advisor's nor Jev's call in flight (C7c), but for the drawings
// that say so.

const NOW = 1_790_928_100_000

const SONNET = 'claude-sonnet-5-5'

/** A subagent node as the tree keeps it: running on sonnet for 150 seconds with three Grep calls. */
function agent(changes: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'a1',
    type: 'Explore',
    description: 'List the changed files',
    role: 'researcher',
    model: SONNET,
    status: 'running',
    lastTool: 'Grep',
    toolCalls: 3,
    startedAt: NOW - 150_000,
    ...changes,
  }
}

const withAgents = (agents: AgentNode[]): TreeSnapshot => ({ ...emptyTree(NOW), agents })

const withMain = (changes: Partial<MainNode>): TreeSnapshot => ({
  ...emptyTree(NOW),
  main: { turns: 3, status: 'idle', model: 'claude-opus-5-5', effort: 'high', ...changes },
})

/**
 * The tree of the drawings: the main loop tooling, then `count` subagents,
 * one after the other, of three kinds: a worker that finished after 2m31s, an
 * Explore researcher (Grep, three calls), a worker (Bash, one call).
 */
function treeOf(count: number): TreeSnapshot {
  let tree = applyStep(emptyTree(NOW - 20_000), { model: 'claude-opus-5-5', effort: 'high', now: NOW - 20_000 })

  tree = { ...tree, main: { ...tree.main, turns: 3 } }

  for (let index = 0; index < count; index += 1) {
    const kind = index % 3
    const id = `a${index}`
    const started = NOW - 151_000 + index * 1000
    const type = kind === 1 ? 'Explore' : 'general-purpose'
    const description = ['Draft the chapter outline', 'List the changed files', 'Edit the test suite'][kind] ?? ''

    tree = upsertFromSpawn(tree, { subagentType: type, description }, { agentId: id, model: SONNET }, started)

    if (kind === 1) {
      for (let call = 0; call < 3; call += 1) {
        tree = applyToolCall(tree, { agentId: id, tool: 'Grep', now: NOW })
      }
    }

    if (kind === 2) {
      tree = applyToolCall(tree, { agentId: id, tool: 'Bash', now: NOW })
    }

    if (kind === 0) {
      tree = applyTurnComplete(tree, { agentId: id, reason: 'answer', durationMs: 151_000, now: NOW })
    }
  }

  return applyToolCall(tree, { tool: 'Read', now: NOW })
}

const STATS: StatsSnapshot = {
  contextTokens: 410_000,
  contextWindow: 1_000_000,
  contextPercent: 41,
  costUsd: 1.23,
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23 },
    { kind: 'seven_day', percentUsed: 41 },
  ],
  startedAt: NOW - 2_530_000,
  updatedAt: NOW,
}

const ADVISOR: AdvisorSnapshot = {
  model: 'claude-fable-5-1',
  calls: 4,
  lastCallStartedAt: NOW - 30_000,
  lastCallAt: NOW - 9_000,
  lastLatencyMs: 21_100,
  inputTokens: 454_000,
  outputTokens: 2_000,
  source: 'append+transcript',
  inFlight: false,
  // Oldest first (C7c): the second call's start was not seen, so it has no latency.
  recentCalls: [
    { at: NOW - 400_000, latencyMs: 12_300 },
    { at: NOW - 250_000 },
    { at: NOW - 75_000, latencyMs: 18_400 },
    { at: NOW - 9_000, latencyMs: 21_100 },
  ],
}

/** The advisor's fifth call out for 3.2 seconds (C7c): its count is up, its result not in. */
const ADVISING: AdvisorSnapshot = {
  ...ADVISOR,
  calls: 5,
  lastCallStartedAt: NOW - 3_200,
  pendingCallId: 'srvtoolu_05',
  inFlight: true,
  inFlightSince: NOW - 3_200,
}

const JEV: JevSnapshot = {
  enabled: true,
  calls: 3,
  lastAt: NOW - 60_000,
  flags: [
    { key: 'looping', label: 'looping', p: 0.11, sharp: true },
    { key: 'stuck', label: 'stuck', p: 0.06, sharp: true },
    { key: 'fanout_wide', label: 'fan-out wide', p: 0.09, sharp: true },
    { key: 'near_done', label: 'near done', p: 0.18, sharp: false },
  ],
  health: 0.91,
  healthLowConfidence: false,
  inFlight: false,
}

const JEV_FAILED: JevSnapshot = { ...JEV, error: 'HTTP 401 key rejected' }

/** Jev's fourth call claimed 2 seconds ago (C7c): the attempt's time moved, the answer not in. */
const CALLING: JevSnapshot = { ...JEV, lastAt: NOW - 2_000, inFlight: true, inFlightSince: NOW - 2_000 }

/** The local times the drawings carry: the clock is the machine's, so the expected text is built the same way. */
const ADVISOR_AT = clockTime(NOW - 9_000)

/** The advisor's calls before its last (C7c), newest first. */
const CALL_75S_AGO = clockTime(NOW - 75_000)

const CALL_250S_AGO = clockTime(NOW - 250_000)

const CALL_400S_AGO = clockTime(NOW - 400_000)

const JEV_AT = clockTime(NOW - 60_000)

/** The activity of the drawings (C7b): the main loop has run Read for two seconds, as treeOf's last call. */
const ACTIVITY: ActivitySnapshot = {
  main: { phase: 'tooling', tool: 'Read', since: NOW - 2000 },
  calls: [{ id: 'toolu_read', tool: 'Read', since: NOW - 2000 }],
  updatedAt: NOW - 2000,
}

/**
 * The session log of the drawings (C7d, PRD M-L7), oldest first: a line of
 * every kind, from the person's prompt to the end of the main loop's turn,
 * the failed call and Jev's error among them. Its times are the machine's
 * local ones, as the other times of this file; the failed call's command is
 * cut at 40 characters, the way the log keeps it.
 */
const LOG: LogEntry[] = [
  { at: NOW - 40_000, who: 'main', kind: 'prompt', text: 'prompt' },
  { at: NOW - 38_000, who: 'Explore', kind: 'spawn', text: 'spawn Explore List docs files' },
  { at: NOW - 30_000, who: 'main', kind: 'tool', text: 'Read README.md' },
  { at: NOW - 21_000, who: 'Explore', kind: 'tool', text: 'Grep shouldClearRing' },
  { at: NOW - 20_000, who: 'jev', kind: 'jev', text: 'jev calling...' },
  { at: NOW - 12_000, who: 'fable', kind: 'advisor', text: 'advising...' },
  { at: NOW - 9_000, who: 'fable', kind: 'advisor', text: 'advised 21.1s' },
  { at: NOW - 8_000, who: 'jev', kind: 'jev', text: 'jev ok · calls 3' },
  { at: NOW - 7_000, who: 'main', kind: 'fail', text: 'fail Bash npm test -- --reporter=verbose' },
  { at: NOW - 6_000, who: 'jev', kind: 'fail', text: 'jev error HTTP 401 key rejected' },
  { at: NOW - 5_000, who: 'Explore', kind: 'done', text: 'done 2m31s' },
  { at: NOW - 2_000, who: 'main', kind: 'turn', text: 'turn done 41s' },
]

/** The pane's data with `count` subagents; the rows of the body only when `bodyRows` is given; no events in the log unless `log` says. */
function dataOf(count: number, bodyRows?: number, jev: JevSnapshot = JEV, log: readonly LogEntry[] = []): PaneData {
  return { tree: treeOf(count), stats: STATS, advisor: ADVISOR, jev, activity: ACTIVITY, log, now: NOW, frame: 0, bodyRows }
}

describe('variant and geometry', () => {
  test('wide from 88 body columns, narrow below (PRD M-L2)', () => {
    expect(WIDE_COLUMNS).toBe(88)
    expect([1, 60, 87].map(variant)).toEqual(['narrow', 'narrow', 'narrow'])
    expect([88, 92, 160].map(variant)).toEqual(['wide', 'wide', 'wide'])
  })

  test('wide: the advisor column keeps 30, the left column the rest; subagent boxes grow to 26, three to a line at least', () => {
    const wide = (width: number, column: number, agentBox: number, perLine: number): Geometry => ({
      variant: 'wide',
      width,
      column,
      columnInner: column - 4,
      side: 30,
      sideInner: 26,
      agentBox,
      agentInner: agentBox - 4,
      perLine,
    })

    expect(geometry(88)).toEqual(wide(88, 57, 18, 3))
    expect(geometry(92)).toEqual(wide(92, 61, 19, 3))
    expect(geometry(100)).toEqual(wide(100, 69, 22, 3))
    expect(geometry(120)).toEqual(wide(120, 89, 26, 3))
    expect(geometry(137)).toEqual(wide(137, 106, 26, 3))
    expect(geometry(138)).toEqual(wide(138, 107, 26, 4))
    expect(geometry(160)).toEqual(wide(160, 129, 26, 4))
  })

  test('narrow: one column as wide as the pane, the text room 4 less and never under 1, the subagents one to a line', () => {
    const narrow = (width: number, inner: number): Geometry => ({
      variant: 'narrow',
      width,
      column: width,
      columnInner: inner,
      side: width,
      sideInner: inner,
      agentBox: width,
      agentInner: inner,
      perLine: 1,
    })

    expect(geometry(60)).toEqual(narrow(60, 56))
    expect(geometry(87)).toEqual(narrow(87, 83))
    expect(geometry(30)).toEqual(narrow(30, 26))
    expect(geometry(5)).toEqual(narrow(5, 1))
    expect(geometry(3)).toEqual(narrow(3, 1))
    // A width with a fraction is the whole width below it; no width is 1 column.
    expect(geometry(92.7)).toEqual(geometry(92))
    expect(geometry(0)).toEqual(narrow(1, 1))
    expect(geometry(-4)).toEqual(narrow(1, 1))
  })

  test('from 60 to 160 columns the parts add up to the pane and the subagent boxes fill the column without spilling', () => {
    for (let width = 60; width <= 160; width += 1) {
      const geo = geometry(width)
      const label = `${width} columns`

      expect(geo.variant, label).toBe(width >= WIDE_COLUMNS ? 'wide' : 'narrow')

      if (geo.variant === 'narrow') {
        expect([geo.column, geo.side, geo.agentBox], label).toEqual([width, width, width])
        continue
      }

      expect(geo.column + GAP + geo.side, label).toBe(width)
      expect(geo.side, label).toBe(ADVISOR_COLUMNS)
      expect(geo.agentBox, label).toBeGreaterThanOrEqual(18)
      expect(geo.agentBox, label).toBeLessThanOrEqual(26)
      expect(geo.perLine, label).toBeGreaterThanOrEqual(3)
      expect(geo.perLine * geo.agentBox + (geo.perLine - 1) * GAP, label).toBeLessThanOrEqual(geo.column)
      expect((geo.perLine + 1) * geo.agentBox + geo.perLine * GAP, label).toBeGreaterThan(geo.column)
    }
  })
})

describe('the fitting helpers', () => {
  const ROWS = [1, 2, 3, 4]

  test('fitRows keeps the first rows that fit, and a copy when all of them do', () => {
    const all = fitRows(ROWS, 9)

    expect(all).toEqual(ROWS)
    expect(all).not.toBe(ROWS)
    expect(fitRows(ROWS, 4)).toEqual([1, 2, 3, 4])
    expect(fitRows(ROWS, 2)).toEqual([1, 2])
    expect(fitRows(ROWS, 2.9)).toEqual([1, 2])
    expect(fitRows(ROWS, 0)).toEqual([])
    expect(fitRows(ROWS, -3)).toEqual([])
    expect(fitRows([], 3)).toEqual([])
  })

  test('fitRows with the last row pinned: from two rows of room it takes the place of the last one kept (the error row)', () => {
    expect(fitRows(ROWS, 3, true)).toEqual([1, 2, 4])
    expect(fitRows(ROWS, 2, true)).toEqual([1, 4])
    expect(fitRows(ROWS, 1, true)).toEqual([1])
    expect(fitRows(ROWS, 0, true)).toEqual([])
    expect(fitRows(ROWS, 4, true)).toEqual([1, 2, 3, 4])
    expect(fitRows([], 2, true)).toEqual([])
  })

  test('partsWidth: the parts side by side with a gap between two; a wide character takes two columns', () => {
    const parts = [boxRow('abc'), boxRow('de'), boxRow('f')]

    expect(partsWidth(parts, 2)).toBe(10)
    expect(partsWidth(parts, 0)).toBe(6)
    expect(partsWidth([boxRow('abc')], 5)).toBe(3)
    expect(partsWidth([], 5)).toBe(0)
    expect(partsWidth([boxRow('调研')], 2)).toBe(4)
  })

  test('fitParts: the leading parts that fit whole; the first alone, cut and as it was styled, when even it does not', () => {
    const parts = [boxRow('aaa', '#111111'), boxRow('bbb', '#222222', { dim: true }), boxRow('cccccccc'), boxRow('d')]

    expect(fitParts(parts, 99, 2)).toEqual(parts)
    expect(fitParts(parts, 18, 2).map(part => part.text)).toEqual(['aaa', 'bbb', 'cccccccc'])
    // 'd' would fit after bbb, but the part before it ended the row.
    expect(fitParts(parts, 14, 2).map(part => part.text)).toEqual(['aaa', 'bbb'])
    expect(fitParts(parts, 8, 2).map(part => part.text)).toEqual(['aaa', 'bbb'])
    expect(fitParts(parts, 7, 2).map(part => part.text)).toEqual(['aaa'])
    expect(fitParts([boxRow('abcdefgh', '#333333', { bold: true })], 5, 2)).toEqual([
      { text: 'abcd~', color: '#333333', dim: false, bold: true },
    ])
    expect(fitParts([], 5, 2)).toEqual([])
  })
})

describe('the row budget', () => {
  /** What the boxes would draw in full, as the drawings of this file want it. */
  const WANT = { jev: 6, advisor: 5, usage: 5, log: 1 }

  /** A budget on one line: the legend (L) and the connectors (C), then the lines each box draws, then the rows it all takes. */
  function brief(budget: RowBudget): string {
    const flags = `${budget.legend ? 'L' : '-'}${budget.trunk && budget.fan ? 'C' : '-'}`

    return `${flags} jev ${budget.jev} agents ${budget.agents} advisor ${budget.advisor} usage ${budget.usage} log ${budget.log} = ${budget.height}`
  }

  const budgetAt = (width: number, agentCount: number, bodyRows?: number, want = WANT): string =>
    brief(rowBudget({ geometry: geometry(width), bodyRows, want, agentCount }))

  test('no body rows: every box draws all its lines, the wide pane its legend and connectors too', () => {
    expect(budgetAt(92, 3)).toBe('LC jev 6 agents 1 advisor 5 usage 5 log 1 = 31')
    expect(budgetAt(92, 0)).toBe('LC jev 6 agents 1 advisor 5 usage 5 log 1 = 28')
    expect(budgetAt(92, 7)).toBe('LC jev 6 agents 3 advisor 5 usage 5 log 1 = 43')
    expect(budgetAt(60, 3)).toBe('-- jev 6 agents 3 advisor 5 usage 5 log 1 = 35')
    expect(budgetAt(60, 0)).toBe('-- jev 6 agents 1 advisor 5 usage 5 log 1 = 33')
    expect(budgetAt(60, 12)).toBe('-- jev 6 agents 12 advisor 5 usage 5 log 1 = 44')

    // The main box is always its two lines.
    expect(rowBudget({ geometry: geometry(92), want: WANT, agentCount: 3 }).main).toBe(MAIN_LINES)
    expect(MAIN_LINES).toBe(2)
  })

  test('rows to spare are no budget at all', () => {
    for (const [width, count] of [
      [92, 3],
      [92, 12],
      [160, 7],
      [60, 3],
      [60, 12],
    ] as const) {
      const full = rowBudget({ geometry: geometry(width), want: WANT, agentCount: count })

      expect(rowBudget({ geometry: geometry(width), bodyRows: full.height, want: WANT, agentCount: count }), `${width} columns, ${count} subagents, ${full.height} rows`).toEqual(full)
      expect(rowBudget({ geometry: geometry(width), bodyRows: 500, want: WANT, agentCount: count }), `${width} columns, ${count} subagents, 500 rows`).toEqual(full)
    }
  })

  test('the parts always drawn take their rows past the body rows: the status row, the main box, the first subagent line', () => {
    // Wide: one line of subagent boxes (an empty-state box when there are none).
    for (const rows of [0, 1, 5, 10, 11]) {
      expect(budgetAt(92, 3, rows), `${rows} rows`).toBe('-- jev 0 agents 1 advisor 5 usage 0 log 0 = 11')
    }

    expect(budgetAt(92, 0, 0)).toBe('-- jev 0 agents 1 advisor 5 usage 0 log 0 = 8')
    // Narrow: the latest subagent and a `+k more` line, or the one subagent there is.
    for (const rows of [0, 5, 9]) {
      expect(budgetAt(60, 3, rows), `${rows} rows`).toBe('-- jev 0 agents 2 advisor 0 usage 0 log 0 = 9')
    }

    expect(budgetAt(60, 1, 0)).toBe('-- jev 0 agents 1 advisor 0 usage 0 log 0 = 8')
    expect(budgetAt(60, 0, 0)).toBe('-- jev 0 agents 1 advisor 0 usage 0 log 0 = 8')
  })

  test('wide, 92 columns, three subagents: Jev line by line, then usage, then the connectors, then the legend; the advisor stands beside', () => {
    const table = [
      [11, '-- jev 0 agents 1 advisor 5 usage 0 log 0 = 11'],
      // One row of the legend fits where a box cannot.
      [12, 'L- jev 0 agents 1 advisor 5 usage 0 log 0 = 12'],
      [13, 'L- jev 0 agents 1 advisor 5 usage 0 log 0 = 12'],
      // The Jev box's first line costs its border too; every line after it one row.
      [14, '-- jev 1 agents 1 advisor 5 usage 0 log 0 = 14'],
      [16, '-- jev 3 agents 1 advisor 5 usage 0 log 0 = 16'],
      [19, '-- jev 6 agents 1 advisor 5 usage 0 log 0 = 19'],
      [20, 'L- jev 6 agents 1 advisor 5 usage 0 log 0 = 20'],
      [21, 'L- jev 6 agents 1 advisor 5 usage 0 log 0 = 20'],
      // The usage box line by line; the log box stands beside it with its lines.
      [22, '-- jev 6 agents 1 advisor 5 usage 1 log 1 = 22'],
      [25, '-- jev 6 agents 1 advisor 5 usage 4 log 1 = 25'],
      [26, '-- jev 6 agents 1 advisor 5 usage 5 log 1 = 26'],
      [27, 'L- jev 6 agents 1 advisor 5 usage 5 log 1 = 27'],
      [29, 'L- jev 6 agents 1 advisor 5 usage 5 log 1 = 27'],
      // The trunk and the fan come together, and before the legend.
      [30, '-C jev 6 agents 1 advisor 5 usage 5 log 1 = 30'],
      [31, 'LC jev 6 agents 1 advisor 5 usage 5 log 1 = 31'],
      [100, 'LC jev 6 agents 1 advisor 5 usage 5 log 1 = 31'],
    ] as const

    for (const [rows, expected] of table) {
      expect(budgetAt(92, 3, rows), `${rows} rows`).toBe(expected)
    }
  })

  test('narrow, 60 columns, three subagents: Jev, more subagent lines, the advisor, usage, then the log', () => {
    const table = [
      [9, '-- jev 0 agents 2 advisor 0 usage 0 log 0 = 9'],
      // The third subagent line takes the one row a Jev line cannot use.
      [10, '-- jev 0 agents 3 advisor 0 usage 0 log 0 = 10'],
      [11, '-- jev 0 agents 3 advisor 0 usage 0 log 0 = 10'],
      [12, '-- jev 1 agents 2 advisor 0 usage 0 log 0 = 12'],
      [17, '-- jev 6 agents 2 advisor 0 usage 0 log 0 = 17'],
      [18, '-- jev 6 agents 3 advisor 0 usage 0 log 0 = 18'],
      [21, '-- jev 6 agents 3 advisor 1 usage 0 log 0 = 21'],
      [25, '-- jev 6 agents 3 advisor 5 usage 0 log 0 = 25'],
      [28, '-- jev 6 agents 3 advisor 5 usage 1 log 0 = 28'],
      [32, '-- jev 6 agents 3 advisor 5 usage 5 log 0 = 32'],
      [34, '-- jev 6 agents 3 advisor 5 usage 5 log 0 = 32'],
      // The log box needs its border and one line.
      [35, '-- jev 6 agents 3 advisor 5 usage 5 log 1 = 35'],
      [100, '-- jev 6 agents 3 advisor 5 usage 5 log 1 = 35'],
    ] as const

    for (const [rows, expected] of table) {
      expect(budgetAt(60, 3, rows), `${rows} rows`).toBe(expected)
    }
  })

  test('more subagents than a line holds: their lines come before usage, the connectors and the legend', () => {
    // Seven subagents at 92 columns want three lines of three; twelve want four.
    expect(budgetAt(92, 7, 40)).toBe('L- jev 6 agents 3 advisor 5 usage 5 log 1 = 39')
    expect(budgetAt(92, 12, 40)).toBe('-- jev 6 agents 4 advisor 5 usage 1 log 1 = 40')
    expect(budgetAt(92, 12, 14)).toBe('-- jev 1 agents 1 advisor 5 usage 0 log 0 = 14')
    expect(budgetAt(60, 12, 40)).toBe('-- jev 6 agents 12 advisor 5 usage 4 log 0 = 40')
    expect(budgetAt(60, 12, 10)).toBe('-- jev 0 agents 3 advisor 0 usage 0 log 0 = 10')
  })

  test('the log box takes what is left: wide, beside the usage box and at least its lines; narrow, from three rows', () => {
    const roomy = { ...WANT, log: 9 }

    expect(budgetAt(92, 3, 31, roomy)).toBe('LC jev 6 agents 1 advisor 5 usage 5 log 5 = 31')
    expect(budgetAt(92, 3, 33, roomy)).toBe('LC jev 6 agents 1 advisor 5 usage 5 log 7 = 33')
    expect(budgetAt(92, 3, 40, roomy)).toBe('LC jev 6 agents 1 advisor 5 usage 5 log 9 = 35')
    expect(budgetAt(60, 3, 36, roomy)).toBe('-- jev 6 agents 3 advisor 5 usage 5 log 2 = 36')
    expect(budgetAt(60, 3, 100, roomy)).toBe('-- jev 6 agents 3 advisor 5 usage 5 log 9 = 43')
  })

  test('the advisor column is cut to the height of the left column it stands beside', () => {
    const tall = { ...WANT, advisor: 9 }

    // The left column is 10 rows at the least (main box 4, one line of boxes 6): room for 8 lines.
    expect(budgetAt(92, 3, 11, tall)).toBe('-- jev 0 agents 1 advisor 8 usage 0 log 0 = 11')
    expect(budgetAt(92, 3, undefined, tall)).toBe('LC jev 6 agents 1 advisor 9 usage 5 log 1 = 31')
  })

  test('with the budget taken: no part is above what it wants, the height is as promised, and the parts always drawn are there', () => {
    const wants = [WANT, { jev: 1, advisor: 3, usage: 3, log: 1 }]

    for (const width of [30, 60, 87, 88, 92, 100, 138, 160]) {
      const geo = geometry(width)

      for (const want of wants) {
        for (const count of [0, 1, 2, 3, 4, 7, 12, 40]) {
          const isWide = geo.variant === 'wide'
          const agentsWant = isWide ? (count === 0 ? 1 : Math.ceil(count / geo.perLine)) : Math.max(1, count)
          // The status row, the main box and the first line of subagents (narrow: two when there are two).
          const floor = 1 + 4 + (isWide ? (count === 0 ? 3 : 6) : count >= 2 ? 4 : 3)
          const full = rowBudget({ geometry: geo, want, agentCount: count })

          expect(full, `${width} columns, ${count} subagents: no budget`).toMatchObject({
            main: MAIN_LINES,
            jev: want.jev,
            agents: agentsWant,
            advisor: want.advisor,
            usage: want.usage,
            log: want.log,
            legend: isWide,
            trunk: isWide,
            fan: isWide,
          })

          for (let rows = 0; rows <= 80; rows += 1) {
            const label = `${width} columns, ${count} subagents, ${rows} rows`
            const budget = rowBudget({ geometry: geo, bodyRows: rows, want, agentCount: count })

            expect(budget.main, label).toBe(MAIN_LINES)
            expect(budget.trunk, label).toBe(budget.fan)
            expect(!isWide && (budget.legend || budget.trunk), label).toBe(false)
            expect(budget.jev, label).toBeLessThanOrEqual(want.jev)
            expect(budget.advisor, label).toBeLessThanOrEqual(want.advisor)
            expect(budget.usage, label).toBeLessThanOrEqual(want.usage)
            expect(budget.log, label).toBeLessThanOrEqual(want.log)
            expect(budget.agents, label).toBeGreaterThanOrEqual(1)
            expect(budget.agents, label).toBeLessThanOrEqual(agentsWant)
            expect(budget.height, label).toBeGreaterThanOrEqual(floor)
            expect(budget.height, label).toBeLessThanOrEqual(Math.max(rows, floor))
            expect(budget.height, label).toBeLessThanOrEqual(full.height)
          }
        }
      }
    }
  })

  test('odd inputs: a fraction of rows is floored; no usable rows is no budget; a count or want below 0 is 0', () => {
    const geo = geometry(92)
    const at = (bodyRows?: number, agentCount: number = 3, want = WANT): RowBudget => rowBudget({ geometry: geo, bodyRows, want, agentCount })

    expect(at(14.9)).toEqual(at(14))
    expect(at(Number.NaN)).toEqual(at())
    expect(at(Number.POSITIVE_INFINITY)).toEqual(at())
    expect(at(undefined, -2)).toEqual(at(undefined, 0))
    expect(at(undefined, 2.7)).toEqual(at(undefined, 2))
    expect(brief(at(undefined, 3, { jev: -1, advisor: -1, usage: -1, log: -1 }))).toBe('LC jev 0 agents 1 advisor 0 usage 0 log 0 = 16')
  })

  test('paneBudget asks each box for the lines it would draw at its own text room', () => {
    // Wide: Jev at 57 (five lines, the flags two to a line), the advisor at 26
    // (ten, four of them its latest calls) beside the left column, usage at 26
    // (five), the log's placeholder.
    expect(brief(paneBudget(dataOf(3), geometry(92)))).toBe('LC jev 5 agents 1 advisor 10 usage 5 log 1 = 30')
    // Narrow, 60 columns: Jev's first two lines (PRD M-L6); the advisor's calls and tokens share a line of 56, usage packs into four.
    expect(brief(paneBudget(dataOf(3), geometry(60)))).toBe('-- jev 2 agents 3 advisor 9 usage 4 log 1 = 34')
    expect(brief(paneBudget(dataOf(3, 12), geometry(60)))).toBe('-- jev 1 agents 2 advisor 0 usage 0 log 0 = 12')
    // Jev off is one row of one line; no subagents is the empty-state box.
    expect(brief(paneBudget({ ...dataOf(0), jev: EMPTY_JEV }, geometry(92)))).toBe('LC jev 1 agents 1 advisor 10 usage 5 log 1 = 23')
    // A failure adds its line to the narrow box too (C4f).
    expect(brief(paneBudget(dataOf(3, undefined, JEV_FAILED), geometry(60)))).toBe('-- jev 3 agents 3 advisor 9 usage 4 log 1 = 35')
  })
})

describe('the main box lines', () => {
  test('mainFacts: the model without its prefix and date tail, the effort and the turn; -- while no model is read', () => {
    expect(MAIN_TITLE).toBe('main session')
    expect(mainFacts(withMain({}))).toBe('opus-5-5 · high · turn 3')
    expect(mainFacts(withMain({ effort: undefined }))).toBe('opus-5-5 · turn 3')
    expect(mainFacts(withMain({ model: 'claude-sonnet-4-5-20250929' }))).toBe('sonnet-4-5 · high · turn 3')
    expect(mainFacts(withMain({ model: undefined, effort: undefined, turns: 0 }))).toBe('-- · turn 0')
    expect(mainFacts(EMPTY_TREE)).toBe('-- · turn 0')
  })

  test('mainStatus: idle bare; thinking and tooling <tool> behind the spinner glyph of the frame, with the time since the phase began (C7b)', () => {
    expect(mainStatus({ phase: 'idle' }, 2, NOW)).toBe('idle')
    expect(mainStatus({ phase: 'thinking', since: NOW - 3000 }, 0, NOW)).toBe('◐ thinking 3s')
    expect(mainStatus({ phase: 'tooling', tool: 'Read', since: NOW - 2000 }, 1, NOW)).toBe('◓ tooling Read 2s')
    expect(mainStatus({ phase: 'thinking', since: NOW - 75_000 }, 6, NOW)).toBe('◑ thinking 1m15s')
    expect(mainStatus({ phase: 'tooling', tool: 'Bash', since: NOW }, 3, NOW)).toBe('◒ tooling Bash 0s')
  })

  test('mainLines: the facts give way first (cut, then left out), then the title and the status are cut', () => {
    const view = { tree: withMain({ status: 'tooling' }), activity: ACTIVITY, frame: 0, now: NOW }

    expect(mainLines(view, 57)).toEqual({ title: 'main session', facts: 'opus-5-5 · high · turn 3', status: '◐ tooling Read 2s' })
    // 20 columns: 12 for the title, 2 between, 6 left for the facts.
    expect(mainLines(view, 20)).toEqual({ title: 'main session', facts: 'opus-~', status: '◐ tooling Read 2s' })
    expect(mainLines(view, 14).facts).toBe('')
    expect(mainLines(view, 8)).toEqual({ title: 'main se~', facts: '', status: '◐ tooli~' })
  })
})

describe('the Jev box lines', () => {
  /** Jev as the box draws it (C7c): at NOW, on `frame`. */
  const viewOf = (jev: JevSnapshot, frame: number = 0) => ({ jev, frame, now: NOW })

  /** Each line as drawn: its parts PART_GAP apart. */
  const linesOf = (lines: readonly (readonly BoxRow[])[]): string[] => lines.map(parts => parts.map(part => part.text).join(' '.repeat(PART_GAP)))

  const jevPart = (text: string, style: { dim?: boolean; bold?: boolean; inverse?: boolean } = {}): BoxRow => boxRow(text, COLORS.jev, style)

  const WAITING: JevSnapshot = { ...EMPTY_JEV, enabled: true }

  test('wide, 57 columns of text (the pane at 92): the title and idle, the calls and the last attempt, the flags two to a line with bars, the health score (PRD M-L6)', () => {
    expect([JEV_TITLE, JEV_IDLE, PART_GAP]).toEqual(['JEV · advisory', 'idle', 2])
    expect(linesOf(jevBoxRows(viewOf(JEV), 57, true))).toEqual([
      'JEV · advisory  idle',
      `calls 3 · last ${JEV_AT}`,
      'looping      █░░░░ 0.11 sharp  stuck     ░░░░░ 0.06 sharp',
      'fan-out wide ░░░░░ 0.09 sharp  near done █░░░░ 0.18 split',
      'health 0.9 needs attention',
    ])
    expect(jevBoxRows(viewOf(JEV), 57, true).map(parts => partsWidth(parts, PART_GAP))).toEqual([20, 23, 57, 57, 26])
  })

  test('the bars: the longest with which every flag line fits, from MAX_FLAG_BAR cells down to MIN_FLAG_BAR; then the numbers alone; then one flag a line, cut', () => {
    /** The cells of the first flag line's two bars. */
    const cellsAt = (inner: number): number => (linesOf(jevBoxRows(viewOf(JEV), inner, true))[2]?.match(/[█░]/g) ?? []).length

    expect([MAX_FLAG_BAR, MIN_FLAG_BAR]).toEqual([10, 3])
    // Two bars a line, so a cell more takes two columns. The pane at 100 and 88 columns: 65 and 53 of text.
    expect([200, 67, 66, 65, 57, 54, 53, 52, 45].map(cellsAt)).toEqual([20, 20, 18, 18, 10, 6, 6, 0, 0])
    expect(linesOf(jevBoxRows(viewOf(JEV), 65, true)).slice(2, 4)).toEqual([
      'looping      █░░░░░░░░ 0.11 sharp  stuck     █░░░░░░░░ 0.06 sharp',
      'fan-out wide █░░░░░░░░ 0.09 sharp  near done ██░░░░░░░ 0.18 split',
    ])
    expect(linesOf(jevBoxRows(viewOf(JEV), 53, true)).slice(2, 4)).toEqual([
      'looping      ░░░ 0.11 sharp  stuck     ░░░ 0.06 sharp',
      'fan-out wide ░░░ 0.09 sharp  near done █░░ 0.18 split',
    ])
    expect(linesOf(jevBoxRows(viewOf(JEV), 45, true)).slice(2, 4)).toEqual([
      'looping      0.11 sharp  stuck     0.06 sharp',
      'fan-out wide 0.09 sharp  near done 0.18 split',
    ])
    // Three flags: the last line has one, and the bars may grow to the room the first leaves.
    expect(linesOf(jevBoxRows(viewOf({ ...JEV, flags: JEV.flags.slice(0, 3) }), 57, true)).slice(2, 4)).toEqual([
      'looping      █░░░░░░ 0.11 sharp  stuck ░░░░░░░ 0.06 sharp',
      'fan-out wide █░░░░░░ 0.09 sharp',
    ])
    // Not even two numbers a line: one flag a line, its label padded to the widest, cut to the room.
    expect(linesOf(jevBoxRows(viewOf(JEV), 44, true))).toEqual([
      'JEV · advisory  idle',
      `calls 3 · last ${JEV_AT}`,
      'looping      0.11 sharp',
      'stuck        0.06 sharp',
      'fan-out wide 0.09 sharp',
      'near done    0.18 split',
      'health 0.9 needs attention',
    ])
    expect(linesOf(jevBoxRows(viewOf(JEV), 20, true))[2]).toBe('looping      0.11 s~')
  })

  test('the style: every part in Jev green, the title plain and `idle` while no call is out; a looping or stuck flag from 0.8 in the fail red', () => {
    const lines = jevBoxRows(viewOf(JEV), 57, true)

    expect(lines[0]).toEqual([jevPart(JEV_TITLE), jevPart(JEV_IDLE)])
    expect(lines.flat().every(part => part.color === COLORS.jev && !part.bold && !part.dim && part.inverse === undefined)).toBe(true)

    const alarm = jevBoxRows(
      viewOf({
        ...JEV,
        flags: [
          { key: 'looping', label: 'looping', p: 0.84, sharp: true },
          { key: 'stuck', label: 'stuck', p: 0.8, sharp: false },
          { key: 'near_done', label: 'near done', p: 0.95, sharp: true },
          { key: 'fanout_wide', label: 'fan-out wide', p: 0.99, sharp: true },
        ],
      }),
      57,
      true,
    )

    expect(alarm.slice(2, 4).map(parts => parts.map(part => part.color))).toEqual([
      [COLORS.fail, COLORS.fail],
      [COLORS.jev, COLORS.jev],
    ])
  })

  test('a call in flight (C7c): the title bold and `◐ calling now… 2s` beside it in inverse, the spinner of the frame and the time since the claim; stale or with no start, idle', () => {
    expect(jevBoxRows(viewOf(CALLING, 2), 57, true)[0]).toEqual([jevPart(JEV_TITLE, { bold: true }), jevPart('◑ calling now… 2s', { inverse: true })])
    expect(jevBoxRows(viewOf(CALLING, 2), 57, true).slice(1).flat().every(part => !part.bold && part.inverse === undefined)).toBe(true)
    expect(callingText(CALLING, 3, NOW + 63_000)).toBe('◒ calling now… 1m05s')
    // Ten minutes after the claim the flag is stale; a flag with no start is too.
    expect(linesOf(jevBoxRows({ jev: CALLING, frame: 0, now: NOW - 2_000 + IN_FLIGHT_STALE_MS }, 57, true))[0]).toBe('JEV · advisory  idle')
    expect(linesOf(jevBoxRows({ jev: CALLING, frame: 0, now: NOW - 2_001 + IN_FLIGHT_STALE_MS }, 57, true))[0]).toBe('JEV · advisory  ◐ calling now… 9m59s')
    expect(jevBoxRows(viewOf({ ...CALLING, inFlightSince: undefined }), 57, true)[0]).toEqual([jevPart(JEV_TITLE), jevPart(JEV_IDLE)])
    // Short of room: `JEV` and the activity, then the activity alone, cut.
    expect([33, 32, 22, 21, 17, 10].map(inner => linesOf(jevBoxRows(viewOf(CALLING), inner, true))[0])).toEqual([
      'JEV · advisory  ◐ calling now… 2s',
      'JEV  ◐ calling now… 2s',
      'JEV  ◐ calling now… 2s',
      '◐ calling now… 2s',
      '◐ calling now… 2s',
      '◐ calling~',
    ])
    expect(jevBoxRows(viewOf(CALLING), 10, true)[0]).toEqual([jevPart('◐ calling~', { inverse: true })])
  })

  test('the narrow box (PRD M-L6): the first two lines, and a failure after them; Jev on before its first call: `calls 0 · waiting for events`, dim', () => {
    expect(linesOf(jevBoxRows(viewOf(JEV), 56, false))).toEqual(['JEV · advisory  idle', `calls 3 · last ${JEV_AT}`])
    expect(linesOf(jevBoxRows(viewOf(JEV_FAILED), 56, false))).toEqual(['JEV · advisory  idle', `calls 3 · last ${JEV_AT}`, 'JEV error: HTTP 401 key rejected'])
    expect(linesOf(jevBoxRows(viewOf(CALLING), 56, false))[0]).toBe('JEV · advisory  ◐ calling now… 2s')
    expect(jevBoxRows(viewOf(WAITING), 57, true)).toEqual([[jevPart(JEV_TITLE), jevPart(JEV_IDLE)], [jevPart('calls 0 · waiting for events', { dim: true })]])
    expect(jevBoxRows(viewOf(WAITING), 56, false)).toEqual(jevBoxRows(viewOf(WAITING), 57, true))
  })

  test('a failure: `JEV error: …` in the fail red, last, the answer before it kept (C4f); fewer lines of room keep the first ones, and from two the error line stays last', () => {
    const failed = jevBoxRows(viewOf(JEV_FAILED), 57, true)

    expect(failed).toHaveLength(6)
    expect(failed[5]).toEqual([boxRow('JEV error: HTTP 401 key rejected', COLORS.fail)])
    expect(linesOf(failed.slice(0, 5))).toEqual(linesOf(jevBoxRows(viewOf(JEV), 57, true)))
    expect(linesOf(jevBoxRows(viewOf(JEV), 57, true, 3))).toEqual([
      'JEV · advisory  idle',
      `calls 3 · last ${JEV_AT}`,
      'looping      █░░░░ 0.11 sharp  stuck     ░░░░░ 0.06 sharp',
    ])
    expect(jevBoxRows(viewOf(JEV), 57, true, 0)).toEqual([])
    expect(jevBoxRows(viewOf(JEV), 57, true, 9)).toHaveLength(5)
    expect(linesOf(jevBoxRows(viewOf(JEV_FAILED), 57, true, 3))).toEqual(['JEV · advisory  idle', `calls 3 · last ${JEV_AT}`, 'JEV error: HTTP 401 key rejected'])
    expect(linesOf(jevBoxRows(viewOf(JEV_FAILED), 57, true, 2))).toEqual(['JEV · advisory  idle', 'JEV error: HTTP 401 key rejected'])
    expect(linesOf(jevBoxRows(viewOf(JEV_FAILED), 57, true, 1))).toEqual(['JEV · advisory  idle'])
  })

  test('off: one dim line, no error and no call drawn, whatever the room; every line fits its room', () => {
    const off = (inner: number) => [[jevPart(clip('Jev off — enable in /plugin configure agent-tree@agent-tree', inner), { dim: true })]]

    expect(jevBoxRows(viewOf(EMPTY_JEV), 100, true)).toEqual(off(100))
    expect(jevBoxRows(viewOf(EMPTY_JEV), 57, true)).toEqual(off(57))
    expect(jevBoxRows(viewOf({ ...CALLING, enabled: false, error: 'HTTP 500' }), 57, true, 3)).toEqual(off(57))
    expect(jevBoxRows(viewOf({ ...CALLING, enabled: false }), 56, false)).toEqual(off(56))

    for (const jev of [EMPTY_JEV, WAITING, JEV, JEV_FAILED, CALLING]) {
      for (const inner of [1, 2, 5, 10, 17, 20, 26, 33, 44, 45, 53, 56, 57, 65, 100]) {
        for (const isWide of [true, false]) {
          const too = jevBoxRows(viewOf(jev), inner, isWide).filter(parts => partsWidth(parts, PART_GAP) > inner)

          expect(linesOf(too), `${inner} columns, ${isWide ? 'wide' : 'narrow'}`).toEqual([])
        }
      }
    }
  })
})

describe('the subagent box lines', () => {
  /** `count` subagents in tree order a1, a2, ... */
  const many = (count: number): TreeSnapshot =>
    withAgents(Array.from({ length: count }, (_, index) => agent({ id: `a${index + 1}`, startedAt: NOW - 100_000 + index * 1000 })))

  const sub = (text: string, style: { dim?: boolean; bold?: boolean } = {}) => boxRow(text, COLORS.sub, style)

  test('roleWord: the role the tree recorded; a node kept from before C7a has none and is read from its type and description', () => {
    expect(roleWord(agent({ role: 'worker' }))).toBe('worker')
    expect(roleWord(agent({ role: 'researcher', type: 'general-purpose', description: 'Fix the build' }))).toBe('researcher')

    const { role: _role, ...legacy } = agent()

    expect(roleWord(legacy as AgentNode)).toBe('researcher')
    expect(roleWord({ ...legacy, type: 'general-purpose', description: 'Fix the build' } as AgentNode)).toBe('worker')
    expect(roleWord({ ...legacy, type: 'general-purpose', description: 'Find the bug' } as AgentNode)).toBe('researcher')
    // Anything else in the field is no role.
    expect(roleWord(agent({ role: 'boss' as never, type: 'general-purpose', description: 'Fix the build' }))).toBe('worker')
  })

  test('kindText: model · type whole when it fits; else the model whole and the type cut while three characters of it stay; else the model alone', () => {
    const node = agent()

    // Whole: `sonnet-5-5 · Explore` is 20 columns.
    expect(kindText(node, 40)).toBe('sonnet-5-5 · Explore')
    expect(kindText(node, 20)).toBe('sonnet-5-5 · Explore')
    // The model whole, the type cut with `clip` (its `~` is a column): down to three characters of the type.
    expect(kindText(node, 19)).toBe('sonnet-5-5 · Explo~')
    expect(kindText(node, 18)).toBe('sonnet-5-5 · Expl~')
    expect(kindText(node, 17)).toBe('sonnet-5-5 · Exp~')
    // Less than three characters of the type would stay: the model alone, then cut only when it alone is too wide.
    expect(kindText(node, 16)).toBe('sonnet-5-5')
    expect(kindText(node, 15)).toBe('sonnet-5-5')
    expect(kindText(node, 10)).toBe('sonnet-5-5')
    expect(kindText(node, 9)).toBe('sonnet-5~')
    expect(kindText(node, 5)).toBe('sonn~')
    // No model known: the type alone, cut if need be (as before C7c2).
    expect(kindText(agent({ model: undefined }), 40)).toBe('Explore')
    expect(kindText(agent({ model: undefined }), 7)).toBe('Explore')
    expect(kindText(agent({ model: undefined }), 5)).toBe('Expl~')
    expect(kindText(agent({ model: '' }), 15)).toBe('Explore')
    // The type as the tree draws it: ` bg` for a background run, `agent` for none; the model short, the `claude-` lead and the date gone.
    expect(kindText(agent({ background: true }), 40)).toBe('sonnet-5-5 · Explore bg')
    expect(kindText(agent({ type: '' }), 40)).toBe('sonnet-5-5 · agent')
    expect(kindText(agent({ model: 'claude-haiku-4-5-20251001' }), 40)).toBe('haiku-4-5 · Explore')
    // A long type: cut at the room the model leaves; a type of two characters fits whole or the model stands alone.
    expect(kindText(agent({ type: 'general-purpose' }), 22)).toBe('sonnet-5-5 · general-~')
    expect(kindText(agent({ type: 'general-purpose' }), 10)).toBe('sonnet-5-5')
    expect(kindText(agent({ type: 'QA' }), 15)).toBe('sonnet-5-5 · QA')
    expect(kindText(agent({ type: 'QA' }), 14)).toBe('sonnet-5-5')
    // A model wider than the room is cut, whatever the type.
    expect(kindText(agent({ model: 'xiaomi/mimo-v2.6-pro' }), 15)).toBe('xiaomi/mimo-v2~')
  })

  test('agentBoxRows: the role in bold, model · type, the description, the glyph with the last tool and the time', () => {
    const rows = (changes: Partial<AgentNode>, frame: number = 0) => agentBoxRows(agent(changes), frame, NOW, 15)

    // 92 columns: 15 of text, so the model alone (the type needs 17: `sonnet-5-5 · Exp~`).
    expect(rows({})).toEqual([sub('researcher', { bold: true }), sub('sonnet-5-5'), sub('List the chang~'), sub('◐ Grep/3 2m30s')])
    // 17 columns of text (a pane of 96): the type comes back, cut; 22 (a pane of 160, the widest): whole.
    expect(geometry(96).agentInner).toBe(17)
    expect(geometry(160).agentInner).toBe(22)
    expect(agentBoxRows(agent(), 0, NOW, 17)[1]).toEqual(sub('sonnet-5-5 · Exp~'))
    expect(agentBoxRows(agent(), 0, NOW, 22)[1]).toEqual(sub('sonnet-5-5 · Explore'))
    // No model known: the type, as before.
    expect(rows({ model: undefined })[1]).toEqual(sub('Explore'))
    // The spinner glyph is the frame's.
    expect(rows({}, 1)[3]).toEqual(sub('◓ Grep/3 2m30s'))
    // Finished: dim all through, the title no longer bold (C7b), the reported duration, no tool when it made no call.
    expect(
      rows({ role: 'worker', type: 'general-purpose', description: 'Draft the chapter outline', status: 'completed', durationMs: 151_000, toolCalls: 0, lastTool: undefined }),
    ).toEqual([
      sub('worker', { dim: true }),
      sub('sonnet-5-5', { dim: true }),
      sub('Draft the chap~', { dim: true }),
      sub('✓ 2m31s', { dim: true }),
    ])
    // Failed or killed: the fail red and the cross.
    expect(rows({ status: 'failed', durationMs: 1200 }).map(row => row.color)).toEqual([COLORS.fail, COLORS.fail, COLORS.fail, COLORS.fail])
    expect(rows({ status: 'failed', durationMs: 1200 })[3]).toEqual(boxRow('✗ Grep/3 1s', COLORS.fail))
    expect(rows({ status: 'killed', durationMs: 90_000 })[3]?.text).toBe('✗ Grep/3 1m30s')
    // A status the engine adds is a running one.
    expect(rows({ status: 'pending' })[3]).toEqual(sub('◐ Grep/3 2m30s'))
  })

  test('agentBoxRows: what is not known is marked, never invented', () => {
    const rows = (changes: Partial<AgentNode>) => agentBoxRows(agent(changes), 0, NOW, 15).map(row => row.text)

    expect(rows({ description: '' })[2]).toBe('--')
    expect(rows({ description: 'one\ntwo' })[2]).toBe('one two')
    expect(rows({ lastTool: undefined })[3]).toBe('◐ ?/3 2m30s')
    expect(rows({ toolCalls: 0 })[3]).toBe('◐ 2m30s')
    expect(rows({ startedAt: undefined })[3]).toBe('◐ Grep/3 --')
    expect(agentBoxRows(agent(), 0, NOW, 5)[0]?.text).toBe('rese~')
  })

  test('agentLine: glyph, role, model, type, last tool and time on one line, cut to the room; the model left out while it is unknown', () => {
    expect(agentLine(agent(), 0, NOW, 56)).toEqual(sub('◐ researcher sonnet-5-5 Explore Grep/3 2m30s'))
    expect(
      agentLine(agent({ role: 'worker', type: 'general-purpose', status: 'completed', durationMs: 151_000, toolCalls: 0, lastTool: undefined }), 0, NOW, 56),
    ).toEqual(sub('✓ worker sonnet-5-5 general-purpose 2m31s', { dim: true }))
    expect(agentLine(agent({ status: 'failed', durationMs: 1200 }), 0, NOW, 56)).toEqual(boxRow('✗ researcher sonnet-5-5 Explore Grep/3 1s', COLORS.fail))
    expect(agentLine(agent({ background: true }), 2, NOW, 56).text).toBe('◑ researcher sonnet-5-5 Explore bg Grep/3 2m30s')
    expect(agentLine(agent(), 0, NOW, 20).text).toBe('◐ researcher sonnet~')
    // The model short, as the box draws it: no `claude-` lead, no date.
    expect(agentLine(agent({ model: 'claude-haiku-4-5-20251001' }), 0, NOW, 56).text).toBe('◐ researcher haiku-4-5 Explore Grep/3 2m30s')
    // No model known: the line is what it was before C7c2.
    expect(agentLine(agent({ model: undefined }), 0, NOW, 56)).toEqual(sub('◐ researcher Explore Grep/3 2m30s'))
    expect(agentLine(agent({ model: '' }), 0, NOW, 56).text).toBe('◐ researcher Explore Grep/3 2m30s')
    expect(agentLine(agent({ model: undefined }), 0, NOW, 20).text).toBe('◐ researcher Explor~')
  })

  test('shownAgents: all of them when they fit; else the latest and a place for `+k more`', () => {
    const ids = (nodes: AgentNode[]): string[] => nodes.map(node => node.id)

    expect(moreText(7)).toBe('+7 more')
    expect(shownAgents(many(5), 5).hidden).toBe(0)
    expect(ids(shownAgents(many(5), 5).shown)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
    expect(ids(shownAgents(many(5), 3).shown)).toEqual(['a4', 'a5'])
    expect(shownAgents(many(5), 3).hidden).toBe(3)
    expect(ids(shownAgents(many(5), 2.9).shown)).toEqual(['a5'])
    // The room is one place at the least: nothing but the `+5 more` box.
    expect(shownAgents(many(5), 1)).toEqual({ shown: [], hidden: 5 })
    expect(shownAgents(many(5), 0)).toEqual({ shown: [], hidden: 5 })
    expect(shownAgents(many(0), 3)).toEqual({ shown: [], hidden: 0 })
  })

  test('boxCentres: the middle of each box of the first line, where the fan puts its arrows', () => {
    expect(NO_SUBAGENTS).toBe('no subagents yet')
    expect(emptyBoxWidth(61)).toBe(20)
    expect(emptyBoxWidth(15)).toBe(15)
    expect(boxCentres(many(0), geometry(92), 1)).toEqual([10])
    expect(boxCentres(many(1), geometry(92), 1)).toEqual([9])
    expect(boxCentres(many(2), geometry(92), 1)).toEqual([9, 29])
    expect(boxCentres(many(3), geometry(92), 1)).toEqual([9, 29, 49])
    // More subagents than the line holds: the `+k more` box takes the last place, and has its arrow.
    expect(boxCentres(many(5), geometry(92), 1)).toEqual([9, 29, 49])
    expect(boxCentres(many(5), geometry(92), 2)).toEqual([9, 29, 49])
    expect(boxCentres(many(4), geometry(100), 1)).toEqual([11, 34, 57])
    expect(boxCentres(many(2), geometry(160), 2)).toEqual([13, 40])
    expect(boxCentres(many(7), geometry(160), 2)).toEqual([13, 40, 67, 94])
  })
})

describe('the advisor, log and usage box lines', () => {
  const adv = (text: string, style: { dim?: boolean; bold?: boolean } = {}) => boxRow(text, COLORS.advisor, style)

  const texts = (rows: readonly { text: string }[]): string[] => rows.map(row => row.text)

  /** What the usage box draws from. */
  const USAGE = { tree: treeOf(3), stats: STATS, now: NOW }

  /** The advisor as its box draws it (C7c): at NOW, on frame 0 unless said. */
  const viewOf = (advisor: AdvisorSnapshot, frame: number = 0, now: number = NOW) => ({ advisor, frame, now })

  test('advisorRows (PRD M-L5): the title and the model, `on call · idle`, the calls and the tokens, the last call, its latest calls newest first, the advice note', () => {
    expect([ADVISOR_TITLE, ADVISOR_IDLE, MAX_RECENT_CALLS]).toEqual(['FABLE ADVISOR', 'on call · idle', 5])
    expect(advisorRows(viewOf(ADVISOR), 26)).toEqual([
      adv('FABLE ADVISOR fable-5-1'),
      adv('on call · idle'),
      adv('calls 4 · read 454k tok'),
      adv('out 2k tok'),
      adv(`last ${ADVISOR_AT} (21.1s)`),
      adv(`◇ ${ADVISOR_AT}  21.1s`),
      adv(`◇ ${CALL_75S_AGO}  18.4s`),
      adv(`◇ ${CALL_250S_AGO}  --`),
      adv(`◇ ${CALL_400S_AGO}  12.3s`),
      adv('advice: encrypted by API'),
    ])
    // On a narrow pane the calls and the tokens share a line.
    expect(texts(advisorRows(viewOf(ADVISOR), 56)).slice(0, 4)).toEqual([
      'FABLE ADVISOR fable-5-1',
      'on call · idle',
      'calls 4 · read 454k tok · out 2k tok',
      `last ${ADVISOR_AT} (21.1s)`,
    ])
    expect(recentCallText({ at: NOW - 9_000, latencyMs: 21_100 })).toBe(`◇ ${ADVISOR_AT}  21.1s`)
    expect(recentCallText({ at: NOW - 250_000 })).toBe(`◇ ${CALL_250S_AGO}  --`)
  })

  test('advisorRows (C7c): a call in flight bolds the title and draws `◆ advising now (3.2 s)` and the spinner of the frame in inverse; stale, it is drawn idle', () => {
    const rows = advisorRows(viewOf(ADVISING, 1), 26)

    expect(rows.slice(0, 3)).toEqual([
      adv('FABLE ADVISOR fable-5-1', { bold: true }),
      boxRow('◆ advising now (3.2 s) ◓', COLORS.advisor, { inverse: true }),
      adv('calls 5 · read 454k tok'),
    ])
    expect(rows.slice(2).every(row => !row.bold && row.inverse === undefined)).toBe(true)
    // The last result and the latest calls stay as they were until its result comes.
    expect(texts(rows).slice(4)).toEqual(texts(advisorRows(viewOf(ADVISOR), 26)).slice(4))
    expect(advisingText(ADVISING, 2, NOW + 120_000)).toBe('◆ advising now (123.2 s) ◑')
    expect(advisingText(ADVISING, 3, NOW - 10_000)).toBe('◆ advising now (0.0 s) ◒')
    expect(advisingText({ ...ADVISING, inFlightSince: undefined }, 0, NOW)).toBe('◆ advising now (--) ◐')
    // Ten minutes after its start the flag is stale; a flag with no start is too.
    const stale = advisorRows(viewOf(ADVISING, 1, NOW - 3_200 + IN_FLIGHT_STALE_MS), 26)

    expect(stale.slice(0, 2)).toEqual([adv('FABLE ADVISOR fable-5-1'), adv(ADVISOR_IDLE)])
    expect(texts(advisorRows(viewOf(ADVISING, 1, NOW - 3_300 + IN_FLIGHT_STALE_MS), 26))[1]).toBe('◆ advising now (599.9 s) ◓')
    expect(advisorRows(viewOf({ ...ADVISING, inFlightSince: undefined }), 26)[1]).toEqual(adv(ADVISOR_IDLE))
  })

  test('advisorRows: its latest five calls at most, newest first; state written before C7c has no list, and draws none', () => {
    const seven = Array.from({ length: 7 }, (_, index) => ({ at: NOW - (7 - index) * 60_000, latencyMs: (index + 1) * 1000 }))
    const recent = (advisor: AdvisorSnapshot): string[] => texts(advisorRows(viewOf(advisor), 26)).filter(text => text.startsWith('◇ '))

    expect(recent({ ...ADVISOR, calls: 7, recentCalls: seven })).toEqual(
      [7, 6, 5, 4, 3].map(seconds => `◇ ${clockTime(NOW - (8 - seconds) * 60_000)}  ${seconds}.0s`),
    )
    expect(recent({ ...ADVISOR, recentCalls: [] })).toEqual([])
    expect(recent({ ...ADVISOR, recentCalls: undefined } as unknown as AdvisorSnapshot)).toEqual([])
  })

  test('advisorRows: before the first call the bare title and two dim lines; no model read is the bare title; what is not read is said so', () => {
    expect(advisorRows(viewOf(EMPTY_ADVISOR), 26)).toEqual([
      adv(ADVISOR_TITLE),
      adv('advisor: no calls yet', { dim: true }),
      adv('advice: encrypted by API', { dim: true }),
    ])
    expect(texts(advisorRows(viewOf(EMPTY_ADVISOR), 10))).toEqual(['FABLE ADV~', 'advisor: ~', 'advice: e~'])
    expect(advisorRows(viewOf({ ...ADVISOR, model: undefined }), 26)[0]).toEqual(adv(ADVISOR_TITLE))
    expect(texts(advisorRows(viewOf(ADVISOR), 20))[0]).toBe('FABLE ADVISOR fable~')
    expect(
      texts(advisorRows(viewOf({ ...ADVISOR, inputTokens: undefined, outputTokens: undefined, tokensUnavailable: 'transcript too large' }), 40)),
    ).toContain('calls 4 · tok n/a (transcript too large)')
    // Every row fits its room, in flight or not.
    for (const advisor of [EMPTY_ADVISOR, ADVISOR, ADVISING]) {
      for (const inner of [1, 5, 10, 24, 26, 56]) {
        expect(texts(advisorRows(viewOf(advisor), inner)).filter(text => widthOf(text) > inner), `${inner} columns`).toEqual([])
      }
    }
  })

  /** Each line of the log box as the texts of its parts. */
  const partsOf = (lines: readonly (readonly BoxRow[])[]): string[][] => lines.map(parts => parts.map(part => part.text))

  /** The time the box draws for the `index`-th line of LOG. */
  const timeOf = (index: number): string => clockTime(LOG[index]?.at ?? 0)

  test('logRows: dim `no events yet`, in no color of its own, while the log is empty; no room is no line (C7d, PRD M-L7)', () => {
    expect(NO_EVENTS).toBe('no events yet')
    expect(logRows([], 57)).toStrictEqual([[{ text: 'no events yet', dim: true, bold: false }]])
    expect(logRows([], 5)[0]?.[0]?.text).toBe('no e~')
    expect(logRows([], 57, 3)).toHaveLength(1)
    expect(logRows([], 57, 0)).toEqual([])
  })

  test('logRows: the last lines that fit, oldest first, the newest at the bottom; the who column as wide as the widest who shown (C7d, PRD M-L7)', () => {
    expect(logRows(LOG, 57)).toHaveLength(LOG.length)
    expect(partsOf(logRows(LOG, 57)).map(([time, body]) => `${time}${' '.repeat(GAP_COLUMNS)}${body}`)).toEqual(formatLines(LOG, 57))

    // The last three: Jev's error, the subagent's end, the main loop's turn; the column is Explore's seven.
    expect(partsOf(logRows(LOG, 57, 3))).toEqual([
      [timeOf(9), 'jev      jev error HTTP 401 key rejected'],
      [timeOf(10), 'Explore  done 2m31s'],
      [timeOf(11), 'main     turn done 41s'],
    ])
    // The last one alone: its own who is the column.
    expect(partsOf(logRows(LOG, 57, 1))).toEqual([[timeOf(11), 'main  turn done 41s']])
    // More room than lines: all of them once; a fraction of a line is floored; no room, or less, no line.
    expect(logRows(LOG, 57, 99)).toEqual(logRows(LOG, 57))
    expect(logRows(LOG, 57, 2.9)).toEqual(logRows(LOG, 57, 2))
    expect(logRows(LOG, 57, 0)).toEqual([])
    expect(logRows(LOG, 57, -3)).toEqual([])
  })

  test('logRows: the time dim; the text of a failure (Jev\'s error too) in the fail red, of Jev in its green, of the advisor in its purple, the rest in no color; nothing bold or inverse', () => {
    const lines = logRows(LOG, 57)

    expect(lines.every(parts => parts.length === 2)).toBe(true)
    expect(lines.every(([time]) => time !== undefined && time.dim && time.color === undefined && !time.bold && time.inverse === undefined)).toBe(true)
    expect(lines.every(([, body]) => body !== undefined && !body.dim && !body.bold && body.inverse === undefined)).toBe(true)
    expect(lines.map(([, body]) => body?.color)).toEqual([
      undefined, // prompt
      undefined, // spawn
      undefined, // Read
      undefined, // Grep
      COLORS.jev, // jev calling...
      COLORS.advisor, // advising...
      COLORS.advisor, // advised 21.1s
      COLORS.jev, // jev ok
      COLORS.fail, // fail Bash
      COLORS.fail, // jev error
      undefined, // done
      undefined, // turn
    ])
    // A kind this version does not know is plain.
    const odd: LogEntry = { at: NOW, who: 'x', kind: 'later' as never, text: 'something new' }

    expect(logRows([odd], 40)[0]?.[1]).toStrictEqual({ text: 'x  something new', dim: false, bold: false })
  })

  test('logRows: the body is cut with ~ where the room ends, by columns; every line fits from one column up, in two parts from 11, in one cut part below', () => {
    // 30 columns: 8 for the time, 2 between, 20 for who and text.
    expect(partsOf(logRows(LOG, 30, 2))).toEqual([
      [timeOf(10), 'Explore  done 2m31s'],
      [timeOf(11), 'main     turn done ~'],
    ])
    // 20 columns: 10 for the body.
    expect(partsOf(logRows(LOG, 20, 2))).toEqual([
      [timeOf(10), 'Explore  ~'],
      [timeOf(11), 'main     ~'],
    ])

    // A who and a text in Chinese: whole characters only, the width counted in columns (a character is two).
    const wide: LogEntry = { at: LOG[11]?.at ?? 0, who: '调研员', kind: 'tool', text: 'Read 文档目录结构分析报告.md' }

    expect(partsOf(logRows([wide], 30))).toEqual([[timeOf(11), '调研员  Read 文档目~']])

    for (const inner of [1, 2, 5, 10, 11, 12, 20, 26, 56]) {
      for (const parts of logRows([...LOG, wide], inner)) {
        expect(partsWidth(parts, GAP_COLUMNS), `${inner} columns`).toBeLessThanOrEqual(inner)
        expect(parts.length, `${inner} columns`).toBe(inner >= 11 ? 2 : 1)
      }
    }
  })

  test('logRows: the lines are the text lines of log.ts, joined: the time, two blanks, the body', () => {
    for (const inner of [1, 5, 10, 11, 20, 26, 57]) {
      const drawn = logRows(LOG, inner).map(parts => parts.map(part => part.text).join(' '.repeat(GAP_COLUMNS)))

      expect(drawn, `${inner} columns`).toEqual(formatLines(LOG, inner))
    }
  })

  test('gaugeBar: used cells of block elements, free ones after, the share rounded and kept within 0 to 100', () => {
    expect(MAX_GAUGE).toBe(10)
    expect(gaugeBar(41, 10)).toBe('▓▓▓▓░░░░░░')
    expect(gaugeBar(50, 5)).toBe('▓▓▓░░')
    expect(gaugeBar(0, 4)).toBe('░░░░')
    expect(gaugeBar(100, 4)).toBe('▓▓▓▓')
    expect(gaugeBar(150, 4)).toBe('▓▓▓▓')
    expect(gaugeBar(-20, 4)).toBe('░░░░')
    expect(gaugeBar(undefined, 4)).toBe('░░░░')
    expect(gaugeBar(Number.NaN, 4)).toBe('░░░░')
    expect(gaugeBar(41, 3.9)).toBe('▓░░')
    expect(gaugeBar(41, 0)).toBe('')
    expect(gaugeBar(41, -3)).toBe('')
  })

  test('usageRows: a bar for the context and for each rate limit, aligned, then the cost, the agents and the session clock packed', () => {
    expect(texts(usageRows(USAGE, 26))).toEqual([
      'ctx ▓▓▓▓░░░░░░ 41% 410k/1M',
      '5h  ▓▓░░░░░░░░ 23%',
      '7d  ▓▓▓▓░░░░░░ 41%',
      '$1.23 · agents 2/3',
      '00:42:10',
    ])
    expect(usageRows(USAGE, 26).every(row => row.color === undefined && !row.dim && !row.bold)).toBe(true)
    // A roomier box packs the last segments onto one line, and its bars stay at 10 cells.
    expect(texts(usageRows(USAGE, 56))).toEqual([
      'ctx ▓▓▓▓░░░░░░ 41% 410k/1M',
      '5h  ▓▓░░░░░░░░ 23%',
      '7d  ▓▓▓▓░░░░░░ 41%',
      '$1.23 · agents 2/3 · 00:42:10',
    ])
  })

  test('usageRows: under three cells of bar the stats segments take over, packed; nothing read is -- and no bar', () => {
    // 3 + 11 + 2 = 16 columns go to the labels and the figures: 19 is the narrowest box with a bar.
    expect(usageRows(USAGE, 19)[0]?.text).toBe('ctx ▓░░ 41% 410k/1M')
    expect(texts(usageRows(USAGE, 18))).toEqual(statsLines(USAGE, 18))
    expect(usageRows(USAGE, 18)[0]?.text).toBe('ctx 41% (410k/1M)')
    expect(usageRows(USAGE, 18).some(row => /[▓░]/.test(row.text))).toBe(false)

    expect(texts(usageRows({ tree: EMPTY_TREE, stats: EMPTY_STATS, now: NOW }, 26))).toEqual(['ctx --', '$-- · agents 0/0', '--:--:--'])
    // A window without a figure: an empty bar and `--`; a limit with no window read: its bar after `ctx --`.
    expect(usageRows({ ...USAGE, stats: { rateLimits: [], contextWindow: 1_000_000, updatedAt: NOW } }, 26)[0]?.text).toBe('ctx ░░░░░░░░░░ -- --/1M')
    expect(texts(usageRows({ ...USAGE, stats: { ...STATS, contextWindow: undefined } }, 26)).slice(0, 3)).toEqual([
      'ctx --',
      '5h ▓▓░░░░░░░░ 23%',
      '7d ▓▓▓▓░░░░░░ 41%',
    ])
    // A percent past 100 fills the bar and is shown as read.
    // (the figure is a column wider, so the bars are 9 cells)
    expect(usageRows({ ...USAGE, stats: { ...STATS, contextPercent: 130 } }, 26)[0]?.text).toBe('ctx ▓▓▓▓▓▓▓▓▓ 130% 410k/1M')
  })
})

describe('the status row, the connectors and the legend', () => {
  const VIEW = { tree: treeOf(3), activity: EMPTY_ACTIVITY, advisor: ADVISOR, jev: JEV, now: NOW }

  const texts = (rows: readonly { text: string }[]): string[] => rows.map(row => row.text)

  test('statusForms: three forms, widest first: with the effort, without it, short', () => {
    const forms = statusForms(VIEW)

    expect(forms.map(texts)).toEqual([
      ['main [opus-5-5 · high]', 'subagents [2/3]', 'fable [on call · 4]', 'jev [idle · 3]'],
      ['main [opus-5-5]', 'subagents [2/3]', 'fable [on call · 4]', 'jev [idle · 3]'],
      ['main [opus-5-5]', 'sub [2/3]', 'fable [4]', 'jev [3]'],
    ])
    expect(forms[0]?.map(part => part.color)).toEqual([COLORS.main, COLORS.sub, COLORS.advisor, COLORS.jev])
    expect(forms[2]?.map(part => part.color)).toEqual([COLORS.main, COLORS.sub, COLORS.advisor, COLORS.jev])
    expect(forms[0]?.every(part => !part.dim)).toBe(true)
    expect(STATUS_GAP).toBe(2)
  })

  test('statusForms: Jev off is dim in every form; no effort or no model is not guessed', () => {
    for (const form of statusForms({ ...VIEW, jev: EMPTY_JEV })) {
      expect(form[form.length - 1]).toMatchObject({ color: COLORS.jev, dim: true })
    }

    expect(statusForms({ ...VIEW, jev: EMPTY_JEV }).map(form => form[3]?.text)).toEqual(['jev [off]', 'jev [off]', 'jev [off]'])
    expect(statusForms({ ...VIEW, tree: withMain({ effort: undefined }) })[0]?.[0]?.text).toBe('main [opus-5-5]')
    expect(statusForms({ ...VIEW, tree: withMain({ model: undefined }) })[0]?.[0]?.text).toBe('main [-- · high]')
    expect(statusForms({ ...VIEW, tree: EMPTY_TREE }).map(form => form[0]?.text)).toEqual(['main [--]', 'main [--]', 'main [--]'])
  })

  test('statusForms (PRD M-L8, C7c): `fable [advising · n]` and `jev [calling · n]` while a call is out, in the two wider forms only; stale, idle again; off, `jev [off]`', () => {
    const out = { ...VIEW, advisor: ADVISING, jev: CALLING }
    const tail = (view: typeof VIEW): string[][] => statusForms(view).map(form => texts(form).slice(2))

    expect(tail(out)).toEqual([
      ['fable [advising · 5]', 'jev [calling · 3]'],
      ['fable [advising · 5]', 'jev [calling · 3]'],
      ['fable [5]', 'jev [3]'],
    ])
    expect(tail({ ...out, advisor: ADVISOR })[0]).toEqual(['fable [on call · 4]', 'jev [calling · 3]'])
    expect(tail({ ...out, jev: JEV })[0]).toEqual(['fable [advising · 5]', 'jev [idle · 3]'])
    // The calls' colors stay their boxes' own, and nothing is dim.
    expect(statusForms(out)[0]?.slice(2)).toEqual([boxRow('fable [advising · 5]', COLORS.advisor), boxRow('jev [calling · 3]', COLORS.jev)])
    // Ten minutes after its start a flag is stale: the idle words. The advisor's call began 1.2 s before Jev's.
    expect(tail({ ...out, now: NOW - 3_200 + IN_FLIGHT_STALE_MS - 1 })[0]).toEqual(['fable [advising · 5]', 'jev [calling · 3]'])
    expect(tail({ ...out, now: NOW - 3_200 + IN_FLIGHT_STALE_MS })[0]).toEqual(['fable [on call · 5]', 'jev [calling · 3]'])
    expect(tail({ ...out, now: NOW - 2_000 + IN_FLIGHT_STALE_MS })[0]).toEqual(['fable [on call · 5]', 'jev [idle · 3]'])
    // Jev off with a flag left set: off, as ever.
    expect(tail({ ...out, jev: { ...CALLING, enabled: false } }).map(parts => parts[1])).toEqual(['jev [off]', 'jev [off]', 'jev [off]'])
  })

  test('statusParts: the widest form that fits; else the leading parts of the short form; the first part alone, cut', () => {
    const forms = statusForms(VIEW)
    const widest = partsWidth(forms[0] ?? [], STATUS_GAP)
    const middle = partsWidth(forms[1] ?? [], STATUS_GAP)
    const short = partsWidth(forms[2] ?? [], STATUS_GAP)

    expect([widest, middle, short]).toEqual([76, 69, 46])
    expect(texts(statusParts(VIEW, widest))).toEqual(texts(forms[0] ?? []))
    expect(texts(statusParts(VIEW, widest - 1))).toEqual(texts(forms[1] ?? []))
    expect(texts(statusParts(VIEW, middle))).toEqual(texts(forms[1] ?? []))
    expect(texts(statusParts(VIEW, middle - 1))).toEqual(texts(forms[2] ?? []))
    expect(texts(statusParts(VIEW, short))).toEqual(texts(forms[2] ?? []))
    expect(texts(statusParts(VIEW, short - 1))).toEqual(['main [opus-5-5]', 'sub [2/3]', 'fable [4]'])
    expect(texts(statusParts(VIEW, 37))).toEqual(['main [opus-5-5]', 'sub [2/3]', 'fable [4]'])
    expect(texts(statusParts(VIEW, 36))).toEqual(['main [opus-5-5]', 'sub [2/3]'])
    expect(texts(statusParts(VIEW, 25))).toEqual(['main [opus-5-5]'])
    expect(texts(statusParts(VIEW, 10))).toEqual(['main [opu~'])
  })

  test('trunkColumn and trunkText: the trunk midway between the first box and the last', () => {
    expect(trunkColumn([9, 29, 49])).toBe(29)
    expect(trunkColumn([9, 29])).toBe(19)
    expect(trunkColumn([9])).toBe(9)
    expect(trunkColumn([])).toBe(0)
    expect(trunkText([9, 29, 49], 61)).toBe(`${' '.repeat(29)}│`)
    expect(trunkText([9], 61)).toBe(`${' '.repeat(9)}│`)
  })

  test('fanTexts: the label over the trunk, the fan from the first box to the last, an arrow over each box', () => {
    expect(DELEGATE_LABEL).toBe('delegate to subagents')
    // Three boxes: the trunk meets the middle one with a cross.
    expect(fanTexts([9, 29, 49], 61)).toEqual([
      `${' '.repeat(19)}${DELEGATE_LABEL}`,
      `${' '.repeat(9)}┌${'─'.repeat(19)}┼${'─'.repeat(19)}┐`,
      `${' '.repeat(9)}▼${' '.repeat(19)}▼${' '.repeat(19)}▼`,
    ])
    // Two boxes: the trunk lands between them.
    expect(fanTexts([9, 29], 61)).toEqual([
      `${' '.repeat(9)}${DELEGATE_LABEL}`,
      `${' '.repeat(9)}┌${'─'.repeat(9)}┴${'─'.repeat(9)}┐`,
      `${' '.repeat(9)}▼${' '.repeat(19)}▼`,
    ])
    // One box (or the empty-state box): the trunk goes straight down; the label keeps to the left edge.
    expect(fanTexts([9], 61)).toEqual([DELEGATE_LABEL, `${' '.repeat(9)}│`, `${' '.repeat(9)}▼`])
    expect(fanTexts([10], 61)).toEqual([DELEGATE_LABEL, `${' '.repeat(10)}│`, `${' '.repeat(10)}▼`])
    // Four boxes of 26: the trunk between the second and the third, a `┬` over those two.
    expect(fanTexts([13, 40, 67, 94], 129)).toEqual([
      `${' '.repeat(43)}${DELEGATE_LABEL}`,
      `${' '.repeat(13)}┌${'─'.repeat(26)}┬${'─'.repeat(12)}┴${'─'.repeat(13)}┬${'─'.repeat(26)}┐`,
      `${' '.repeat(13)}▼${' '.repeat(26)}▼${' '.repeat(26)}▼${' '.repeat(26)}▼`,
    ])
  })

  test('fanTexts: every row fits the width it is given', () => {
    for (const width of [12, 30, 61, 129]) {
      for (const centres of [[10], [9, 29], [9, 29, 49], [13, 40, 67, 94]]) {
        for (const row of fanTexts(centres, width)) {
          expect(widthOf(row), `${centres.join(',')} in ${width}`).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test('legendParts: the title in bold and an entry per color, three columns apart; two when short of room, then entries drop from the end', () => {
    const all = legendParts(92)

    expect(LEGEND_TITLE).toBe('AGENT TREE')
    expect(SWATCH).toBe('▮')
    expect(texts(all.parts)).toEqual(['AGENT TREE', '▮ main', '▮ subagents', '▮ fable · advisor', '▮ jev · flags'])
    expect(all.parts.map(part => part.color)).toEqual([COLORS.main, COLORS.main, COLORS.sub, COLORS.advisor, COLORS.jev])
    expect(all.parts.map(part => part.bold)).toEqual([true, false, false, false, false])
    expect(all.gap).toBe(3)
    expect(partsWidth(all.parts, 3)).toBe(69)

    const counts = (width: number): [number, number] => {
      const legend = legendParts(width)

      return [legend.parts.length, legend.gap]
    }

    expect(counts(69)).toEqual([5, 3])
    expect(counts(68)).toEqual([5, 2])
    expect(counts(65)).toEqual([5, 2])
    expect(counts(64)).toEqual([4, 2])
    expect(counts(49)).toEqual([3, 2])
    expect(counts(30)).toEqual([2, 2])
    expect(counts(17)).toEqual([1, 2])
    expect(legendParts(5).parts).toEqual([{ text: 'AGEN~', color: COLORS.main, dim: false, bold: true }])
  })
})

// What the pane draws with the data above, row by row (blanks at the right
// end left off); the clock times are the machine's.

const WIDE_92 = [
  'AGENT TREE   ▮ main   ▮ subagents   ▮ fable · advisor   ▮ jev · flags',
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 3                    │ │ FABLE ADVISOR fable-5-1    │',
  '│ ◐ tooling Read 2s                                         │ │ on call · idle             │',
  '└───────────────────────────────────────────────────────────┘ │ calls 4 · read 454k tok    │',
  '                             │                                │ out 2k tok                 │',
  `┌───────────────────────────────────────────────────────────┐ │ last ${ADVISOR_AT} (21.1s)      │`,
  `│ JEV · advisory  idle                                      │ │ ◇ ${ADVISOR_AT}  21.1s          │`,
  `│ calls 3 · last ${JEV_AT}                                   │ │ ◇ ${CALL_75S_AGO}  18.4s          │`,
  `│ looping      █░░░░ 0.11 sharp  stuck     ░░░░░ 0.06 sharp │ │ ◇ ${CALL_250S_AGO}  --             │`,
  `│ fan-out wide ░░░░░ 0.09 sharp  near done █░░░░ 0.18 split │ │ ◇ ${CALL_400S_AGO}  12.3s          │`,
  '│ health 0.9 needs attention                                │ │ advice: encrypted by API   │',
  '└───────────────────────────────────────────────────────────┘ └────────────────────────────┘',
  '                   delegate to subagents',
  '         ●───────────────────┼───────────────────┐',
  '         ▼                   ▼                   ▼',
  '┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐',
  '│ worker          │ │ researcher      │ │ worker          │',
  '│ sonnet-5-5      │ │ sonnet-5-5      │ │ sonnet-5-5      │',
  '│ Draft the chap~ │ │ List the chang~ │ │ Edit the test ~ │',
  '│ ✓ 2m31s         │ │ ◐ Grep/3 2m30s  │ │ ◐ Bash/1 2m29s  │',
  '└─────────────────┘ └─────────────────┘ └─────────────────┘',
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ no events yet                                             │ │ ctx ▓▓▓▓░░░░░░ 41% 410k/1M │',
  '│                                                           │ │ 5h  ▓▓░░░░░░░░ 23%         │',
  '│                                                           │ │ 7d  ▓▓▓▓░░░░░░ 41%         │',
  '│                                                           │ │ $1.23 · agents 2/3         │',
  '│                                                           │ │ 00:42:10                   │',
  '└───────────────────────────────────────────────────────────┘ └────────────────────────────┘',
  'main [opus-5-5 · high · tooling Read]  subagents [2/3]  fable [on call · 4]  jev [idle · 3]',
]

const NARROW_60 = [
  '┌──────────────────────────────────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 3                   │',
  '│ ◐ tooling Read 2s                                        │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ JEV · advisory  idle                                     │',
  `│ calls 3 · last ${JEV_AT}                                  │`,
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ ✓ worker sonnet-5-5 general-purpose 2m31s                │',
  '│ ◐ researcher sonnet-5-5 Explore Grep/3 2m30s             │',
  '│ ◐ worker sonnet-5-5 general-purpose Bash/1 2m29s         │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ FABLE ADVISOR fable-5-1                                  │',
  '│ on call · idle                                           │',
  '│ calls 4 · read 454k tok · out 2k tok                     │',
  `│ last ${ADVISOR_AT} (21.1s)                                    │`,
  `│ ◇ ${ADVISOR_AT}  21.1s                                        │`,
  `│ ◇ ${CALL_75S_AGO}  18.4s                                        │`,
  `│ ◇ ${CALL_250S_AGO}  --                                           │`,
  `│ ◇ ${CALL_400S_AGO}  12.3s                                        │`,
  '│ advice: encrypted by API                                 │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ no events yet                                            │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ ctx ▓▓▓▓░░░░░░ 41% 410k/1M                               │',
  '│ 5h  ▓▓░░░░░░░░ 23%                                       │',
  '│ 7d  ▓▓▓▓░░░░░░ 41%                                       │',
  '│ $1.23 · agents 2/3 · 00:42:10                            │',
  '└──────────────────────────────────────────────────────────┘',
  'main [opus-5-5]  sub [2/3]  fable [4]  jev [3]',
]

/** 14 body rows, wide: the status row, the main box, one Jev line, one line of subagent boxes; the advisor beside, as tall as they let it; nothing else fits. */
const WIDE_92_IN_14_ROWS = [
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 3                    │ │ FABLE ADVISOR fable-5-1    │',
  '│ ◐ tooling Read 2s                                         │ │ on call · idle             │',
  '└───────────────────────────────────────────────────────────┘ │ calls 4 · read 454k tok    │',
  '┌───────────────────────────────────────────────────────────┐ │ out 2k tok                 │',
  `│ JEV · advisory  idle                                      │ │ last ${ADVISOR_AT} (21.1s)      │`,
  `└───────────────────────────────────────────────────────────┘ │ ◇ ${ADVISOR_AT}  21.1s          │`,
  `┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐   │ ◇ ${CALL_75S_AGO}  18.4s          │`,
  `│ worker          │ │ researcher      │ │ worker          │   │ ◇ ${CALL_250S_AGO}  --             │`,
  `│ sonnet-5-5      │ │ sonnet-5-5      │ │ sonnet-5-5      │   │ ◇ ${CALL_400S_AGO}  12.3s          │`,
  '│ Draft the chap~ │ │ List the chang~ │ │ Edit the test ~ │   │ advice: encrypted by API   │',
  '│ ✓ 2m31s         │ │ ◐ Grep/3 2m30s  │ │ ◐ Bash/1 2m29s  │   └────────────────────────────┘',
  '└─────────────────┘ └─────────────────┘ └─────────────────┘',
  'main [opus-5-5 · high · tooling Read]  subagents [2/3]  fable [on call · 4]  jev [idle · 3]',
]

/** 12 body rows, narrow (a third of a tall terminal): the main box, the Jev header, the latest subagent and `+2 more`, the status row (the card's R-risk). */
const NARROW_60_IN_12_ROWS = [
  '┌──────────────────────────────────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 3                   │',
  '│ ◐ tooling Read 2s                                        │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ JEV · advisory  idle                                     │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ ◐ worker sonnet-5-5 general-purpose Bash/1 2m29s         │',
  '│ +2 more                                                  │',
  '└──────────────────────────────────────────────────────────┘',
  'main [opus-5-5]  sub [2/3]  fable [4]  jev [3]',
]

/** Ten subagents and one line of boxes: the latest two and a `+8 more` box in the last place, as tall as its neighbours. */
const WIDE_92_TEN_SUBAGENTS = [
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 3                    │ │ FABLE ADVISOR fable-5-1    │',
  '│ ◐ tooling Read 2s                                         │ │ on call · idle             │',
  '└───────────────────────────────────────────────────────────┘ │ calls 4 · read 454k tok    │',
  '┌───────────────────────────────────────────────────────────┐ │ out 2k tok                 │',
  `│ JEV · advisory  idle                                      │ │ last ${ADVISOR_AT} (21.1s)      │`,
  `└───────────────────────────────────────────────────────────┘ │ ◇ ${ADVISOR_AT}  21.1s          │`,
  `┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐   │ ◇ ${CALL_75S_AGO}  18.4s          │`,
  `│ worker          │ │ worker          │ │ +8 more         │   │ ◇ ${CALL_250S_AGO}  --             │`,
  `│ sonnet-5-5      │ │ sonnet-5-5      │ │                 │   │ ◇ ${CALL_400S_AGO}  12.3s          │`,
  '│ Edit the test ~ │ │ Draft the chap~ │ │                 │   │ advice: encrypted by API   │',
  '│ ◐ Bash/1 2m23s  │ │ ✓ 2m31s         │ │                 │   └────────────────────────────┘',
  '└─────────────────┘ └─────────────────┘ └─────────────────┘',
  'main [opus-5-5 · high · tooling Read]  subagents [6/10]  fable [on call · 4]  jev [idle · 3]',
]

const NARROW_60_FIVE_SUBAGENTS_IN_9_ROWS = [
  '┌──────────────────────────────────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 3                   │',
  '│ ◐ tooling Read 2s                                        │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ ◐ researcher sonnet-5-5 Explore Grep/3 2m27s             │',
  '│ +4 more                                                  │',
  '└──────────────────────────────────────────────────────────┘',
  'main [opus-5-5]  sub [3/5]  fable [4]  jev [3]',
]

const WIDE_92_NO_SUBAGENTS = [
  'AGENT TREE   ▮ main   ▮ subagents   ▮ fable · advisor   ▮ jev · flags',
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 3                    │ │ FABLE ADVISOR fable-5-1    │',
  '│ ◐ tooling Read 2s                                         │ │ on call · idle             │',
  '└───────────────────────────────────────────────────────────┘ │ calls 4 · read 454k tok    │',
  '          │                                                   │ out 2k tok                 │',
  `┌───────────────────────────────────────────────────────────┐ │ last ${ADVISOR_AT} (21.1s)      │`,
  `│ JEV · advisory  idle                                      │ │ ◇ ${ADVISOR_AT}  21.1s          │`,
  `│ calls 3 · last ${JEV_AT}                                   │ │ ◇ ${CALL_75S_AGO}  18.4s          │`,
  `│ looping      █░░░░ 0.11 sharp  stuck     ░░░░░ 0.06 sharp │ │ ◇ ${CALL_250S_AGO}  --             │`,
  `│ fan-out wide ░░░░░ 0.09 sharp  near done █░░░░ 0.18 split │ │ ◇ ${CALL_400S_AGO}  12.3s          │`,
  '│ health 0.9 needs attention                                │ │ advice: encrypted by API   │',
  '└───────────────────────────────────────────────────────────┘ └────────────────────────────┘',
  'delegate to subagents',
  '          │',
  '          ▼',
  '┌──────────────────┐',
  '│ no subagents yet │',
  '└──────────────────┘',
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ no events yet                                             │ │ ctx ▓▓▓▓░░░░░░ 41% 410k/1M │',
  '│                                                           │ │ 5h  ▓▓░░░░░░░░ 23%         │',
  '│                                                           │ │ 7d  ▓▓▓▓░░░░░░ 41%         │',
  '│                                                           │ │ $1.23 · agents 0/0         │',
  '│                                                           │ │ 00:42:10                   │',
  '└───────────────────────────────────────────────────────────┘ └────────────────────────────┘',
  'main [opus-5-5 · high · tooling Read]  subagents [0/0]  fable [on call · 4]  jev [idle · 3]',
]

/** The times of LOG's lines, as the log box draws them. */
const LOG_AT = LOG.map(entry => clockTime(entry.at))

/** A line of `text` in a box `width` columns wide: the border, the padding, the text padded to the room. */
const boxLine = (text: string, width: number): string => `│ ${padTo(text, width - 4)} │`

/** What the log box draws for LOG in 57 columns of text room (wide, 92 columns): a who column of seven, the failed command cut with `~`. */
const LOG_TEXT_57 = [
  `${LOG_AT[0]}  main     prompt`,
  `${LOG_AT[1]}  Explore  spawn Explore List docs files`,
  `${LOG_AT[2]}  main     Read README.md`,
  `${LOG_AT[3]}  Explore  Grep shouldClearRing`,
  `${LOG_AT[4]}  jev      jev calling...`,
  `${LOG_AT[5]}  fable    advising...`,
  `${LOG_AT[6]}  fable    advised 21.1s`,
  `${LOG_AT[7]}  jev      jev ok · calls 3`,
  `${LOG_AT[8]}  main     fail Bash npm test -- --reporter=verb~`,
  `${LOG_AT[9]}  jev      jev error HTTP 401 key rejected`,
  `${LOG_AT[10]}  Explore  done 2m31s`,
  `${LOG_AT[11]}  main     turn done 41s`,
]

/** The same in 56 columns (narrow, 60 columns): the failed command is cut a character sooner. */
const LOG_TEXT_56 = LOG_TEXT_57.map(text => (text.endsWith('--reporter=verb~') ? text.replace('--reporter=verb~', '--reporter=ver~') : text))

/** The usage box of the drawings, its five lines, as it draws beside the log box. */
const USAGE_92 = [
  '│ ctx ▓▓▓▓░░░░░░ 41% 410k/1M │',
  '│ 5h  ▓▓░░░░░░░░ 23%         │',
  '│ 7d  ▓▓▓▓░░░░░░ 41%         │',
  '│ $1.23 · agents 2/3         │',
  '│ 00:42:10                   │',
]

/** WIDE_92 with LOG (C7d): the same above the log box, which takes its twelve lines; the usage box beside it stretches to its height. */
const WIDE_92_LOG = [
  ...WIDE_92.slice(0, 22),
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  ...LOG_TEXT_57.map((text, row) => `${boxLine(text, 61)} ${USAGE_92[row] ?? `│${spaces(28)}│`}`),
  '└───────────────────────────────────────────────────────────┘ └────────────────────────────┘',
  'main [opus-5-5 · high · tooling Read]  subagents [2/3]  fable [on call · 4]  jev [idle · 3]',
]

/** NARROW_60 with LOG (C7d): the log box is the same lines in its own box, between the advisor and usage boxes. */
const NARROW_60_LOG = [
  ...NARROW_60.slice(0, 24),
  `┌${'─'.repeat(58)}┐`,
  ...LOG_TEXT_56.map(text => boxLine(text, 60)),
  `└${'─'.repeat(58)}┘`,
  ...NARROW_60.slice(27),
]

/**
 * The glyphs the pane draws beyond ASCII (PRD M-L9, section 12): box-drawing,
 * block elements, spinner and status marks, the moving dot (C7b), the
 * advisor's `◆` call in flight and `◇` latest calls (C7c), the swatch, the
 * middle dot, the dash of `Jev off` and the ellipsis of `calling now…` (PRD
 * M-L6).
 */
const GLYPHS = new Set('┌┐└┘│─┬┴┼▼█▓░▮◐◓◑◒●◆◇✓✗·—…')

/** The `▼` of the fan that stand over no box middle of the line below, or that the boxes there do not match; `column` is the left column's width. */
function fanProblems(lines: readonly string[], column: number): string[] {
  const at = lines.findIndex(line => line.includes('▼'))

  if (at < 0) {
    return []
  }

  const arrows = [...(lines[at] ?? '')].flatMap((char, index) => (char === '▼' ? [index] : []))
  const boxes = [...(lines[at + 1] ?? '').slice(0, column).matchAll(/┌─*┐/g)].map(
    match => [match.index ?? 0, (match.index ?? 0) + match[0].length - 1] as const,
  )
  const problems: string[] = []

  if (arrows.length !== boxes.length) {
    problems.push(`${arrows.length} arrows over ${boxes.length} boxes`)
  }

  for (const arrow of arrows) {
    if (!boxes.some(([left, right]) => arrow > left && arrow < right && Math.abs(arrow - (left + right) / 2) <= 0.5)) {
      problems.push(`the arrow at ${arrow} is over no box middle of ${JSON.stringify(boxes)}`)
    }
  }

  return problems
}

describe('the pane drawn through plain-data constructors', () => {
  test('wide, 92 columns: the legend, the main and Jev boxes and the trunk, the advisor beside, the fan, the subagent boxes, log and usage, the status row', () => {
    expect(trimmed(draw(dataOf(3), 92))).toEqual(WIDE_92)
  })

  test('narrow, 60 columns: one column, the boxes one under the other, the subagents one line each', () => {
    expect(trimmed(draw(dataOf(3), 60))).toEqual(NARROW_60)
  })

  test('with body rows: 14 rows wide and 12 rows narrow keep the status row, the main box, a subagent and what else fits', () => {
    expect(trimmed(draw(dataOf(3, 14), 92))).toEqual(WIDE_92_IN_14_ROWS)
    expect(trimmed(draw(dataOf(3, 12), 60))).toEqual(NARROW_60_IN_12_ROWS)
    expect(draw(dataOf(3, 14), 92)).toHaveLength(14)
    expect(draw(dataOf(3, 12), 60)).toHaveLength(12)
  })

  test('more subagents than the rows hold: the latest keep their boxes (lines) and `+k more` takes the last place', () => {
    expect(trimmed(draw(dataOf(10, 14), 92))).toEqual(WIDE_92_TEN_SUBAGENTS)
    expect(trimmed(draw(dataOf(5, 9), 60))).toEqual(NARROW_60_FIVE_SUBAGENTS_IN_9_ROWS)
  })

  test('no subagents yet: the empty-state box, and the fan goes straight down to it', () => {
    expect(trimmed(draw(dataOf(0), 92))).toEqual(WIDE_92_NO_SUBAGENTS)
  })

  test('the wide pane wraps its subagent boxes: three to a line at 92 columns, four at 160; one line fewer in the narrow pane', () => {
    /** How many role titles each row of a drawing holds, rows with none left out: the lines of subagent boxes. */
    const perLine = (width: number, count: number): number[] =>
      draw(dataOf(count), width)
        .map(line => (line.match(/researcher|worker/g) ?? []).length)
        .filter(titles => titles > 0)

    expect(perLine(88, 3)).toEqual([3])
    expect(perLine(92, 4)).toEqual([3, 1])
    expect(perLine(92, 7)).toEqual([3, 3, 1])
    expect(perLine(100, 4)).toEqual([3, 1])
    expect(perLine(137, 4)).toEqual([3, 1])
    expect(perLine(138, 4)).toEqual([4])
    expect(perLine(160, 7)).toEqual([4, 3])
    expect(perLine(60, 3)).toEqual([1, 1, 1])
  })

  test('a description in Chinese is cut at a whole character, and the boxes keep their width', () => {
    const tree = withAgents([
      agent({ description: '调研文档目录结构分析报告' }),
      agent({ id: 'a2', role: 'worker', type: 'general-purpose', description: '写测试', startedAt: NOW - 100_000 }),
    ])

    for (const width of [60, 92, 160]) {
      const lines = draw({ ...dataOf(0), tree }, width)

      expect(lines.every(line => widthOf(line) === width), `${width} columns`).toBe(true)
    }

    expect(draw({ ...dataOf(0), tree }, 92).some(line => line.includes('│ 调研文档目录结~ │'))).toBe(true)
    // 160 columns: 22 of text room, ten characters of 24 columns.
    expect(draw({ ...dataOf(0), tree }, 160).some(line => line.includes('│ 调研文档目录结构分析~  │'))).toBe(true)
  })

  // The scan is 5460 drawings (3.2 s on an idle PC): its own limit, as the kit's TestOptions give one,
  // so a slow or loaded PC does not time it out at the kit's 5000 ms (C7e).
  test('every drawing: as high as its budget says, every row as wide as the pane, nothing overflows, only the glyphs of the PRD, no background, arrows over boxes', { timeoutMs: 20_000 }, () => {
    // The last: both calls in flight (C7c), the advisor's and Jev's.
    const jevs = [EMPTY_JEV, { ...EMPTY_JEV, enabled: true }, JEV, JEV_FAILED, CALLING]
    let drawings = 0

    for (const width of [30, 59, 60, 61, 87, 88, 89, 92, 100, 120, 137, 138, 160]) {
      for (const count of [0, 1, 2, 3, 4, 7, 12]) {
        for (const jev of jevs) {
          for (const bodyRows of [undefined, 0, 6, 9, 11, 12, 14, 20, 27, 30, 40, 100]) {
            const isOut = jev === CALLING
            const label = `${width} columns, ${count} subagents, ${jev.flags.length} flags${jev.error === undefined ? '' : ' and an error'}, ${jev.enabled ? 'on' : 'off'}${isOut ? ', both calls out' : ''}, ${bodyRows ?? 'no'} rows`
            const data = isOut ? { ...dataOf(count, bodyRows, jev), advisor: ADVISING } : dataOf(count, bodyRows, jev)
            let drawn: Drawn
            let lines: string[]

            try {
              drawn = renderPane(KIT, data, width) as unknown as Drawn
              lines = paint(drawn, width, false)
            } catch (error) {
              throw new Error(`${label}: ${String(error)}`)
            }

            expect(lines.length, label).toBe(paneBudget(data, geometry(width)).height)
            expect(
              lines.filter(line => widthOf(line) !== width),
              label,
            ).toEqual([])

            const foreign = [...lines.join('')].filter(char => char.charCodeAt(0) > 0x7f && !GLYPHS.has(char))

            expect(foreign, label).toEqual([])

            const elements = elementsOf(drawn)

            expect(elements.filter(element => Object.keys(element.props).some(key => /background|bgcolor/i.test(key))), label).toEqual([])
            expect(elements.filter(element => element.props.borderStyle !== undefined && element.props.borderStyle !== 'single'), label).toEqual([])
            expect(fanProblems(lines, geometry(width).column), label).toEqual([])
            drawings += 1
          }
        }
      }
    }

    expect(drawings).toBe(13 * 7 * 5 * 12)
  })

  test('with a log (C7d, PRD M-L7): every line in the log box, the newest at the bottom; wide beside the usage box, which stretches to its height; narrow in a box of its own', () => {
    expect(trimmed(draw(dataOf(3, undefined, JEV, LOG), 92))).toEqual(WIDE_92_LOG)
    expect(trimmed(draw(dataOf(3, undefined, JEV, LOG), 60))).toEqual(NARROW_60_LOG)
  })

  test('with a log: the last lines that fit the rows left, the newest at the bottom, and the same lines wide and narrow', () => {
    /** The log box's text lines of a drawing: the rows that begin with a time, cut at the box's right border. */
    const logOf = (lines: readonly string[], width: number): string[] =>
      lines.filter(line => /^│ \d\d:\d\d:\d\d {2}/.test(line)).map(line => line.slice(2, geometry(width).column - 2).trimEnd())

    // [columns, body rows, the log lines the budget gives]: wide, the log box stands beside the usage box and has its lines (2) at least; narrow, from 34 rows.
    const table = [
      [92, 22, 2],
      [92, 30, 5],
      [92, 32, 7],
      [92, 33, 8],
      [92, 36, 11],
      [92, 37, 12],
      [92, 40, 12],
      [60, 34, 1],
      [60, 36, 3],
      [60, 40, 7],
      [60, 44, 11],
      [60, 45, 12],
    ] as const

    for (const [width, rows, lines] of table) {
      const data = dataOf(3, rows, JEV, LOG)
      const label = `${width} columns, ${rows} rows`

      expect(paneBudget(data, geometry(width)).log, label).toBe(lines)
      // The latest lines, in order: the last one is the main loop's turn.
      expect(logOf(draw(data, width), width), label).toEqual(formatLines(LOG.slice(-lines), geometry(width).columnInner))
      expect(logOf(draw(data, width), width).at(-1), label).toContain('turn done 41s')
    }

    // The same data in both variants: every line begins alike.
    const prefixes = (width: number): string[] => logOf(draw(dataOf(3, undefined, JEV, LOG), width), width).map(line => line.slice(0, 40))

    expect(prefixes(92)).toHaveLength(LOG.length)
    expect(prefixes(60)).toEqual(prefixes(92))
  })

  test('with a log: each line is a row of its time, dim, and its body in the color of its kind', () => {
    const drawn = renderPane(KIT, dataOf(3, undefined, JEV, LOG), 92) as unknown as Drawn
    const textOf = (node: Node | undefined): string =>
      typeof node === 'string' || node === undefined ? (node ?? '') : node.children.filter((child): child is string => typeof child === 'string').join('')
    // A line is a Box of two Texts, the time first.
    const lines = elementsOf(drawn).filter(
      element => element.type === 'Box' && element.children.length === 2 && /^\d\d:\d\d:\d\d$/.test(textOf(element.children[0])),
    )
    const times = lines.map(line => line.children[0] as Drawn)
    const bodies = lines.map(line => line.children[1] as Drawn)
    const colorOfKind: Partial<Record<LogEntry['kind'], string>> = { fail: COLORS.fail, jev: COLORS.jev, advisor: COLORS.advisor }

    expect(lines.map(line => line.props.gap)).toEqual(LOG.map(() => GAP_COLUMNS))
    expect(times.map(part => textOf(part))).toEqual(LOG_AT)
    expect(times.map(part => [part.props.dimColor, part.props.color, part.props.wrap])).toEqual(LOG.map(() => [true, undefined, 'truncate-end']))
    expect(bodies.map(part => [part.props.dimColor, part.props.wrap])).toEqual(LOG.map(() => [false, 'truncate-end']))
    expect(bodies.map(part => part.props.color)).toEqual(LOG.map(entry => colorOfKind[entry.kind]))
    // Four colors in all: none, the fail red, Jev's green, the advisor's purple.
    expect(new Set(bodies.map(part => part.props.color))).toEqual(new Set([undefined, COLORS.fail, COLORS.jev, COLORS.advisor]))
    expect(bodies.filter(part => part.props.color === undefined).map(textOf)).toEqual(
      ['main     prompt', 'Explore  spawn Explore List docs files', 'main     Read README.md', 'Explore  Grep shouldClearRing', 'Explore  done 2m31s', 'main     turn done 41s'],
    )
    // The empty log: the placeholder, one dim Text, in no color.
    const empty = elementsOf(renderPane(KIT, dataOf(3), 92) as unknown as Drawn).filter(element => element.type === 'Text' && textOf(element) === 'no events yet')

    expect(empty.map(part => [part.props.dimColor, part.props.color])).toEqual([[true, undefined]])
  })

  test('with a log: every drawing is as high as its budget says, every row as wide as the pane, nothing overflows, only the glyphs of the PRD, no background', () => {
    // A full ring, the second subagent of a type and the first of another taking turns.
    const ring: LogEntry[] = Array.from({ length: MAX_LOG }, (_, index) => ({
      at: NOW - (MAX_LOG - index) * 1000,
      who: ['main', 'general~#2', 'Explore'][index % 3] ?? 'main',
      kind: 'tool',
      text: `Read file-${index}.ts`,
    }))
    let drawings = 0

    for (const width of [30, 59, 60, 61, 87, 88, 92, 100, 138, 160]) {
      for (const count of [0, 3, 12]) {
        for (const log of [LOG.slice(-1), LOG, ring]) {
          for (const bodyRows of [undefined, 0, 9, 14, 20, 27, 30, 40, 100]) {
            const label = `${width} columns, ${count} subagents, ${log.length} log lines, ${bodyRows ?? 'no'} rows`
            const data = dataOf(count, bodyRows, JEV, log)
            let drawn: Drawn
            let lines: string[]

            try {
              drawn = renderPane(KIT, data, width) as unknown as Drawn
              lines = paint(drawn, width, false)
            } catch (error) {
              throw new Error(`${label}: ${String(error)}`)
            }

            expect(lines.length, label).toBe(paneBudget(data, geometry(width)).height)
            expect(lines.filter(line => widthOf(line) !== width), label).toEqual([])
            expect([...lines.join('')].filter(char => char.charCodeAt(0) > 0x7f && !GLYPHS.has(char)), label).toEqual([])
            expect(
              elementsOf(drawn).filter(element => Object.keys(element.props).some(key => /background|bgcolor/i.test(key))),
              label,
            ).toEqual([])
            drawings += 1
          }
        }
      }
    }

    expect(drawings).toBe(10 * 3 * 3 * 9)
  })

  test('a log in Chinese is cut at a whole character, and the boxes keep their width', () => {
    const log: LogEntry[] = [
      { at: NOW - 3000, who: '调研员', kind: 'tool', text: 'Read 文档目录结构分析报告.md' },
      { at: NOW - 2000, who: 'main', kind: 'spawn', text: 'spawn 调研 调研文档目录结构分析报告和测试计划以及发布说明' },
    ]

    for (const width of [30, 60, 92, 160]) {
      for (const bodyRows of [undefined, 30]) {
        const lines = draw(dataOf(3, bodyRows, JEV, log), width)

        expect(lines.every(line => widthOf(line) === width), `${width} columns, ${bodyRows ?? 'no'} rows`).toBe(true)
      }
    }
  })

  test('both calls out (C7c, PRD M-L5, M-L6, M-L8): the activity lines in inverse, the two borders lit and their titles bold; the status row says advising and calling', () => {
    const out = renderPane(KIT, { ...dataOf(3), advisor: ADVISING, jev: CALLING }, 92) as unknown as Drawn
    const idle = renderPane(KIT, dataOf(3), 92) as unknown as Drawn
    const boxOf = (drawn: Drawn, color: string): Drawn | undefined =>
      elementsOf(drawn).find(element => element.props.borderStyle !== undefined && element.props.borderColor === color)
    const styled = (drawn: Drawn | undefined, prop: 'bold' | 'inverse'): string[] =>
      drawn === undefined ? [] : elementsOf(drawn).filter(element => element.type === 'Text' && element.props[prop] === true).map(element => element.children.join(''))
    const lines = trimmed(paint(out, 92, false))

    expect(lines.slice(1, 8)).toEqual([
      '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
      '│ main session  opus-5-5 · high · turn 3                    │ │ FABLE ADVISOR fable-5-1    │',
      '│ ◐ tooling Read 2s                                         │ │ ◆ advising now (3.2 s) ◐   │',
      '└───────────────────────────────────────────────────────────┘ │ calls 5 · read 454k tok    │',
      '                             │                                │ out 2k tok                 │',
      `┌───────────────────────────────────────────────────────────┐ │ last ${ADVISOR_AT} (21.1s)      │`,
      `│ JEV · advisory  ◐ calling now… 2s                         │ │ ◇ ${ADVISOR_AT}  21.1s          │`,
    ])
    // The widest form is 95 columns with the words: the one without the effort.
    expect(lines.at(-1)).toBe('main [opus-5-5 · tooling Read]  subagents [2/3]  fable [advising · 5]  jev [calling · 3]')
    expect(lines).toHaveLength(paneBudget({ ...dataOf(3), advisor: ADVISING, jev: CALLING }, geometry(92)).height)

    expect([boxOf(out, COLORS.advisor)?.props.borderDimColor, boxOf(out, COLORS.jev)?.props.borderDimColor]).toEqual([false, false])
    expect(styled(boxOf(out, COLORS.advisor), 'bold')).toEqual(['FABLE ADVISOR fable-5-1'])
    expect(styled(boxOf(out, COLORS.jev), 'bold')).toEqual(['JEV · advisory'])
    expect(styled(out, 'inverse').sort()).toEqual(['◆ advising now (3.2 s) ◐', '◐ calling now… 2s'].sort())

    // Neither out: both borders dim, the titles plain, nothing in inverse.
    expect([boxOf(idle, COLORS.advisor)?.props.borderDimColor, boxOf(idle, COLORS.jev)?.props.borderDimColor]).toEqual([true, true])
    expect([...styled(boxOf(idle, COLORS.advisor), 'bold'), ...styled(boxOf(idle, COLORS.jev), 'bold')]).toEqual([])
    expect(styled(idle, 'inverse')).toEqual([])
  })
})

// The plugin's own drawing: `$.ui.mount` runs the plugin's `ui.render` hook
// with the engine's elements and hands over what it returned, validated by
// the surface's element table. The three subagents have ended, and the main
// loop's turn too (C7b: a thinking main loop shows its time), so no figure
// depends on the clock.

const SURFACES = ['terminal', 'desktop'] as const

const PANE = { plugin: 'agent-tree', component: 'Pane', requestId: 'agent-tree' } as const

/** Pane props of a dock `columns` wide that shows `rows` body rows. */
const propsFor = (columns: number, rows: number) =>
  ({
    title: 'Agent Tree',
    isFocused: false,
    bodyColumns: columns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: rows },
    view: {},
  }) as const

/** agent.spawn's input for an Explore subagent the main loop starts (shape as seen in C0 run A). */
const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'List the files under docs/ and report them.',
  description: 'List docs files',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  model: 'sonnet',
  parentModel: 'claude-opus-5-5',
  permissionMode: 'default',
  background: false,
  fork: false,
} as const

/** The world beneath the plugin: a subagent starts as its tool_use_id on sonnet; the main loop and the tools answer nothing. */
function world(on: On): void {
  on('agent.spawn', ($, e) => ({ model: SONNET, agentId: e.tool_use_id }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
}

/** The session log as the plugin last wrote it, seen from beneath the plugin (C7d). */
function lastLog(on: On): () => LogEntry[] {
  let log: LogEntry[] = []

  on('state.set', { plugin: 'agent-tree', key: 'log' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      log = [...(e.value as LogEntry[])]
    }

    return written
  })

  return () => log
}

const ended = (agentId: string, durationMs: number) => ({
  answer: '',
  durationMs,
  isAborted: false,
  turnId: `t-${agentId}`,
  agentId,
  reason: 'answer' as const,
})

/** The main loop's first request, then three subagents that ran to their end: a worker, an Explore researcher with three Grep calls, a worker with one Bash call; then the main loop's turn ends. */
async function threeSubagents($: Engine): Promise<void> {
  for await (const _chunk of $.turn.step({ turnId: 't0', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
    // The bottom answers with no chunks.
  }

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'a0', subagentType: 'general-purpose', description: 'Draft the chapter outline', prompt: 'Write the outline.' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'a1', description: 'List the changed files' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'a2', subagentType: 'general-purpose', description: 'Edit the test suite', prompt: 'Change the timeout.' })

  for (const tool of ['Grep', 'Grep', 'Grep']) {
    await $.tool.call({ tool, pattern: 'x', agentId: 'a1' } as never)
  }

  await $.tool.call({ tool: 'Bash', command: 'dir', agentId: 'a2' } as never)
  await $.turn.complete(ended('a0', 151_000))
  await $.turn.complete(ended('a1', 62_000))
  await $.turn.complete(ended('a2', 5000))
  await $.turn.complete({ answer: '', durationMs: 160_000, isAborted: false, turnId: 't0', reason: 'answer' })
}

/** What the plugin's tree holds after threeSubagents, rebuilt with the tree's own functions. */
function threeSubagentsTree(): TreeSnapshot {
  let tree = applyStep(emptyTree(NOW), { model: 'claude-opus-5-5', effort: 'high', now: NOW })

  for (const [id, type, description, prompt] of [
    ['a0', 'general-purpose', 'Draft the chapter outline', 'Write the outline.'],
    ['a1', 'Explore', 'List the changed files', 'List the files under docs/ and report them.'],
    ['a2', 'general-purpose', 'Edit the test suite', 'Change the timeout.'],
  ] as const) {
    tree = upsertFromSpawn(tree, { subagentType: type, description, prompt }, { agentId: id, model: SONNET }, NOW)
  }

  for (let call = 0; call < 3; call += 1) {
    tree = applyToolCall(tree, { agentId: 'a1', tool: 'Grep', now: NOW })
  }

  tree = applyToolCall(tree, { agentId: 'a2', tool: 'Bash', now: NOW })

  for (const [id, durationMs] of [
    ['a0', 151_000],
    ['a1', 62_000],
    ['a2', 5000],
  ] as const) {
    tree = applyTurnComplete(tree, { agentId: id, reason: 'answer', durationMs, now: NOW })
  }

  return applyTurnComplete(tree, { reason: 'answer', durationMs: 160_000, now: NOW })
}

/**
 * The plugin before any reading beyond the tree: no stats, no advisor call,
 * Jev off. Its log (C7d) holds the eleven lines threeSubagents made, drawn
 * oldest first with the plugin's own clock: the times are masked (`masked`).
 */
const MOUNT_WIDE_92 = [
  'AGENT TREE   ▮ main   ▮ subagents   ▮ fable · advisor   ▮ jev · flags',
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 0                    │ │ FABLE ADVISOR              │',
  '│ idle                                                      │ │ advisor: no calls yet      │',
  '└───────────────────────────────────────────────────────────┘ │ advice: encrypted by API   │',
  '                             │                                └────────────────────────────┘',
  '┌───────────────────────────────────────────────────────────┐',
  '│ Jev off — enable in /plugin configure agent-tree@agent-t~ │',
  '└───────────────────────────────────────────────────────────┘',
  '                   delegate to subagents',
  '         ┌───────────────────┼───────────────────┐',
  '         ▼                   ▼                   ▼',
  '┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐',
  '│ worker          │ │ researcher      │ │ worker          │',
  '│ sonnet-5-5      │ │ sonnet-5-5      │ │ sonnet-5-5      │',
  '│ Draft the chap~ │ │ List the chang~ │ │ Edit the test ~ │',
  '│ ✓ 2m31s         │ │ ✓ Grep/3 1m02s  │ │ ✓ Bash/1 5s     │',
  '└─────────────────┘ └─────────────────┘ └─────────────────┘',
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ hh:mm:ss  general-p~  spawn general-purpose Draft the ch~ │ │ ctx --                     │',
  '│ hh:mm:ss  Explore     spawn Explore List the changed fil~ │ │ $-- · agents 0/3           │',
  '│ hh:mm:ss  general~#2  spawn general-purpose Edit the tes~ │ │ --:--:--                   │',
  '│ hh:mm:ss  Explore     Grep x                              │ │                            │',
  '│ hh:mm:ss  Explore     Grep x                              │ │                            │',
  '│ hh:mm:ss  Explore     Grep x                              │ │                            │',
  '│ hh:mm:ss  general~#2  Bash dir                            │ │                            │',
  '│ hh:mm:ss  general-p~  done 2m31s                          │ │                            │',
  '│ hh:mm:ss  Explore     done 1m02s                          │ │                            │',
  '│ hh:mm:ss  general~#2  done 5s                             │ │                            │',
  '│ hh:mm:ss  main        turn done 2m40s                     │ │                            │',
  '└───────────────────────────────────────────────────────────┘ └────────────────────────────┘',
  'main [opus-5-5 · high]  subagents [0/3]  fable [on call · 0]  jev [off]',
]

const MOUNT_NARROW_60 = [
  '┌──────────────────────────────────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 0                   │',
  '│ idle                                                     │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ Jev off — enable in /plugin configure agent-tree@agent-~ │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ ✓ worker sonnet-5-5 general-purpose 2m31s                │',
  '│ ✓ researcher sonnet-5-5 Explore Grep/3 1m02s             │',
  '│ ✓ worker sonnet-5-5 general-purpose Bash/1 5s            │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ FABLE ADVISOR                                            │',
  '│ advisor: no calls yet                                    │',
  '│ advice: encrypted by API                                 │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ hh:mm:ss  general-p~  spawn general-purpose Draft the c~ │',
  '│ hh:mm:ss  Explore     spawn Explore List the changed fi~ │',
  '│ hh:mm:ss  general~#2  spawn general-purpose Edit the te~ │',
  '│ hh:mm:ss  Explore     Grep x                             │',
  '│ hh:mm:ss  Explore     Grep x                             │',
  '│ hh:mm:ss  Explore     Grep x                             │',
  '│ hh:mm:ss  general~#2  Bash dir                           │',
  '│ hh:mm:ss  general-p~  done 2m31s                         │',
  '│ hh:mm:ss  Explore     done 1m02s                         │',
  '│ hh:mm:ss  general~#2  done 5s                            │',
  '│ hh:mm:ss  main        turn done 2m40s                    │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ ctx --                                                   │',
  '│ $-- · agents 0/3 · --:--:--                              │',
  '└──────────────────────────────────────────────────────────┘',
  'main [opus-5-5]  sub [0/3]  fable [0]  jev [off]',
]

const MOUNT_WIDE_92_IN_14_ROWS = [
  '┌───────────────────────────────────────────────────────────┐ ┌────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 0                    │ │ FABLE ADVISOR              │',
  '│ idle                                                      │ │ advisor: no calls yet      │',
  '└───────────────────────────────────────────────────────────┘ │ advice: encrypted by API   │',
  '┌───────────────────────────────────────────────────────────┐ └────────────────────────────┘',
  '│ Jev off — enable in /plugin configure agent-tree@agent-t~ │',
  '└───────────────────────────────────────────────────────────┘',
  '┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐',
  '│ worker          │ │ researcher      │ │ worker          │',
  '│ sonnet-5-5      │ │ sonnet-5-5      │ │ sonnet-5-5      │',
  '│ Draft the chap~ │ │ List the chang~ │ │ Edit the test ~ │',
  '│ ✓ 2m31s         │ │ ✓ Grep/3 1m02s  │ │ ✓ Bash/1 5s     │',
  '└─────────────────┘ └─────────────────┘ └─────────────────┘',
  'main [opus-5-5 · high]  subagents [0/3]  fable [on call · 0]  jev [off]',
]

const MOUNT_NARROW_60_IN_12_ROWS = [
  '┌──────────────────────────────────────────────────────────┐',
  '│ main session  opus-5-5 · high · turn 0                   │',
  '│ idle                                                     │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ Jev off — enable in /plugin configure agent-tree@agent-~ │',
  '└──────────────────────────────────────────────────────────┘',
  '┌──────────────────────────────────────────────────────────┐',
  '│ ✓ worker sonnet-5-5 general-purpose Bash/1 5s            │',
  '│ +2 more                                                  │',
  '└──────────────────────────────────────────────────────────┘',
  'main [opus-5-5]  sub [0/3]  fable [0]  jev [off]',
]

describe('the pane mounted through the plugin', () => {
  test('92 columns: the wide drawing, the same on terminal and desktop', async ($, on) => {
    world(on)
    await threeSubagents($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: propsFor(92, 40) })

      expect(masked(await drawnBy(ui, 92)), surface).toEqual(MOUNT_WIDE_92)
      await ui.unmount()
    }
  })

  test('60 columns: the narrow drawing, the same on terminal and desktop', async ($, on) => {
    world(on)
    await threeSubagents($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: propsFor(60, 40) })

      expect(masked(await drawnBy(ui, 60)), surface).toEqual(MOUNT_NARROW_60)
      await ui.unmount()
    }
  })

  test('the elements the engine makes and the plain-data constructors draw the same rows', async ($, on) => {
    const logged = lastLog(on)

    world(on)
    await threeSubagents($)

    const data: PaneData = {
      tree: threeSubagentsTree(),
      stats: EMPTY_STATS,
      advisor: EMPTY_ADVISOR,
      jev: EMPTY_JEV,
      activity: EMPTY_ACTIVITY,
      log: logged(),
      now: NOW,
      frame: 0,
    }

    // The session's own log: the eleven lines of threeSubagents, drawn from what the plugin wrote.
    expect(data.log).toHaveLength(11)

    for (const [columns, rows] of [
      [92, 40],
      [60, 40],
      [92, 14],
      [60, 12],
      [88, 40],
      [87, 40],
    ] as const) {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsFor(columns, rows) })

      expect(await drawnBy(ui, columns), `${columns} columns, ${rows} rows`).toEqual(draw({ ...data, bodyRows: rows }, columns))
      await ui.unmount()
    }
  })

  test('88 columns is the first wide drawing, 87 the last narrow one', async ($, on) => {
    world(on)
    await threeSubagents($)

    for (const [columns, isWide] of [
      [87, false],
      [88, true],
    ] as const) {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsFor(columns, 40) })
      const lines = trimmed(await drawnBy(ui, columns))

      // The legend is the wide variant's first row; the narrow one begins with the main box.
      expect(lines[0]?.startsWith('AGENT TREE'), `${columns} columns`).toBe(isWide)
      expect(lines[0]?.startsWith('┌'), `${columns} columns`).toBe(!isWide)
      expect(lines.length, `${columns} columns`).toBe(isWide ? 32 : 35)
      await ui.unmount()
    }
  })

  test('the body rows fit the drawing: 14 rows wide, 12 rows narrow; redrawn in place as the dock is dragged', async ($, on) => {
    world(on)
    await threeSubagents($)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsFor(92, 40) })

    expect(masked(await drawnBy(ui, 92))).toEqual(MOUNT_WIDE_92)
    await ui.redraw(propsFor(60, 12))
    expect(trimmed(await drawnBy(ui, 60))).toEqual(MOUNT_NARROW_60_IN_12_ROWS)
    await ui.redraw(propsFor(92, 14))
    expect(trimmed(await drawnBy(ui, 92))).toEqual(MOUNT_WIDE_92_IN_14_ROWS)
    await ui.redraw(propsFor(60, 40))
    expect(masked(await drawnBy(ui, 60))).toEqual(MOUNT_NARROW_60)
    await ui.unmount()
  })

  test('no body rows given: every box draws all its lines', async ($, on) => {
    world(on)
    await threeSubagents($)

    // The engine always hands `scroll` over; the plugin reads it defensively.
    const bare = { title: 'Agent Tree', isFocused: false, bodyColumns: 92, placement: 'dock', view: {} }
    const open = await $.ui.mount({ ...PANE, surface: 'terminal', props: bare as never })
    const all = await drawnBy(open, 92)

    await open.unmount()

    const tight = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsFor(92, 14) })
    const cut = await drawnBy(tight, 92)

    await tight.unmount()

    expect(masked(all)).toEqual(MOUNT_WIDE_92)
    expect(all).toHaveLength(32)
    expect(cut).toHaveLength(14)
  })

  test('the log box follows the log (C7d): a call the plugin sees is drawn at the bottom, and a full box drops its oldest line', async ($, on) => {
    world(on)
    await threeSubagents($)

    // 92 columns, 26 rows: the log box has five lines, the last five of the eleven; its text is columns 2 to 58 of the pane's rows.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsFor(92, 26) })
    const logOf = async (): Promise<string[]> =>
      masked(await drawnBy(ui, 92))
        .filter(line => line.startsWith('│ hh:mm:ss  '))
        .map(line => line.slice(2, 59).trimEnd())

    expect(await logOf()).toEqual([
      'hh:mm:ss  general~#2  Bash dir',
      'hh:mm:ss  general-p~  done 2m31s',
      'hh:mm:ss  Explore     done 1m02s',
      'hh:mm:ss  general~#2  done 5s',
      'hh:mm:ss  main        turn done 2m40s',
    ])

    await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r9', file_path: 'D:\\docs\\README.md' } as never)

    expect(await logOf()).toEqual([
      'hh:mm:ss  general-p~  done 2m31s',
      'hh:mm:ss  Explore     done 1m02s',
      'hh:mm:ss  general~#2  done 5s',
      'hh:mm:ss  main        turn done 2m40s',
      'hh:mm:ss  main        Read README.md',
    ])
    await ui.unmount()
  })

  test('narrow: more subagents than the rows hold, the latest keeps its line and `+4 more` takes the last', async ($, on) => {
    world(on)

    for (let index = 0; index < 5; index += 1) {
      await $.agent.spawn({ ...SPAWN, tool_use_id: `a${index}`, subagentType: `Explore${index}` })
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsFor(60, 9) })
    const lines = trimmed(await drawnBy(ui, 60))

    expect(lines).toHaveLength(9)
    expect(lines[4]).toBe(`┌${'─'.repeat(58)}┐`)
    // C7c2: the model leads the line (this world's spawns answer sonnet-5-5).
    expect(lines[5]).toMatch(/^│ ◐ researcher sonnet-5-5 Explore4 \d+s +│$/)
    expect(lines[6]).toMatch(/^│ \+4 more +│$/)
    expect(lines[7]).toBe(`└${'─'.repeat(58)}┘`)
    // No model read: the widest form of the status row is short enough for 60 columns.
    expect(lines[8]).toBe('main [--]  subagents [5/5]  fable [on call · 0]  jev [off]')
    await ui.unmount()
  })
})

describe('roles on the boxes (PRD M-L1a)', () => {
  /** The role titles of the subagent boxes of a wide pane, in tree order. */
  async function titles($: Engine): Promise<string[]> {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsFor(160, 40) })
    const found = await ui.findAll({ type: 'Text', text: /^(worker|researcher)$/ })

    await ui.unmount()

    return found.map(element => element.text)
  }

  test('a subagent is titled by the type, the description and the prompt its spawn carried, and turns worker at its first file write', async ($, on) => {
    world(on)

    for (const [id, type, description, prompt] of [
      ['a1', 'Explore', 'Map the repo', 'Describe the layout.'],
      ['a2', 'general-purpose', 'Wire the exporter', 'Please find the slow query in the exporter.'],
      ['a3', 'general-purpose', 'Search the logs', 'Change nothing.'],
      ['a4', 'general-purpose', 'Fix the build', 'Change the timeout to 30 s.'],
    ] as const) {
      await $.agent.spawn({ ...SPAWN, tool_use_id: id, subagentType: type, description, prompt })
    }

    // The type, the prompt's task word, the description's task word, none.
    expect(await titles($)).toEqual(['researcher', 'researcher', 'researcher', 'worker'])

    // Bash and Read write no file; Edit and NotebookEdit do, and a later Read does not undo it.
    await $.tool.call({ tool: 'Bash', command: 'dir', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Edit', agentId: 'a2' } as never)
    await $.tool.call({ tool: 'NotebookEdit', agentId: 'a3' } as never)
    await $.tool.call({ tool: 'Read', agentId: 'a2' } as never)
    expect(await titles($)).toEqual(['researcher', 'worker', 'worker', 'worker'])
  })

  test('a researcher that writes a file is titled worker from its first Edit on, in the box and on the narrow line', () => {
    let tree = upsertFromSpawn(emptyTree(NOW), { subagentType: 'Explore', description: 'Map the repo' }, { agentId: 'a1' }, NOW)

    const node = (): AgentNode => tree.agents[0] ?? agent()
    const title = (): string | undefined => agentBoxRows(node(), 0, NOW, 15)[0]?.text
    const line = (): string => agentLine(node(), 0, NOW, 56).text

    expect(title()).toBe('researcher')
    expect(line()).toBe('◐ researcher Explore 0s')
    tree = applyToolCall(tree, { agentId: 'a1', tool: 'Bash', now: NOW })
    expect(title()).toBe('researcher')
    tree = applyToolCall(tree, { agentId: 'a1', tool: 'Edit', now: NOW })
    expect(title()).toBe('worker')
    expect(line()).toBe('◐ worker Explore Edit/2 0s')
    tree = applyToolCall(tree, { agentId: 'a1', tool: 'Read', now: NOW })
    expect(title()).toBe('worker')
  })
})

describe('external workers on the boxes (PRD M-L1b)', () => {
  /** An external worker as the tree keeps it: Kimi, started by a shell tool call 130 seconds ago. */
  function external(changes: Partial<AgentNode> = {}): AgentNode {
    return {
      id: 'ext:toolu_k1',
      kind: 'external',
      type: 'kimi',
      description: 'Run kimi on card C7',
      role: 'worker',
      model: 'kimi-code/k3',
      status: 'running',
      toolCalls: 0,
      startedAt: NOW - 130_000,
      ...changes,
    }
  }

  const sub = (text: string, style: { dim?: boolean; bold?: boolean } = {}) => boxRow(text, COLORS.sub, style)

  const texts = (rows: readonly { text: string }[]): string[] => rows.map(row => row.text)

  test('agentBoxRows: the role in bold, `<model> · <engine>`, the task, the glyph and the time with no tool count, in the subagents\' blue', () => {
    // 92 columns: 15 of text; `kimi-code/k3 · kimi` is 19: the model alone.
    expect(agentBoxRows(external(), 0, NOW, 15)).toEqual([sub('worker', { bold: true }), sub('kimi-code/k3'), sub('Run kimi on ca~'), sub('◐ 2m10s')])
    // 160 columns: 22 of text, room for all of it; Codex as the user runs chatgpt-6.1sol.
    expect(texts(agentBoxRows(external(), 0, NOW, 22))).toEqual(['worker', 'kimi-code/k3 · kimi', 'Run kimi on card C7', '◐ 2m10s'])
    expect(texts(agentBoxRows(external({ type: 'codex', model: 'chatgpt-6.1sol', description: 'fix tests' }), 0, NOW, 22))).toEqual([
      'worker',
      'chatgpt-6.1sol · codex',
      'fix tests',
      '◐ 2m10s',
    ])
    // The same rule as a subagent's: the engine gives way down to three characters of it, then the model stands alone.
    const codex = external({ type: 'codex', model: 'chatgpt-6.1sol' })

    expect(agentBoxRows(codex, 0, NOW, 21)[1]?.text).toBe('chatgpt-6.1sol · cod~')
    expect(agentBoxRows(codex, 0, NOW, 20)[1]?.text).toBe('chatgpt-6.1sol')
    expect(agentBoxRows(external(), 0, NOW, 19)[1]?.text).toBe('kimi-code/k3 · kimi')
    expect(agentBoxRows(external(), 0, NOW, 18)[1]?.text).toBe('kimi-code/k3')
    // No model in the command: the engine alone; run in the background: ` bg`, as a subagent's.
    expect(agentBoxRows(external({ model: undefined }), 0, NOW, 15)[1]?.text).toBe('kimi')
    expect(agentBoxRows(external({ background: true }), 0, NOW, 22)[1]?.text).toBe('kimi-code/k3 · kimi bg')
    expect(agentBoxRows(external({ background: true }), 0, NOW, 15)[1]?.text).toBe('kimi-code/k3')
    // Whatever count a node carries, an external worker's box shows none; no task is `--`.
    expect(agentBoxRows(external({ toolCalls: 3, lastTool: 'Grep' }), 0, NOW, 15)[3]?.text).toBe('◐ 2m10s')
    expect(agentBoxRows(external({ description: '' }), 0, NOW, 15)[2]?.text).toBe('--')
    // Finished: dim with the check, the title no longer bold (C7b), its start to its end; failed: the fail red and the cross.
    expect(agentBoxRows(external({ status: 'completed', endedAt: NOW - 85_000 }), 0, NOW, 15)).toEqual([
      sub('worker', { dim: true }),
      sub('kimi-code/k3', { dim: true }),
      sub('Run kimi on ca~', { dim: true }),
      sub('✓ 45s', { dim: true }),
    ])
    expect(agentBoxRows(external({ status: 'failed', endedAt: NOW - 128_000 }), 0, NOW, 15)[3]).toEqual(boxRow('✗ 2s', COLORS.fail))
    // A researcher's task word titles it researcher, as a subagent's does.
    expect(agentBoxRows(external({ role: 'researcher', description: 'Review the diff' }), 0, NOW, 15)[0]?.text).toBe('researcher')
  })

  test('agentLine: the model first, as a subagent\'s, then the engine and no tool: `◐ worker kimi-code/k3 kimi 2m10s`', () => {
    expect(agentLine(external(), 0, NOW, 56)).toEqual(sub('◐ worker kimi-code/k3 kimi 2m10s'))
    expect(agentLine(external({ model: undefined }), 0, NOW, 56).text).toBe('◐ worker kimi 2m10s')
    expect(agentLine(external({ background: true }), 1, NOW, 56).text).toBe('◓ worker kimi-code/k3 kimi bg 2m10s')
    expect(agentLine(external({ toolCalls: 2, lastTool: 'Bash' }), 0, NOW, 56).text).toBe('◐ worker kimi-code/k3 kimi 2m10s')
    expect(agentLine(external({ type: 'codex', model: 'chatgpt-6.1sol', status: 'completed', endedAt: NOW - 85_000 }), 0, NOW, 56)).toEqual(
      sub('✓ worker chatgpt-6.1sol codex 45s', { dim: true }),
    )
    expect(agentLine(external({ status: 'failed', endedAt: NOW - 128_000 }), 0, NOW, 56)).toEqual(boxRow('✗ worker kimi-code/k3 kimi 2s', COLORS.fail))
    expect(agentLine(external(), 0, NOW, 20).text).toBe('◐ worker kimi-code/~')
  })

  test('the status row, the usage box and the status entry count external workers with the subagents', () => {
    // A finished subagent, a running Kimi, a failed Kimi: one running of three.
    const tree = withAgents([
      agent({ status: 'completed', durationMs: 62_000 }),
      external(),
      external({ id: 'ext:toolu_k2', status: 'failed', endedAt: NOW - 100_000 }),
    ])

    expect(statusForms({ tree, activity: EMPTY_ACTIVITY, advisor: EMPTY_ADVISOR, jev: EMPTY_JEV, now: NOW }).map(form => form[1]?.text)).toEqual([
      'subagents [1/3]',
      'subagents [1/3]',
      'sub [1/3]',
    ])
    expect(texts(usageRows({ tree, stats: EMPTY_STATS, now: NOW }, 26))).toEqual(['ctx --', '$-- · agents 1/3', '--:--:--'])
    expect(statusText(tree, EMPTY_STATS, EMPTY_ADVISOR)).toBe('agent-tree 1/3')
  })
})
