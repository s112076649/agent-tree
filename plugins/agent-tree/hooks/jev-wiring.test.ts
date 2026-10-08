import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { JevEvent, JevSnapshot } from '../types'
import {
  EMPTY_JEV,
  JEV_ENDPOINT,
  JEV_NO_KEY,
  applyAnswers,
  applyError,
  clearJevInFlight,
  endCall,
  parseAnswers,
  startCall,
  withoutSecret,
} from './jev-core'
import type { JevAnswers } from './jev-core'
import { COLORS } from './render/theme'

// C4b: the Jev wiring in hooks/register.tsx, driven through the engine with
// `$.env.get` (mock.env, or a hook that counts reads) and `$.http.fetch`
// (a hook of the test's) answered beneath the plugin, on a mocked clock.
// C4c: the ring emptied when an activation turns Jev on, its writes seen
// through a `state.set` hook beneath the plugin.
// C4d: a tick that comes before session.start synced the stored flag (the
// reload race) leaves the key and the network alone.
// C4e: session.start empties the ring before it syncs the flag (its write
// held by a `state.set` hook), and a tick asks for the ring only once its
// read of the flag has answered (that read held by a `state.get` hook).

const T0 = 1_790_928_100_000

/** When a call was claimed on the clock the pane is drawn on (`Date.now()`), apart from the policy clock's T0 (C7c). */
const SINCE = T0 + 456

const MINUTE = 60_000

const HOUR = 3_600_000

/** Not a real key: what `$.env.get('TYPESAFE_API_KEY')` answers in these tests. */
const KEY = 'fake-key-for-tests-0123456789'

/** The answer of the C0 probe (docs/spike-report.md, "P2 Jev"), as TypeSafe sent it. */
const PROBE_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    looping: { type: 'noul', noul: 0.41 },
    stuck: { type: 'noul', noul: 0.29 },
    fanout_wide: { type: 'noul', noul: 0.09 },
    near_done: { type: 'noul', noul: 0.18 },
    health: { type: 'score', score: 0.91, confidence: 0.85, probabilities: { '0': 0.09, '1': 0.91, '2': 0.0 } },
  },
  usage: { input_tokens: 1030, output_tokens: 87 },
}

/** The debug line of an answer to PROBE_RESPONSE, for a summary built from `events` ring events. */
const answerLine = (events: number): RegExp =>
  new RegExp(
    `^jev answer at \\S+ events ${events} model jev-1\\.13\\.0 in 1030 out 87 looping 0\\.41 stuck 0\\.29 fanout_wide 0\\.09 near_done 0\\.18 health 0\\.91 confidence 0\\.85$`,
  )

/** What the person typed and what the tools touched: none of it may reach Jev. */
const SECRET_PATH = 'D:\\secret-plan\\notes.md'
const SECRET_PROMPT = 'read my secret plan and fix it'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = { plugin: 'agent-tree', component: 'Pane', requestId: 'agent-tree' } as const

const PROPS = {
  title: 'Agent Tree',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

/** Jev on, the slowest refresh (fewer timer ticks to advance through), the pane left closed. */
const JEV_ON = { jevEnabled: true, autoOpen: false, refreshMs: 10_000 } as const

type FetchCall = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

type HttpAnswer =
  | { value: { status: number; ok: boolean; headers: Record<string, string>; text: string } }
  | { deny: string }

const answered = (status: number, text: string): HttpAnswer => ({ value: { status, ok: status >= 200 && status < 300, headers: {}, text } })

const PROBE_ANSWER = answered(200, JSON.stringify(PROBE_RESPONSE))

/**
 * The world beneath the plugin: the session's own answers, every `$.http.fetch`
 * (answered by `http`, at once or once its promise settles) and every
 * `$.ui.log` line the plugin sent. A Bash call ends in an error; every other
 * tool answers.
 */
function world(on: On, http: (call: FetchCall) => HttpAnswer | Promise<HttpAnswer> = () => PROBE_ANSWER) {
  const fetches: FetchCall[] = []
  const logs: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', ($, e) =>
    e.tool === 'Bash' ? { isError: true, result: 'exit 1', text: 'exit 1' } : { result: undefined as never, text: 'ok' },
  )
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('http.fetch', ($, e) => {
    fetches.push(e)

    return http(e)
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)

    return { value: undefined }
  })

  return { fetches, logs }
}

const startSession = ($: Engine) => $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

/** A tool call of the main loop; its input carries a path, as real calls do. */
function toolCall($: Engine, tool: 'Read' | 'Bash') {
  return tool === 'Read'
    ? $.tool.call({ tool: 'Read', file_path: SECRET_PATH })
    : $.tool.call({ tool: 'Bash', command: `type ${SECRET_PATH}` })
}

const turnEnd = (agentId?: string) => ({
  answer: 'the secret plan is done',
  durationMs: 1000,
  isAborted: false,
  turnId: agentId === undefined ? 't-main' : `t-${agentId}`,
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

/** One turn of the main loop: a prompt, its tool calls, the turn's end (which asks Jev when due). */
async function mainTurn($: Engine, tools: readonly ('Read' | 'Bash')[] = ['Read']): Promise<void> {
  await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })

  for (const tool of tools) {
    await toolCall($, tool)
  }

  await $.turn.complete(turnEnd())
}

/**
 * Every write of the Jev ring that landed, in order, seen from beneath the
 * plugin (the test `$` has no `state` noun to read it with): the last one is
 * the ring as it stands.
 */
function ringWrites(on: On): JevEvent[][] {
  const writes: JevEvent[][] = []

  on('state.set', { plugin: 'agent-tree', key: 'jevEvents' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push([...e.value])
    }

    return written
  })

  return writes
}

/** Every write of the `jev` value that landed, in order, seen from beneath the plugin (C7c). */
function jevWrites(on: On): JevSnapshot[] {
  const writes: JevSnapshot[] = []

  on('state.set', { plugin: 'agent-tree', key: 'jev' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push(e.value as JevSnapshot)
    }

    return written
  })

  return writes
}

