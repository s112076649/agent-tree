import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  clip,
  formatAge,
  limitRows,
  oneLine,
  packSegments,
  paneWidth,
  shortModel,
  widthOf,
} from './render/text'
import { BORDER_STYLE, SPINNER, geometry, spinnerGlyph, variant } from './render/layout'
import { COLORS } from './render/theme'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = { plugin: 'agent-tree', component: 'Pane', requestId: 'agent-tree' } as const

/** Pane props as a docked pane of 100 columns and 30 rows receives them. */
const PROPS = {
  title: 'Agent Tree',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const FAIL_RED = '#f85149'

const SUB_BLUE = '#58a6ff'

/** One Text of a drawing: what it shows and how. */
type DrawnRow = { text: string; color: unknown; dim: boolean; bold: boolean }

/** The Text rows inside a drawn element (a FoundElement or a child description), in document order. */
function textRows(node: unknown): DrawnRow[] {
  if (typeof node !== 'object' || node === null) {
    return []
  }

  const element = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const children = element.children ?? []

  if (element.type === 'Text') {
    return [
      {
        text: children.filter((child): child is string => typeof child === 'string').join(''),
        color: element.props?.color,
        dim: element.props?.dimColor === true,
        bold: element.props?.bold === true,
      },
    ]
  }

  return children.flatMap(textRows)
}

/** The rows of every box drawn with a `color` border, one list per box, in document order. */
async function boxRows(ui: Pick<Mounted, 'findAll'>, color: string): Promise<DrawnRow[][]> {
  const boxes = await ui.findAll({ type: 'Box' })

  return boxes.filter(box => box.props.borderColor === color).map(textRows)
}

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

/** `$.session.usage()` after a first response (C0 run A), the session started 5 s ago. */
function usageNow() {
  return {
    startedAt: Date.now() - 5000,
    context: { tokens: 61_098, window: 1_000_000, percent: 6 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 57, resetsAt: '2026-10-02T11:30:00.000Z' },
      { kind: 'seven_day', percentUsed: 53, resetsAt: '2026-10-06T06:00:00.000Z' },
    ],
    cost: { usd: 1.335259 },
  }
}