/** The ring as tools and kinds, `['prompt', 'Read', 'turn']`. */
const shapeOf = (ring: readonly JevEvent[] | undefined): string[] | undefined => ring?.map(event => event.tool ?? event.kind)

/** One Text of the Jev box as mounted (C7c): what it shows and how. */
type JevBoxPart = { text: string; bold: boolean; inverse: boolean }

/** The Jev box's lines as mounted (C7c): each child of the box a Text, or a row of Texts side by side. */
function jevBoxLines(box: unknown): JevBoxPart[][] {
  type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const partOf = (node: Node): JevBoxPart => ({
    text: (node.children ?? []).filter((child): child is string => typeof child === 'string').join(''),
    bold: node.props?.bold === true,
    inverse: node.props?.inverse === true,
  })

  return ((box as Node | undefined)?.children ?? []).flatMap(child => {
    const node = child as Node

    if (node.type === 'Text') {
      return [[partOf(node)]]
    }

    return node.type === 'Box' ? [(node.children ?? []).map(part => partOf(part as Node))] : []
  })
}

/** The lines the pane draws on the terminal. */
async function paneLines($: Engine): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
  const lines = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  await ui.unmount()

  return lines
}

describe('Jev wiring: the attempt and answer helpers', () => {
  test('startCall: lastAt moves to now; now joins the call times of the last hour; the call is in flight from since', () => {
    const before: JevSnapshot = { ...EMPTY_JEV, enabled: true, calls: 3, lastAt: T0 - MINUTE, callTimes: [T0 - HOUR - 1, T0 - HOUR, T0 - MINUTE] }

    expect(startCall(before, T0, SINCE)).toStrictEqual({
      ...before,
      lastAt: T0,
      callTimes: [T0 - MINUTE, T0],
      inFlight: true,
      inFlightSince: SINCE,
    })
    expect(startCall({ ...EMPTY_JEV, enabled: true }, T0, SINCE)).toStrictEqual({
      enabled: true,
      calls: 0,
      flags: [],
      inFlight: true,
      lastAt: T0,
      callTimes: [T0],
      inFlightSince: SINCE,
    })
  })

  test('an answer and a failure keep the call times', () => {
    const started = startCall({ ...EMPTY_JEV, enabled: true }, T0, SINCE)
    const parsed = parseAnswers(PROBE_RESPONSE) as JevAnswers

    expect(applyAnswers(started, parsed, T0).callTimes).toEqual([T0])
    expect(applyError(started, 'HTTP 500 server error', T0).callTimes).toEqual([T0])
  })

  test('the call in flight (C7c): an answer or a failure carries the flag; endCall clears only the claim of its own since', () => {
    const started = startCall({ ...EMPTY_JEV, enabled: true }, T0, SINCE)
    const parsed = parseAnswers(PROBE_RESPONSE) as JevAnswers

    expect(EMPTY_JEV).toStrictEqual({ enabled: false, calls: 0, flags: [], inFlight: false })

    for (const change of [applyAnswers(started, parsed, T0 + 900), applyError(started, 'HTTP 503 server error', T0 + 900)]) {
      expect(change).toMatchObject({ inFlight: true, inFlightSince: SINCE })

      const ended = endCall(change, SINCE)

      expect(ended).toStrictEqual(Object.fromEntries(Object.entries({ ...change, inFlight: false }).filter(([key]) => key !== 'inFlightSince')))
      expect(ended).not.toHaveProperty('inFlightSince')
      // Another claim's end (an older call, or the environment before a reload): the very snapshot.
      expect(endCall(change, SINCE - 1)).toBe(change)
    }

    // Nothing in flight: the very snapshot.
    const idle = applyAnswers({ ...EMPTY_JEV, enabled: true }, parsed, T0)

    expect(idle.inFlight).toBe(false)
    expect(endCall(idle, SINCE)).toBe(idle)
  })

  test('clearJevInFlight: drops the flag and its start, keeps the rest; nothing set, the very snapshot', () => {
    const started = startCall({ ...EMPTY_JEV, enabled: true, calls: 2 }, T0, SINCE)

    expect(clearJevInFlight(started)).toStrictEqual({ enabled: true, calls: 2, flags: [], inFlight: false, lastAt: T0, callTimes: [T0] })
    expect(clearJevInFlight(EMPTY_JEV)).toBe(EMPTY_JEV)

    const answered = applyAnswers({ ...EMPTY_JEV, enabled: true }, parseAnswers(PROBE_RESPONSE) as JevAnswers, T0)

    expect(clearJevInFlight(answered)).toBe(answered)
    // A start left without its flag (hand-written state) is cleared too.
    expect(clearJevInFlight({ ...EMPTY_JEV, inFlightSince: SINCE })).toStrictEqual(EMPTY_JEV)
  })

  test('withoutSecret masks every copy of the key and any bearer token', () => {
    const raw = `fetch failed: ${KEY} rejected; Authorization: Bearer ${KEY}; again ${KEY}; Bearer other-token`

    const masked = withoutSecret(raw, KEY)

    expect(masked).not.toContain(KEY)
    expect(masked).not.toMatch(/Bearer (?!\*\*\*)/)
    // The bearer mask takes the whole token, up to the next space.
    expect(masked).toBe('fetch failed: *** rejected; Authorization: Bearer *** again ***; Bearer ***')
    expect(withoutSecret('no key here', '')).toBe('no key here')
  })
})

describe('Jev wiring in a session', () => {
  test('Jev off: no env read, no fetch, however many turns and ticks; the pane says Jev off', {
    options: { autoOpen: false, refreshMs: 10_000 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const envReads: string[] = []
    const { fetches } = world(on)

    on('env.get', ($, e) => {
      envReads.push(e.name)

      return { value: KEY }
    })

    await startSession($)
    await mainTurn($, ['Read', 'Bash'])
    await clock.settle()
    await clock.advance(10 * MINUTE)
    await mainTurn($)
    await clock.settle()

    expect(envReads).toEqual([])
    expect(fetches).toEqual([])

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })

      expect(await ui.find({ type: 'Text', text: 'Jev off — enable in /plugin configure agent-tree@agent-tree' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Jev on, a key, new events: one POST to Jev when the main turn ends, the key in its header, flags in the pane', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on)

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)

    // A subagent's turn ending asks nothing; the main loop's does.
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await toolCall($, 'Read')
    await toolCall($, 'Bash')
    await $.turn.complete(turnEnd('a1'))
    await clock.settle()
    expect(fetches).toEqual([])

    await $.turn.complete(turnEnd())
    await clock.settle()

    expect(fetches).toHaveLength(1)

    const [call] = fetches

    expect(call?.url).toBe(JEV_ENDPOINT)
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers).toStrictEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json; charset=utf-8',
    })

    const text = call?.init?.body ?? ''
    const body = JSON.parse(text)

    expect(Object.keys(body)).toEqual(['model', 'state', 'questions'])
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions)).toEqual(['looping', 'stuck', 'fanout_wide', 'near_done', 'health'])
    expect(body.state.recentTools).toStrictEqual([
      { agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false },
      { agent: 'main', tool: 'Bash', isError: true, repeatsPrevious: false },
    ])
    expect(body.state.consecutiveErrors).toBe(1)
    expect(body.state.minutesSinceLastUserPrompt).toBe(0)

    // Privacy: no key, no path, no prompt, no answer text in what was sent.
    for (const fragment of [KEY, 'secret', 'notes.md', 'D:', 'type ']) {
      expect(text, `the body carries ${fragment}`).not.toContain(fragment)
    }

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })

      // C7c (PRD M-L6): the title and the activity, then the calls and the last call's time.
      expect(await ui.find({ type: 'Text', text: 'JEV · advisory' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^calls 1 · last \d{2}:\d{2}:\d{2}$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^looping +█+░+ 0\.41 split$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^fan-out wide +█*░+ 0\.09 sharp$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'health 0.9 needs attention' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^JEV error/ })).toBeUndefined()
      await ui.unmount()
    }

    // The debug log: the answer's figures and the 5 events summarized (the
    // prompt, two tool calls, two turn ends), never the key or a bearer token.
    expect(logs.filter(line => answerLine(5).test(line))).toHaveLength(1)

    for (const line of logs) {
      expect(line).not.toContain(KEY)
      expect(line).not.toContain('Bearer')
    }
  })

  test('HTTP 401: JEV error: HTTP 401 key rejected, never the body; the next due call clears it', {
    options: { ...JEV_ON, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const refusal = '{"error":"invalid key","detail":"sk-leaked-detail"}'
    const { fetches, logs } = world(on, () => (fetches.length === 1 ? answered(401, refusal) : PROBE_ANSWER))

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()

    expect(fetches).toHaveLength(1)

    const failed = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    expect(await failed.find({ type: 'Text', text: 'JEV error: HTTP 401 key rejected' })).toBeDefined()
    expect(await failed.find({ type: 'Text', text: /sk-leaked-detail|invalid key/ })).toBeUndefined()
    await failed.unmount()

    expect(logs).toContain('agent-tree: jev turn failed: HTTP 401 key rejected')
    expect(logs.some(line => line.includes('sk-leaked-detail'))).toBe(false)

    // Past the interval, with new events: asked again; the answer replaces the error.
    await clock.advance(16_000)
    await mainTurn($)
    await clock.settle()

    expect(fetches).toHaveLength(2)

    const recovered = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    expect(await recovered.find({ type: 'Text', text: /^JEV error/ })).toBeUndefined()
    expect(await recovered.find({ type: 'Text', text: /^looping +█+░+ 0\.41 split$/ })).toBeDefined()
    await recovered.unmount()
  })

  test('a 200 that is not a Jev answer: JEV error: unreadable answer, never the body', { options: JEV_ON }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on, () => answered(200, '<html>captive portal sk-leaked-detail</html>'))

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()

    expect(fetches).toHaveLength(1)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    expect(await ui.find({ type: 'Text', text: 'JEV error: unreadable answer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /captive portal|sk-leaked-detail/ })).toBeUndefined()
    await ui.unmount()

    expect(logs).toContain('agent-tree: jev turn failed: unreadable answer')
  })

  test('no key: JEV error: TYPESAFE_API_KEY not set, no fetch; the error is written (and logged) once', {
    options: { ...JEV_ON, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on)
    const noKeyLines = () => logs.filter(line => line.endsWith(`failed: ${JEV_NO_KEY}`))

    mock.env(on, {})
    await startSession($)
    await mainTurn($)
    await clock.settle()

    expect(noKeyLines()).toEqual([`agent-tree: jev turn failed: ${JEV_NO_KEY}`])

    // More turns and timer ticks: still no fetch, and the error is not written again.
    await clock.advance(16_000)
    await mainTurn($)
    await clock.advance(MINUTE)

    expect(fetches).toEqual([])
    expect(noKeyLines()).toHaveLength(1)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })

      expect(await ui.find({ type: 'Text', text: 'JEV error: TYPESAFE_API_KEY not set' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('hourly cap: no call past jevMaxCallsPerHour, though the interval passed and events are new; the hour frees it', {
    options: { ...JEV_ON, jevIntervalSec: 15, jevMaxCallsPerHour: 1 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches } = world(on)
    const header = async (): Promise<string | undefined> => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
      const found = await ui.find({ type: 'Text', text: /^calls \d+ · last / })
      await ui.unmount()

      return found?.text
    }

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(1)

    // New events a second later; the timer comes 15 s after the call: due but for the cap.
    await clock.advance(1000)
    await mainTurn($)
    await clock.settle()
    await clock.advance(15_000)

    expect(fetches).toHaveLength(1)
    expect(await header()).toMatch(/^calls 1 · /)

    // An hour after the first call its time leaves the count: the next tick calls.
    // In two moves: an hour of the 250 ms frame timer (C7-0) is more waits
    // than the mock clock resolves in one move (10000).
    await clock.set(T0 + HOUR / 2)
    await clock.set(T0 + HOUR)

    expect(fetches).toHaveLength(2)
    expect(await header()).toMatch(/^calls 2 · /)
  })

  test('no new events since the last call: the timer asks nothing; events after the interval: asked again', {
    options: { ...JEV_ON, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches } = world(on)

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(1)

    await clock.advance(5 * MINUTE)
    expect(fetches).toHaveLength(1)

    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(2)

    // Within the interval of that call: a turn's end asks nothing; the timer does once it passed.
    await clock.advance(1000)
    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(2)

    await clock.advance(15_000)
    expect(fetches).toHaveLength(3)
  })

  test('two ticks under way at once: one claims the call, the other leaves it', { options: JEV_ON }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches } = world(on)

    // The key is held until both turns' ticks asked for it, then given to both
    // at once: each reads a due state before either has claimed the call.
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let asked = 0

    on('env.get', async () => {
      asked += 1
      await gate

      return { value: KEY }
    })
    await startSession($)
    await toolCall($, 'Read')

    const turns = Promise.all([$.turn.complete(turnEnd()), $.turn.complete(turnEnd())])

    await clock.settle()
    expect(asked).toBe(2)

    release()
    await turns
    await clock.settle()

    expect(fetches).toHaveLength(1)
  })

  test('a fetch that throws: JEV error: network error; the debug line masks the key', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on, () => ({ deny: `refused: Authorization: Bearer ${KEY} (${KEY})` }))

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()

    expect(fetches).toHaveLength(1)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    expect(await ui.find({ type: 'Text', text: 'JEV error: network error' })).toBeDefined()
    await ui.unmount()

    const failure = logs.find(line => line.startsWith('agent-tree: jev turn failed: network error'))

    expect(failure).toBeDefined()
    expect(failure).toContain('Bearer ***')

    for (const line of logs) {
      expect(line).not.toContain(KEY)
    }
  })

  test('with the Jev flags drawn, the latest subagents keep their boxes and a +k more box takes the last place; fewer rows keep the Jev header', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })

    world(on)
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
    await startSession($)

    // A task each: the subagent boxes are told apart by their description rows (C7c2: the type row reads the model first, then the type cut at 100 columns, the same in every box).
    for (let index = 0; index < 10; index += 1) {
      await $.agent.spawn({
        tool_use_id: `a${index}`,
        prompt: 'Look around.',
        description: `task ${index}`,
        subagentType: `Explore${index}`,
        provider: { plugin: 'engine', tier: 'core' },
        model: 'sonnet',
        parentModel: 'claude-opus-5-5',
        permissionMode: 'default',
        background: false,
        fork: false,
      })
    }

    await mainTurn($)
    await clock.settle()

    /** Each subagent box's description (its third row), or the text of the +k more box. */
    const boxesAt = async (surface: (typeof SURFACES)[number], bodyRows: number): Promise<unknown[]> => {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, scroll: { offset: 0, bodyRows } } })
      const texts = (await ui.findAll({ type: 'Box' }))
        .filter(box => box.props.borderColor === '#58a6ff')
        .map(box =>
          (box.children as { children?: unknown[] }[]).map(row => row.children?.[0]).filter(text => typeof text === 'string'),
        )
      const health = await ui.find({ type: 'Text', text: 'health 0.9 needs attention' })
      const header = await ui.find({ type: 'Text', text: 'JEV · advisory' })
      const advisor = await ui.find({ type: 'Text', text: 'advisor: no calls yet' })
      await ui.unmount()

      return [texts.map(rows => (rows.length === 1 ? rows[0] : rows[2])), health, header, advisor]
    }

    for (const surface of SURFACES) {
      // 30 body rows (C7a row budget): the Jev box draws its five lines (C7c:
      // the title and idle, the calls, two lines of two flags, the health);
      // three lines of subagent boxes.
      const [wide, health, header, advisor] = await boxesAt(surface, 30)

      expect(wide, surface).toEqual(['task 2', 'task 3', 'task 4', 'task 5', 'task 6', 'task 7', 'task 8', 'task 9', '+2 more'])
      expect(health, surface).toBeDefined()
      expect(header, surface).toBeDefined()
      expect(advisor, surface).toBeDefined()

      // 14 body rows: the main box, one line of subagent boxes and the status row first; the Jev box keeps its header.
      const [fitted, fittedHealth, fittedHeader] = await boxesAt(surface, 14)

      expect(fitted, surface).toEqual(['task 8', 'task 9', '+8 more'])
      expect(fittedHealth, surface).toBeUndefined()
      expect(fittedHeader, surface).toBeDefined()
    }
  })
})