describe('the pane', () => {
  test('draws the main model and each subagent, a failed one in red, on terminal and desktop', async ($, on) => {
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id === 'toolu_1' ? 'a1' : 'a2' }))
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))

    // The main loop's first model request: its model and effort reach the header.
    for await (const _chunk of $.turn.step({
      turnId: 't0',
      index: 0,
      model: 'claude-opus-5-5',
      effort: 'medium',
      messageCount: 3,
    })) {
      // The bottom answers with no chunks.
    }

    await $.agent.spawn(SPAWN)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'Plan the work', subagentType: 'Plan' })
    await $.turn.complete({ answer: '', durationMs: 1200, isAborted: false, turnId: 't2', agentId: 'a2', reason: 'error' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })

      expect(await ui.drawn()).toMatchObject({ type: 'Box' })
      expect((await ui.find({ type: 'Text', text: 'AGENT TREE' }))?.props).toMatchObject({ color: COLORS.main, bold: true })
      // C7a: the main box's first line, `main session` in bold and the model, effort and turn beside it.
      expect((await boxRows(ui, COLORS.main))[0]?.slice(0, 2)).toEqual([
        { text: 'main session', color: COLORS.main, dim: false, bold: true },
        { text: 'opus-5-5 · medium · turn 0', color: COLORS.main, dim: false, bold: false },
      ])
      // C7-0: the main status behind the spinner glyph of frame 0 (no timer ran); C7b: and the time since it began.
      expect(await ui.find({ type: 'Text', text: /^◐ thinking \d+s$/ })).toBeDefined()

      // C7a: a box per subagent: the role in bold; model · type (C7c2: the model whole, the type cut to what the box's 18 columns leave); description; status glyph, last tool, time.
      const [running, failed] = await boxRows(ui, SUB_BLUE)

      expect(running?.map(row => row.text)).toEqual([
        'researcher',
        'sonnet-5-5 · Expl~',
        'List docs files',
        expect.stringMatching(/^◐ \d+s$/),
      ])
      expect(running?.map(row => row.bold)).toEqual([true, false, false, false])
      expect(running?.every(row => row.color === SUB_BLUE && !row.dim)).toBe(true)
      expect(failed?.map(row => row.text)).toEqual(['researcher', 'sonnet-5-5 · Plan', 'Plan the work', '✗ 1s'])
      expect(failed?.every(row => row.color === FAIL_RED)).toBe(true)

      expect(await ui.find({ type: 'Text', text: 'advisor: no calls yet' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Jev off — enable in /plugin configure agent-tree@agent-tree' })).toBeDefined()
      // C7a: the stats in the usage box: no context read yet, then cost, agents and clock packed into its 26 columns.
      expect(await ui.find({ type: 'Text', text: /^ctx --$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^\$-- · agents 1\/2$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^--:--:--$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('under 60 columns the rows leave the description out', async ($, on) => {
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
    await $.agent.spawn(SPAWN)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, bodyColumns: 50 } })

      // C7a narrow: one line per subagent, its glyph, role, model (C7c2), type, last tool and time.
      expect(await ui.find({ type: 'Text', text: /^◐ researcher sonnet-5-5 Explore \d+s$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /List docs files/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('more subagents than the rows hold: the latest keep their boxes and a +k more box takes the last place', async ($, on) => {
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))

    // A task each: the boxes are told apart by their description rows (C7c2: at 100 columns the type is cut to `Expl~` behind the model, the same in every box).
    for (let index = 0; index < 10; index += 1) {
      await $.agent.spawn({ ...SPAWN, tool_use_id: `a${index}`, description: `task ${index}`, subagentType: `Explore${index}` })
    }

    // 8 body rows: one line of subagent boxes (three places at 100 columns), the latest two and +8 more.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PROPS, scroll: { offset: 0, bodyRows: 8 } } })
    const boxes = await boxRows(ui, SUB_BLUE)

    expect(boxes.map(rows => (rows.length === 1 ? rows[0]?.text : rows[2]?.text))).toEqual(['task 8', 'task 9', '+8 more'])
    expect(boxes.slice(0, 2).map(rows => rows[1]?.text)).toEqual(['sonnet-5-5 · Expl~', 'sonnet-5-5 · Expl~'])
    // The +k more box names no role.
    expect(boxes.at(-1)).toEqual([{ text: '+8 more', color: SUB_BLUE, dim: true, bold: false }])
    expect(await ui.find({ type: 'Text', text: /^task 0$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('C7c2: the model leads the box row (PRD M-L1a): at 92 columns it stands alone (the type needs 17 columns of text), at 96 the type comes back cut, at 160 whole', async ($, on) => {
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
    await $.agent.spawn(SPAWN)

    for (const surface of SURFACES) {
      for (const [columns, kind] of [
        [92, 'sonnet-5-5'],
        [96, 'sonnet-5-5 · Exp~'],
        [160, 'sonnet-5-5 · Explore'],
      ] as const) {
        const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, bodyColumns: columns } })

        expect((await boxRows(ui, SUB_BLUE))[0]?.[1]?.text, `${surface}, ${columns} columns`).toBe(kind)
        await ui.unmount()
      }
    }
  })
})

describe('session start, refresh and the status entry', () => {
  test('registers /agent-tree, opens the pane, and the refresh fills the stats line and the status entry', { options: { autoOpen: true } }, async (
    $,
    on,
  ) => {
    const clock = mock.clock(on, { now: Date.now() })
    const registered: string[] = []
    const opened: string[] = []
    const statuses: (string | undefined)[] = []

    on('command.register', ($, e) => {
      registered.push(e.name)

      return { value: { command: e.name } }
    })
    on('ui.open', ($, e) => {
      opened.push(e.id)

      return { value: { isPlaced: true } }
    })
    on('ui.status', ($, e) => {
      statuses.push(e.text)

      return { value: undefined }
    })
    on('agent.list', () => ({
      value: [{ id: 'bg1', description: 'Watch the build', type: 'general-purpose', status: 'running' }],
    }))
    on('session.usage', () => ({ value: usageNow() }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.turns', () => ({ value: 2 }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)

    expect(registered).toEqual(['agent-tree'])
    expect(opened).toEqual(['agent-tree'])
    expect(statuses.length).toBeGreaterThanOrEqual(2)
    expect(statuses.at(-1)).toBe('agent-tree 1/1 · ctx 6% · $1.34')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })

      expect(await ui.find({ type: 'Text', text: /^opus-5-5 · turn 2$/ })).toBeDefined()
      // C7a: the listed background agent's box: its role, its type alone (the list names no model), its description.
      expect((await boxRows(ui, SUB_BLUE))[0]?.map(row => row.text)).toEqual([
        'worker',
        'general-purpose',
        'Watch the build',
        expect.stringMatching(/^[◐◓◑◒] \d+s$/),
      ])
      // C7a: the stats in the usage box: a bar per gauge, then cost, agents and clock.
      expect(await ui.find({ type: 'Text', text: /^ctx ▓░{9} 6% 61k\/1M$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^5h {2}▓{6}░{4} 57%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^7d {2}▓{5}░{5} 53%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^\$1\.34 · agents 1\/1$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^00:00:0\d$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('autoOpen off leaves the pane closed at session start', { options: { autoOpen: false } }, async ($, on) => {
    const opened: string[] = []

    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', ($, e) => {
      opened.push(e.id)

      return { value: { isPlaced: true } }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

    expect(opened).toEqual([])
  })

  test('/agent-tree opens the pane, then closes it once it is drawn', async ($, on) => {
    let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
    const calls: string[] = []

    on('ui.panes', () => ({ value: panes }))
    on('ui.open', ($, e) => {
      calls.push(`open ${e.id}`)
      panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]

      return { value: { isPlaced: true } }
    })
    on('ui.close', ($, e) => {
      calls.push(`close ${e.id}`)
      panes = []

      return { value: undefined }
    })

    const toggle = () =>
      $.command.run({
        command: 'agent-tree',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 160 },
      })

    expect((await toggle()).text).toBe('Agent Tree pane opened.')
    expect((await toggle()).text).toBe('Agent Tree pane closed. /agent-tree opens it again.')
    expect(calls).toEqual(['open agent-tree', 'close agent-tree'])
  })
})

describe('row text', () => {
  test('helpers: clip counts wide characters, segments wrap, rows are limited, models and ages shortened', () => {
    expect(clip('abcdef', 4)).toBe('abc~')
    expect(clip('调研文档目录', 7)).toBe('调研文~')
    expect(widthOf('调研')).toBe(4)
    expect(oneLine('one\ntwo')).toBe('one two')
    expect(packSegments(['ctx 6% (61k/1M)', '$1.34', '5h 57%'], 20)).toEqual(['ctx 6% (61k/1M)', '$1.34 · 5h 57%'])
    expect(limitRows([1, 2, 3, 4, 5], 3)).toEqual({ shown: [4, 5], hidden: 3 })
    expect(limitRows([1, 2], undefined)).toEqual({ shown: [1, 2], hidden: 0 })
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
    expect(shortModel(undefined)).toBe('')
    expect(formatAge(12_000)).toBe('12s')
    expect(formatAge(184_000)).toBe('3m04s')
    expect(formatAge(3_720_000)).toBe('1h02m')
    expect(formatAge(undefined)).toBe('--')
    expect(paneWidth(48, 120)).toBe(48)
    expect(paneWidth(undefined, 120)).toBe(120)
    expect(paneWidth(undefined, undefined)).toBe(80)
  })
})

describe('bordered boxes, two columns from 88, the frame tick (C7-0; the C7a layout)', () => {
  const T = 1_790_928_100_000

  /** A drawn element as plain data: its tag, props and children. */
  type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

  const isElement = (node: unknown): node is Drawn => typeof node === 'object' && node !== null

  /**
   * What would overflow in a drawing at `room` columns: a Text wider than the
   * text room of its box, a Box wider than the room it is in, the boxes of a
   * row that does not wrap wider together (gaps included) than the row.
   */
  function overflows(node: unknown, room: number, found: string[]): string[] {
    if (!isElement(node)) {
      return found
    }

    const props = node.props ?? {}
    const children = (node.children ?? []).filter(isElement)

    if (node.type === 'Text') {
      const text = (node.children ?? []).filter((child): child is string => typeof child === 'string').join('')

      if (widthOf(text) > room) {
        found.push(`Text ${JSON.stringify(text)} is ${widthOf(text)} wide in ${room}`)
      }

      return found
    }

    const width = typeof props.width === 'number' ? props.width : room

    if (width > room) {
      found.push(`Box ${width} wide in ${room}`)
    }

    const padding = typeof props.paddingX === 'number' ? props.paddingX : 0
    const inner = width - (props.borderStyle === undefined ? 0 : 2) - 2 * padding

    if (props.flexDirection === 'row' && props.flexWrap !== 'wrap') {
      const gap = typeof props.gap === 'number' ? props.gap : 0
      const total = children.reduce((sum, child) => sum + Number(child.props?.width ?? 0), 0) + gap * Math.max(0, children.length - 1)

      if (total > inner) {
        found.push(`row of ${total} in ${inner}`)
      }
    }

    for (const child of children) {
      overflows(child, inner, found)
    }

    return found
  }

  /** A world beneath the plugin: the pane opens drawn, subagents start and end, the main loop steps. */
  function world(on: On) {
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))
  }

  /** Every `frame` write that landed, seen from beneath the plugin (the C4c technique). */
  function frameWrites(on: On): number[] {
    const writes: number[] = []

    on('state.set', { plugin: 'agent-tree', key: 'frame' }, async ($, e, next) => {
      const written = await next(e)

      if (written.value?.isSet === true) {
        writes.push(e.value)
      }

      return written
    })

    return writes
  }

  const subagentEnd = (agentId: string) => ({
    answer: '',
    durationMs: 1000,
    isAborted: false,
    turnId: `t-${agentId}`,
    agentId,
    reason: 'answer' as const,
  })

  test('(a) 92 columns: the boxes keep their single border, and one row holds the main box and the advisor box; on terminal and desktop', async ($, on) => {
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
    await $.agent.spawn(SPAWN)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, bodyColumns: 92 } })
      const boxes = await ui.findAll({ type: 'Box' })
      // The kit hands over what a surface is to draw, never its paint: the
      // border glyphs are the borderStyle each box keeps after the surface's
      // check (an unknown style is dropped there, the box drawn unbordered).
      const bordered = boxes.filter(box => box.props.borderStyle !== undefined)

      // C7a: the session log box and the usage box follow, in the terminal's own color.
      expect(BORDER_STYLE).toBe('single')
      expect(bordered.map(box => box.props.borderStyle), surface).toEqual(['single', 'single', 'single', 'single', 'single', 'single'])
      expect(bordered.map(box => box.props.borderColor), surface).toEqual([
        COLORS.main,
        COLORS.jev,
        COLORS.sub,
        COLORS.advisor,
        undefined,
        undefined,
      ])
      expect(bordered.map(box => box.props.width), surface).toEqual([61, 61, 19, 30, 61, 30])

      const rows = boxes.filter(box => box.props.flexDirection === 'row')
      const both = rows.filter(box => box.text.includes('main session') && box.text.includes('FABLE ADVISOR'))

      expect(both, surface).toHaveLength(1)
      expect(both[0]?.props.gap, surface).toBe(1)
      expect(await ui.find({ type: 'Text', text: /^main session$/ }), surface).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^FABLE ADVISOR$/ }), surface).toBeDefined()
      expect(overflows(await ui.drawn(), 92, []), surface).toEqual([])
      await ui.unmount()
    }
  })

  test('(b) 60 columns: one column, no row holds the main box and the advisor box, the subagents one line each; on terminal and desktop', async ($, on) => {
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
    await $.agent.spawn(SPAWN)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', subagentType: 'Plan' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, bodyColumns: 60 } })
      const boxes = await ui.findAll({ type: 'Box' })
      const bordered = boxes.filter(box => box.props.borderStyle !== undefined)

      expect(
        boxes.some(box => box.props.flexDirection === 'row' && box.text.includes('main session') && box.text.includes('FABLE ADVISOR')),
        surface,
      ).toBe(false)
      // C7a: the session log box and the usage box follow, in the terminal's own color.
      expect(bordered.map(box => box.props.borderColor), surface).toEqual([
        COLORS.main,
        COLORS.jev,
        COLORS.sub,
        COLORS.advisor,
        undefined,
        undefined,
      ])
      expect(bordered.every(box => box.props.width === 60 && box.props.borderStyle === 'single'), surface).toBe(true)
      expect((await boxRows(ui, SUB_BLUE))[0]?.map(row => row.text), surface).toEqual([
        expect.stringMatching(/^◐ researcher sonnet-5-5 Explore \d+s$/),
        expect.stringMatching(/^◐ researcher sonnet-5-5 Plan \d+s$/),
      ])
      expect(overflows(await ui.drawn(), 60, []), surface).toEqual([])
      await ui.unmount()
    }
  })

  test('no line overflows and no box is wider than its room, from 30 to 160 columns, with more subagents than boxes', async ($, on) => {
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
    on('tool.call', () => ({ result: undefined as never, text: 'ok' }))

    for (let index = 0; index < 5; index += 1) {
      await $.agent.spawn({ ...SPAWN, tool_use_id: `a${index}`, subagentType: index === 4 ? 'general-purpose' : 'Explore', background: index === 4 })
    }

    await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x', agentId: 'a4' } as never)

    for (const columns of [30, 59, 60, 87, 88, 92, 100, 140, 160]) {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PROPS, bodyColumns: columns } })

      expect(overflows(await ui.drawn(), columns, []), `${columns} columns`).toEqual([])
      expect(variant(columns), `${columns} columns`).toBe(columns >= 88 ? 'wide' : 'narrow')
      expect(geometry(columns).variant, `${columns} columns`).toBe(variant(columns))
      await ui.unmount()
    }
  })

  test('(c) the frame tick: with the pane open and a subagent running, 4 frame writes a second; idle, none; the main loop thinking moves it too', { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = frameWrites(on)

    world(on)
    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()

    // The pane open, nothing active: a second of periods writes nothing.
    await clock.advance(1000)
    expect(writes).toEqual([])

    await $.agent.spawn(SPAWN)
    await clock.advance(1000)
    expect(writes).toEqual([1, 2, 3, 0])

    // The subagent ended: still again.
    await $.turn.complete(subagentEnd('toolu_1'))
    await clock.advance(1000)
    expect(writes).toHaveLength(4)

    // The main loop thinking: the frame moves on until its turn ends.
    for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
      // The bottom answers with no chunks.
    }

    await clock.advance(500)
    expect(writes).toEqual([1, 2, 3, 0, 1, 2])

    await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(1000)
    expect(writes).toHaveLength(6)
  })

  test('the pane closed: a running subagent moves no frame', { options: { autoOpen: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = frameWrites(on)

    world(on)
    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })
    await $.agent.spawn(SPAWN)
    await clock.advance(1000)

    expect(writes).toEqual([])
  })

  test('(d) the spinner glyph changes from one frame to the next, in the subagent box and the main box', { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })

    world(on)
    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

    for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
      // The bottom answers with no chunks.
    }

    await $.agent.spawn(SPAWN)
    await clock.settle()

    // One drawing, read before and after one period: the frame write redraws it (its render reads `frame`).
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    const glyphs = async (): Promise<string[]> => {
      const main = await ui.find({ type: 'Text', text: / thinking \d+s$/ })
      // C7a: the status line is the box's fourth row, below the role, the type and the description.
      const sub = (await boxRows(ui, SUB_BLUE))[0]?.[3]

      return [main?.text.slice(0, 1) ?? '', sub?.text.slice(0, 1) ?? '']
    }

    const before = await glyphs()
    await clock.advance(250)
    const after = await glyphs()
    await ui.unmount()

    expect(before).toEqual(['◐', '◐'])
    expect(after).toEqual(['◓', '◓'])
    expect(SPINNER).toEqual(['◐', '◓', '◑', '◒'])
    expect([0, 1, 2, 3, 4, -1].map(spinnerGlyph)).toEqual(['◐', '◓', '◑', '◒', '◐', '◒'])
  })

  test('the pane writes its geometry to the debug log once per change', async ($, on) => {
    const logs: string[] = []

    on('ui.log', ($, e) => {
      logs.push(`${e.to}|${e.text}`)

      return { value: undefined }
    })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PROPS, bodyColumns: 92 } })
    await ui.redraw()
    await ui.redraw({ ...PROPS, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 12 } })
    await ui.unmount()

    expect(logs).toEqual([
      'debug|agent-tree: pane bodyColumns=92 placement=dock rows=30',
      'debug|agent-tree: pane bodyColumns=60 placement=inline rows=12',
    ])
  })
})