describe('Jev turned on: the ring starts empty (C4c)', () => {
  test('a fresh state with Jev on: what the ring got before the activation is dropped; the first call summarizes what came after', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on)
    const rings = ringWrites(on)

    mock.env(on, { TYPESAFE_API_KEY: KEY })

    // Before session.start the `jev` value stands at its start, Jev not on:
    // a prompt, two failed Bash calls and a subagent's turn reach the ring.
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await toolCall($, 'Bash')
    await toolCall($, 'Bash')
    await $.turn.complete(turnEnd('a1'))
    expect(shapeOf(rings.at(-1))).toEqual(['prompt', 'Bash', 'Bash', 'turn'])

    await clock.advance(MINUTE)
    await startSession($)
    expect(rings.at(-1)).toEqual([])

    await mainTurn($, ['Read'])
    await clock.settle()

    expect(fetches).toHaveLength(1)
    expect(JSON.parse(fetches[0]?.init?.body ?? '').state.recentTools).toStrictEqual([
      { agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false },
    ])
    expect(logs.filter(line => answerLine(3).test(line))).toHaveLength(1)

    // The ring holds what came after the activation and nothing older.
    expect(shapeOf(rings.at(-1))).toEqual(['prompt', 'Read', 'turn'])
    expect(rings.at(-1)?.every(event => event.at >= T0 + MINUTE)).toBe(true)
  })

  test('Jev on, off, then on again: what the off time recorded never reaches Jev; lastAt and callTimes stay', {
    options: { ...JEV_ON, jevIntervalSec: 15, jevMaxCallsPerHour: 2 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on)
    const rings = ringWrites(on)
    let isTurningOff = false

    // The kit loads the plugin once, with these options, and nothing beneath
    // it answers config.set, so it cannot load it again with Jev off. Jev off
    // is modelled by what an activation with Jev off leaves: the `jev` value
    // stored with enabled false.
    on('state.set', { plugin: 'agent-tree', key: 'jev' }, ($, e, next) => {
      if (!isTurningOff) {
        return next(e)
      }

      isTurningOff = false

      return next({ ...e, value: { ...e.value, enabled: false } })
    })
    mock.env(on, { TYPESAFE_API_KEY: KEY })

    // On: one call at T0.
    await startSession($)
    await mainTurn($, ['Read'])
    await clock.settle()
    expect(fetches).toHaveLength(1)
    expect(logs.filter(line => answerLine(3).test(line))).toHaveLength(1)

    // Off: the pane says so; the ring goes on recording; no call.
    await clock.advance(1000)
    isTurningOff = true
    await startSession($)
    expect(await paneLines($)).toContain('Jev off — enable in /plugin configure agent-tree@agent-tree')

    await mainTurn($, ['Bash', 'Read'])
    await clock.settle()
    expect(fetches).toHaveLength(1)
    expect(shapeOf(rings.at(-1))).toEqual(['prompt', 'Read', 'turn', 'prompt', 'Bash', 'Read', 'turn'])

    // On again: the ring is emptied.
    await clock.advance(1000)
    await startSession($)
    expect(rings.at(-1)).toEqual([])

    // lastAt stayed: the interval from T0's call holds this turn's end, though the cap would allow a call.
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await $.turn.complete(turnEnd())
    await clock.settle()
    expect(fetches).toHaveLength(1)

    // Past the interval: the next call has no tool from before, as no tool ran since Jev came on.
    await clock.advance(15_000)
    expect(fetches).toHaveLength(2)

    const state = JSON.parse(fetches[1]?.init?.body ?? '').state

    expect(state.recentTools).toEqual([])
    expect(state.consecutiveErrors).toBe(0)
    expect(state.minutesSinceLastTool).toBeNull()
    expect(logs.filter(line => answerLine(2).test(line))).toHaveLength(1)

    // callTimes stayed: T0's call still counts, so with new events and the interval passed the cap of 2 holds.
    await clock.advance(1000)
    await mainTurn($, ['Read'])
    await clock.advance(30_000)
    expect(fetches).toHaveLength(2)
  })

  test('Jev on, activated again while on: the ring is kept and lastAt still holds the interval', {
    options: { ...JEV_ON, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on)
    const rings = ringWrites(on)

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($, ['Read'])
    await clock.settle()
    expect(fetches).toHaveLength(1)

    await clock.advance(1000)
    await mainTurn($, ['Bash'])
    await clock.settle()

    const writes = rings.length

    await startSession($)
    expect(rings).toHaveLength(writes)

    // A turn's end within the interval of T0's call asks nothing.
    await $.turn.complete(turnEnd())
    await clock.settle()
    expect(fetches).toHaveLength(1)

    // Past the interval: the call summarizes the ring as it stood, the Read before the activation included.
    await clock.advance(15_000)
    expect(fetches).toHaveLength(2)
    expect(JSON.parse(fetches[1]?.init?.body ?? '').state.recentTools).toStrictEqual([
      { agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false },
      { agent: 'main', tool: 'Bash', isError: true, repeatsPrevious: false },
    ])
    expect(logs.filter(line => answerLine(7).test(line))).toHaveLength(1)
  })
})

describe('Jev turned on by a reload: tick waits for the stored flag (C4d)', () => {
  test('timer ticks and a main turn end before session.start synced the flag: no env read, no fetch; once synced, the next due tick asks about what came since', {
    options: { ...JEV_ON, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on)
    const rings = ringWrites(on)
    const envReads: string[] = []
    let isTurningOff = false

    // A module reloaded with Jev on whose session.start has not run yet finds
    // `jev` as the activation with Jev off left it, enabled false, while its
    // options say on. Modelled as in the C4c on-off-on test: one activation's
    // write of `jev` is stored with enabled false. That activation also starts
    // the Jev timer, as the options are on.
    on('state.set', { plugin: 'agent-tree', key: 'jev' }, ($, e, next) => {
      if (!isTurningOff) {
        return next(e)
      }

      isTurningOff = false

      return next({ ...e, value: { ...e.value, enabled: false } })
    })
    on('env.get', ($, e) => {
      envReads.push(e.name)

      return { value: KEY }
    })

    isTurningOff = true
    await startSession($)
    expect(await paneLines($)).toContain('Jev off — enable in /plugin configure agent-tree@agent-tree')

    // New events and no call yet: with a key, a call would be due.
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await toolCall($, 'Bash')
    await toolCall($, 'Read')

    // Four timer ticks, then a main-loop turn end: the key is not read, Jev is not asked.
    await clock.advance(MINUTE)
    expect(envReads).toEqual([])
    expect(fetches).toEqual([])

    await $.turn.complete(turnEnd())
    await clock.settle()
    expect(envReads).toEqual([])
    expect(fetches).toEqual([])
    expect(shapeOf(rings.at(-1))).toEqual(['prompt', 'Bash', 'Read', 'turn'])

    // The reload's session.start: the flag syncs to on and the ring is emptied.
    await startSession($)
    expect(rings.at(-1)).toEqual([])

    // The next due tick reads the key once and asks about the events since.
    await mainTurn($, ['Read'])
    await clock.settle()

    expect(envReads).toEqual(['TYPESAFE_API_KEY'])
    expect(fetches).toHaveLength(1)
    expect(JSON.parse(fetches[0]?.init?.body ?? '').state.recentTools).toStrictEqual([
      { agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false },
    ])
    expect(logs.filter(line => answerLine(3).test(line))).toHaveLength(1)
  })
})