// C7a2: an engine CLI the shell tool starts is drawn as a worker box (PRD
// M-L1b), mounted through the plugin while the call runs and after it.
describe('external workers on the pane (PRD M-L1b)', () => {
  const WIDE = { ...PROPS, bodyColumns: 92 } as const

  const NARROW = { ...PROPS, bodyColumns: 60 } as const

  const texts = (rows: readonly DrawnRow[] | undefined): string[] => (rows ?? []).map(row => row.text)

  test('a foreground engine call, drawn while it runs and once it returned: its box at 92 columns, its line at 60, counted in the status row and the usage box; on terminal and desktop', async ($, on) => {
    const running: Record<string, { box: DrawnRow[]; line: string[]; counted: boolean[] }> = {}

    // The shell beneath the plugin: while the command runs, the pane is drawn.
    on('tool.call', async () => {
      for (const surface of SURFACES) {
        const wide = await $.ui.mount({ ...PANE, surface, props: WIDE })
        const box = (await boxRows(wide, SUB_BLUE))[0] ?? []
        const counted = [
          (await wide.find({ type: 'Text', text: /^subagents \[1\/1\]$/ })) !== undefined,
          (await wide.find({ type: 'Text', text: /^\$-- · agents 1\/1$/ })) !== undefined,
        ]
        await wide.unmount()

        const narrow = await $.ui.mount({ ...PANE, surface, props: NARROW })
        const line = texts((await boxRows(narrow, SUB_BLUE))[0])
        await narrow.unmount()

        running[surface] = { box, line, counted }
      }

      return { result: { stdout: 'done', stderr: '', interrupted: false } as never, text: 'done' }
    })

    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: 'kimi -m kimi-code/k3 -p "do X"', description: 'Run kimi on card C7' } as never)

    for (const surface of SURFACES) {
      const seen = running[surface]

      // C7c2: the model first; at 92 columns (15 of text) `kimi-code/k3 · kimi` does not fit, so the model stands alone.
      expect(texts(seen?.box), surface).toEqual(['worker', 'kimi-code/k3', 'Run kimi on ca~', expect.stringMatching(/^◐ \d+s$/)])
      expect(seen?.box.map(row => row.bold), surface).toEqual([true, false, false, false])
      expect(seen?.box.every(row => row.color === SUB_BLUE && !row.dim), surface).toBe(true)
      expect(seen?.line, surface).toEqual([expect.stringMatching(/^◐ worker kimi-code\/k3 kimi \d+s$/)])
      expect(seen?.counted, surface).toEqual([true, true])

      // Returned: finished, dim, the check; still counted, no longer running.
      const ui = await $.ui.mount({ ...PANE, surface, props: WIDE })
      const done = (await boxRows(ui, SUB_BLUE))[0]

      expect(texts(done), surface).toEqual(['worker', 'kimi-code/k3', 'Run kimi on ca~', expect.stringMatching(/^✓ \d+s$/)])
      expect(done?.every(row => row.dim), surface).toBe(true)
      expect(await ui.find({ type: 'Text', text: /^subagents \[0\/1\]$/ }), surface).toBeDefined()
      await ui.unmount()
    }
  })

  test('run in the background: drawn running with ` bg` after the call returned, finished once a stop no longer lists its task', async ($, on) => {
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-7' } as never, text: 'started' }))
    on('classic.Stop', () => ({}))

    await $.tool.call({
      tool: 'PowerShell',
      tool_use_id: 'toolu_b1',
      command: 'codex exec -m chatgpt-6.1sol "fix tests"',
      description: 'Codex fixes the tests',
      run_in_background: true,
    } as never)

    for (const surface of SURFACES) {
      const wide = await $.ui.mount({ ...PANE, surface, props: WIDE })

      // C7c2: `chatgpt-6.1sol · codex bg` is 25 columns: at 92 (15 of text) the model stands alone.
      expect(texts((await boxRows(wide, SUB_BLUE))[0]), surface).toEqual([
        'worker',
        'chatgpt-6.1sol',
        'Codex fixes th~',
        expect.stringMatching(/^◐ \d+s$/),
      ])
      await wide.unmount()

      const narrow = await $.ui.mount({ ...PANE, surface, props: NARROW })

      expect(texts((await boxRows(narrow, SUB_BLUE))[0]), surface).toEqual([expect.stringMatching(/^◐ worker chatgpt-6\.1sol codex bg \d+s$/)])
      await narrow.unmount()
    }

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: NARROW })

    expect(texts((await boxRows(ui, SUB_BLUE))[0])).toEqual([expect.stringMatching(/^✓ worker chatgpt-6\.1sol codex bg \d+s$/)])
    await ui.unmount()
  })

  test('C7c2: chatgpt-6.1sol on Codex (PRD M-L1b): `chatgpt-6.1sol · codex` once the box has 22 columns of text (a pane of 160), the model alone at 92; the narrow line `✓ worker chatgpt-6.1sol codex 0s`', async ($, on) => {
    on('tool.call', () => ({ result: { stdout: 'done', stderr: '', interrupted: false } as never, text: 'done' }))
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_c1', command: 'codex exec -m chatgpt-6.1sol "fix tests"', description: 'fix tests' } as never)

    for (const surface of SURFACES) {
      for (const [columns, kind] of [
        [92, 'chatgpt-6.1sol'],
        [160, 'chatgpt-6.1sol · codex'],
      ] as const) {
        const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, bodyColumns: columns } })

        expect(texts((await boxRows(ui, SUB_BLUE))[0])[1], `${surface}, ${columns} columns`).toBe(kind)
        await ui.unmount()
      }

      const narrow = await $.ui.mount({ ...PANE, surface, props: NARROW })

      expect(texts((await boxRows(narrow, SUB_BLUE))[0]), surface).toEqual([expect.stringMatching(/^✓ worker chatgpt-6\.1sol codex \d+s$/)])
      await narrow.unmount()
    }
  })
})