describe('Jev turned on by a reload: the ring is emptied before the flag syncs, and read after it (C4e)', () => {
  test('timer ticks and a main turn end while session.start empties the ring: the flag is still off, so no env read, no fetch; once it synced, the next due tick asks only about what came after', {
    options: { ...JEV_ON, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches, logs } = world(on)
    const rings = ringWrites(on)
    const envReads: string[] = []
    let isTurningOff = false
    let isHoldingClear = false
    let heldClears = 0
    let releaseClear = (): void => undefined
    const clearGate = new Promise<void>(resolve => {
      releaseClear = resolve
    })

    // The state a reload with Jev on finds, as in the C4d test: one
    // activation's write of `jev` is stored with enabled false.
    on('state.set', { plugin: 'agent-tree', key: 'jev' }, ($, e, next) => {
      if (!isTurningOff) {
        return next(e)
      }

      isTurningOff = false

      return next({ ...e, value: { ...e.value, enabled: false } })
    })
    // The activation's write that empties the ring is held until the test
    // lets it go; the plugin's other writes and hooks go on meanwhile.
    on('state.set', { plugin: 'agent-tree', key: 'jevEvents' }, async ($, e, next) => {
      if (isHoldingClear && e.value.length === 0) {
        isHoldingClear = false
        heldClears += 1
        await clearGate
      }

      return next(e)
    })
    on('env.get', ($, e) => {
      envReads.push(e.name)

      return { value: KEY }
    })

    isTurningOff = true
    await startSession($)
    expect(await paneLines($)).toContain('Jev off — enable in /plugin configure agent-tree@agent-tree')

    // Recorded while Jev was off: a prompt, a failed Bash, a Read.
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await toolCall($, 'Bash')
    await toolCall($, 'Read')

    // The reload's session.start, held at its write that empties the ring.
    isHoldingClear = true
    const activation = startSession($)
    await clock.settle()
    expect(heldClears).toBe(1)

    // Meanwhile four timer ticks, then a main-loop turn end: the flag is still off.
    await clock.advance(MINUTE)
    await $.turn.complete(turnEnd())
    await clock.settle()
    expect(envReads).toEqual([])
    expect(fetches).toEqual([])
    expect(await paneLines($)).toContain('Jev off — enable in /plugin configure agent-tree@agent-tree')

    // The clear lands, then the flag syncs to on.
    releaseClear()
    await activation
    expect(rings.at(-1)).toEqual([])
    expect(await paneLines($)).not.toContain('Jev off — enable in /plugin configure agent-tree@agent-tree')

    // The next due tick reads the key once and asks about what came after the activation.
    await mainTurn($, ['Read'])
    await clock.settle()

    expect(envReads).toEqual(['TYPESAFE_API_KEY'])
    expect(fetches).toHaveLength(1)
    expect(JSON.parse(fetches[0]?.init?.body ?? '').state.recentTools).toStrictEqual([
      { agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false },
    ])
    expect(logs.filter(line => answerLine(3).test(line))).toHaveLength(1)
  })

  test('a tick asks for the ring only once its read of the flag has answered: the ring it summarizes is never older than the flag it found on', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches } = world(on)
    let isHoldingFlagRead = false
    let isFlagReadHeld = false
    let ringReadsWhileHeld = 0
    let releaseFlagRead = (): void => undefined
    const flagReadGate = new Promise<void>(resolve => {
      releaseFlagRead = resolve
    })

    // The tick's read of the flag is answered only when the test lets it go.
    // The kit fixes what a read answers when it is raised, so the hold delays
    // when the tick hears the answer; a read of the ring raised meanwhile is
    // counted.
    on('state.get', { plugin: 'agent-tree', key: 'jev' }, async ($, e, next) => {
      if (isHoldingFlagRead) {
        isHoldingFlagRead = false
        isFlagReadHeld = true
        await flagReadGate
        isFlagReadHeld = false
      }

      return next(e)
    })
    on('state.get', { plugin: 'agent-tree', key: 'jevEvents' }, ($, e, next) => {
      if (isFlagReadHeld) {
        ringReadsWhileHeld += 1
      }

      return next(e)
    })
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await toolCall($, 'Bash')
    await toolCall($, 'Read')

    // A main-loop turn end: its tick asks for the flag, and the answer is held.
    isHoldingFlagRead = true
    const turned = $.turn.complete(turnEnd())
    await clock.settle()
    expect(isFlagReadHeld).toBe(true)
    expect(ringReadsWhileHeld).toBe(0)

    // The flag answers on: then the tick reads the ring and asks Jev about it.
    releaseFlagRead()
    await turned
    await clock.settle()

    expect(fetches).toHaveLength(1)
    expect(JSON.parse(fetches[0]?.init?.body ?? '').state.recentTools).toStrictEqual([
      { agent: 'main', tool: 'Bash', isError: true, repeatsPrevious: false },
      { agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false },
    ])
  })
})

describe("Jev's call in flight (C7c)", () => {
  test('the write that claims a call sets the flag before the fetch; the write of its answer clears it; no other write between', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const jevs = jevWrites(on)
    let atFetch: JevSnapshot[] = []
    const { fetches } = world(on, () => {
      atFetch = [...jevs]

      return PROBE_ANSWER
    })

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    expect(jevs.every(value => value.inFlight === false)).toBe(true)

    const synced = jevs.length

    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(1)

    // The claim: one write before the fetch, the flag on, timed on the clock the pane is drawn on.
    expect(atFetch.slice(synced)).toHaveLength(1)
    expect(atFetch.at(-1)).toMatchObject({ inFlight: true, lastAt: T0, callTimes: [T0], calls: 0 })
    expect(atFetch.at(-1)?.inFlightSince).toEqual(expect.any(Number))

    // The answer: one more write, the flags in and the flag off.
    expect(jevs.slice(synced)).toHaveLength(2)
    expect(jevs.at(-1)).toMatchObject({ inFlight: false, calls: 1, health: 0.91 })
    expect(jevs.at(-1)).not.toHaveProperty('inFlightSince')
  })

  test('a failed call, HTTP 503 or a fetch that throws: the write of its failure clears the flag', {
    options: { ...JEV_ON, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const jevs = jevWrites(on)
    const { fetches } = world(on, () => (fetches.length === 1 ? answered(503, 'unavailable') : { deny: 'refused by the test' }))

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()

    expect(fetches).toHaveLength(1)
    expect(jevs.at(-2)).toMatchObject({ inFlight: true })
    expect(jevs.at(-1)).toMatchObject({ inFlight: false, error: 'HTTP 503 server error' })
    expect(jevs.at(-1)).not.toHaveProperty('inFlightSince')

    // Past the interval, with new events: the fetch throws.
    await clock.advance(16_000)
    await mainTurn($)
    await clock.settle()

    expect(fetches).toHaveLength(2)
    expect(jevs.at(-2)).toMatchObject({ inFlight: true })
    expect(jevs.at(-1)).toMatchObject({ inFlight: false, error: 'network error' })
    expect(jevs.at(-1)).not.toHaveProperty('inFlightSince')
  })

  test('a reload while a call is out: session.start clears the flag in one more write; activated with nothing in flight it adds none; the late answer leaves it off', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const jevs = jevWrites(on)
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { fetches } = world(on, async () => {
      await gate

      return PROBE_ANSWER
    })

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(1)
    expect(jevs.at(-1)).toMatchObject({ inFlight: true })

    // The reload's session.start: the flag sync (C4e writes it on every
    // activation), then the clear.
    const claimed = jevs.length

    await startSession($)
    expect(jevs.length - claimed).toBe(2)
    expect(jevs.at(-1)).toMatchObject({ enabled: true, inFlight: false, calls: 0, lastAt: T0, callTimes: [T0] })
    expect(jevs.at(-1)).not.toHaveProperty('inFlightSince')

    // Activated again, nothing in flight: the flag sync alone.
    const cleared = jevs.length

    await startSession($)
    expect(jevs.length - cleared).toBe(1)

    // The answer that comes late is kept, and the flag stays off.
    release()
    await clock.settle()
    expect(jevs.at(-1)).toMatchObject({ inFlight: false, calls: 1, health: 0.91 })
    expect(jevs.at(-1)).not.toHaveProperty('inFlightSince')
  })

  test('mounted (PRD M-L6, M-L8): the call out lights the Jev box, bolds its title and draws `◐ calling now… 0s` in inverse beside it, the status row says `jev [calling · 0]` and the status entry ends `jev …`; answered, all dim and idle, and the flags two to a line with bars in the 57 columns of a 92-column pane', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const statuses: (string | undefined)[] = []
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { fetches } = world(on, async () => {
      await gate

      return PROBE_ANSWER
    })
    const look = async (surface: (typeof SURFACES)[number]) => {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, bodyColumns: 92, scroll: { offset: 0, bodyRows: 60 } } })
      const box = (await ui.findAll({ type: 'Box' })).find(found => found.props.borderColor === COLORS.jev)
      const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

      await ui.unmount()

      return { lines: jevBoxLines(box), isDim: box?.props.borderDimColor === true, status: texts.filter(text => text.startsWith('jev [')) }
    }

    on('ui.status', ($, e) => {
      statuses.push(e.text)

      return { value: undefined }
    })
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(1)
    // The claim's write pinned the status entry with the call out.
    expect(statuses.at(-1)).toMatch(/^agent-tree .* · jev …$/)

    for (const surface of SURFACES) {
      const { lines, isDim, status } = await look(surface)

      expect(isDim, surface).toBe(false)
      expect(lines[0], surface).toEqual([
        { text: 'JEV · advisory', bold: true, inverse: false },
        { text: expect.stringMatching(/^[◐◓◑◒] calling now… \d+s$/), bold: false, inverse: true },
      ])
      expect(lines.slice(1).flat().some(part => part.bold || part.inverse), surface).toBe(false)
      expect(status, surface).toEqual(['jev [calling · 0]'])
    }

    // The answer comes: the write that clears the flag pins the entry without the call.
    release()
    await clock.settle()
    expect(statuses.at(-1)).toMatch(/^agent-tree /)
    expect(statuses.at(-1)).not.toContain('jev …')

    for (const surface of SURFACES) {
      const { lines, isDim, status } = await look(surface)
      const shown = lines.map(parts => parts.map(part => part.text).join('  '))

      expect(isDim, surface).toBe(true)
      expect(shown, surface).toEqual([
        'JEV · advisory  idle',
        expect.stringMatching(/^calls 1 · last \d{2}:\d{2}:\d{2}$/),
        'looping      ██░░░ 0.41 split  stuck     █░░░░ 0.29 split',
        'fan-out wide ░░░░░ 0.09 sharp  near done █░░░░ 0.18 sharp',
        'health 0.9 needs attention',
      ])
      expect(shown.every(line => line.length <= 57), surface).toBe(true)
      expect(lines.flat().some(part => part.bold || part.inverse), surface).toBe(false)
      expect(status, surface).toEqual(['jev [idle · 1]'])
    }
  })
})

describe("Jev's call in flight: the close-out on a throw, and the status entry (C7c2)", () => {
  /** The `jev turn failed` debug lines the tick's catch wrote for a read the test refused. */
  const refusals = (logs: readonly string[]): string[] =>
    logs.filter(line => /^agent-tree: jev turn failed: .*refused by the test$/.test(line))

  test("a throw after the claim (probe F3: the tree read refused): the catch clears the flag in one more write; no POST, and the claim's lastAt and call time stand", {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const jevs = jevWrites(on)
    const { fetches, logs } = world(on)
    let isRefusingTree = false

    // Once the claim's write landed, every read of the tree is refused.
    on('state.set', { plugin: 'agent-tree', key: 'jev' }, async ($, e, next) => {
      const written = await next(e)

      if (written.value?.isSet === true && (e.value as JevSnapshot).inFlight === true) {
        isRefusingTree = true
      }

      return written
    })
    on('state.get', { plugin: 'agent-tree', key: 'tree' }, ($, e, next) => (isRefusingTree ? { deny: 'refused by the test' } : next(e)))
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)

    const synced = jevs.length

    await mainTurn($)
    await clock.settle()

    expect(isRefusingTree).toBe(true)
    expect(fetches).toEqual([])

    // The claim, then the catch's clear: two writes, the second the first with its flag off.
    expect(jevs.slice(synced)).toHaveLength(2)
    expect(jevs.at(-2)).toMatchObject({ inFlight: true, lastAt: T0, callTimes: [T0], calls: 0 })
    expect(jevs.at(-1)).toMatchObject({ inFlight: false, lastAt: T0, callTimes: [T0], calls: 0 })
    expect(jevs.at(-1)).not.toHaveProperty('inFlightSince')
    expect(refusals(logs)).toHaveLength(1)
  })

  test("a throw after the claim, with a flag that is not its own standing: the catch leaves it, as each call clears the claim of its own since only", {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const jevs = jevWrites(on)
    const { fetches, logs } = world(on)
    let isRefusingTree = false

    // The claim's write lands with a start one millisecond past the tick's own: another claim's flag stands.
    on('state.set', { plugin: 'agent-tree', key: 'jev' }, async ($, e, next) => {
      const value = e.value as JevSnapshot

      if (value.inFlight !== true) {
        return next(e)
      }

      const written = await next({ ...e, value: { ...value, inFlightSince: (value.inFlightSince ?? 0) + 1 } })
      isRefusingTree = true

      return written
    })
    on('state.get', { plugin: 'agent-tree', key: 'tree' }, ($, e, next) => (isRefusingTree ? { deny: 'refused by the test' } : next(e)))
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)

    const synced = jevs.length

    await mainTurn($)
    await clock.settle()

    expect(isRefusingTree).toBe(true)
    expect(fetches).toEqual([])
    expect(refusals(logs)).toHaveLength(1)

    // The claim's write alone: the catch found a flag that is not its own and wrote nothing.
    expect(jevs.slice(synced)).toHaveLength(1)
    expect(jevs.at(-1)).toMatchObject({ inFlight: true })
  })

  test('a throw before the claim has no flag to clear: nothing is written to jev, and no POST is made', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const jevs = jevWrites(on)
    const { fetches, logs } = world(on)
    let isRefusingRing = false

    // After the activation synced the flag, every read of the ring is refused: the tick throws before it claims.
    on('state.get', { plugin: 'agent-tree', key: 'jevEvents' }, ($, e, next) => (isRefusingRing ? { deny: 'refused by the test' } : next(e)))
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)

    const synced = jevs.length

    isRefusingRing = true
    await mainTurn($)
    await clock.settle()

    expect(fetches).toEqual([])
    expect(jevs).toHaveLength(synced)
    expect(refusals(logs)).toHaveLength(1)
  })

  test('the refresh pins the status entry as tick does (m22): a refresh with the call still out pins it ending ` · jev …`; once the call is answered, a refresh pins it without', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const statuses: (string | undefined)[] = []
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { fetches } = world(on, async () => {
      await gate

      return PROBE_ANSWER
    })

    // A bound session: with no answer to its reads, a refresh returns before it pins anything.
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('ui.status', ($, e) => {
      statuses.push(e.text)

      return { value: undefined }
    })
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()
    expect(fetches).toHaveLength(1)
    expect(statuses.at(-1)).toMatch(/^agent-tree .* · jev …$/)

    // One refreshMs with the fetch still held: the refresh pins the entry, and the call is still out.
    const pinned = statuses.length

    await clock.advance(10_000)
    expect(statuses.length).toBeGreaterThan(pinned)
    expect(statuses.at(-1)).toMatch(/^agent-tree .* · jev …$/)
    expect(fetches).toHaveLength(1)

    // The answer: the write that clears the flag pins the entry without the call, and the next refresh does the same.
    release()
    await clock.settle()
    expect(statuses.at(-1)).toMatch(/^agent-tree /)
    expect(statuses.at(-1)).not.toContain('jev …')

    const answered = statuses.length

    await clock.advance(10_000)
    expect(statuses.length).toBeGreaterThan(answered)
    expect(statuses.at(-1)).toMatch(/^agent-tree /)
    expect(statuses.at(-1)).not.toContain('jev …')
  })
})

describe('the summary sent through the plugin counts external workers apart (C7c)', () => {
  test('an engine run of the main loop: the POST counts it in agents and in externalWorkers, two numbers; nothing of its command, model or task is sent', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const { fetches } = world(on)
    const command = `kimi -m kimi-code/k3 -p "fix ${SECRET_PATH} now"`

    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command, description: `Kimi fixes ${SECRET_PATH}` } as never)
    await $.turn.complete(turnEnd())
    await clock.settle()

    expect(fetches).toHaveLength(1)

    const text = fetches[0]?.init?.body ?? ''
    const state = JSON.parse(text).state

    // The world fails every Bash call, so the run failed: counted, none running.
    expect(state.agents).toEqual({ total: 1, running: 0, failed: 1, maxDepth: 1 })
    expect(Object.entries(state.externalWorkers)).toEqual([
      ['total', 1],
      ['running', 0],
    ])

    for (const fragment of [KEY, 'kimi-code', 'k3', 'secret', 'notes.md', 'Kimi', 'toolu_k1', 'ext:', 'D:']) {
      expect(text, `the body carries ${fragment}`).not.toContain(fragment)
    }
  })
})
