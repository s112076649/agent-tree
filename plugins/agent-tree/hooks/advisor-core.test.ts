import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AdvisorSnapshot } from '../types'
import {
  EMPTY_ADVISOR,
  MAX_RECENT_CALLS,
  READ_FAILED,
  TOO_LARGE,
  TRANSCRIPT_DELAY_MS,
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_RETRY_MS,
  applyAppend,
  applyReadError,
  applyTooLarge,
  applyTranscript,
  clearAdvisorInFlight,
  countAdvisorBlocks,
  isAdvisorRow,
  isTooLargeToRead,
  isTranscriptBehind,
  isTranscriptReadDue,
  parseTranscript,
} from './advisor-core'
import { clockTime } from './render/sections/advisor'
import { widthOf } from './render/text'

const T0 = 1_790_928_082_000

/** The advisor blocks of C0 run A; the advice is encrypted by the API (cut short here). */
const CALL = { type: 'server_tool_use', id: 'srvtoolu_01', name: 'advisor', input: {} }
const RESULT = {
  type: 'advisor_tool_result',
  tool_use_id: 'srvtoolu_01',
  content: { type: 'advisor_redacted_result', encrypted_content: 'Et8KCioIFBgC' },
}
const CALL_2 = { ...CALL, id: 'srvtoolu_02' }
const RESULT_2 = { ...RESULT, tool_use_id: 'srvtoolu_02' }
const TEXT = { type: 'text', text: 'Adding a nullable column is safer.' }

/** The usage every row of C0 run A's advisor response repeats: two executor iterations around the advisor's. */
const ADVISOR_USAGE = {
  input_tokens: 4,
  output_tokens: 206,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  iterations: [
    { input_tokens: 2, output_tokens: 26, cache_read_input_tokens: 15_997, cache_creation_input_tokens: 44_581, type: 'message' },
    {
      input_tokens: 62_064,
      output_tokens: 969,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      type: 'advisor_message',
      model: 'claude-fable-5-1',
    },
    { input_tokens: 2, output_tokens: 180, cache_read_input_tokens: 60_578, cache_creation_input_tokens: 518, type: 'message' },
  ],
}

/**
 * One transcript row of an assistant response: one block, the response's
 * usage. The row-level `advisorModel` names the main model even in a session
 * without an advisor (C1's transcript), so it must not be read.
 */
function assistantRow(uuid: string, messageId: string, block: object, usage: object, isSidechain = false): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain,
    type: 'assistant',
    uuid,
    requestId: `req_${messageId}`,
    advisorModel: 'claude-opus-5-5',
    message: { id: messageId, role: 'assistant', model: 'claude-opus-5-5', content: [block], usage },
  })
}

/** C0 run A's main loop: a thinking response, then the advisor response split into three rows (one written twice). */
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', uuid: 'u0', message: { role: 'user', content: 'Which migration is safer?' } }),
  JSON.stringify({ type: 'attachment', uuid: 'a0', attachment: { type: 'advisor_tool' } }),
  assistantRow('r1', 'msg_A', { type: 'thinking', thinking: '' }, { iterations: [{ type: 'message', input_tokens: 2, output_tokens: 336 }] }),
  assistantRow('r2', 'msg_B', CALL, ADVISOR_USAGE),
  assistantRow('r3', 'msg_B', RESULT, ADVISOR_USAGE),
  assistantRow('r3', 'msg_B', RESULT, ADVISOR_USAGE),
  assistantRow('r4', 'msg_B', TEXT, ADVISOR_USAGE),
  '{"type":"assistant","message":',
  '',
].join('\n')

/** The same file at the stop, before the advisor response was written (C0: it lands within 250 ms). */
const EARLY = TRANSCRIPT.split('\n').slice(0, 3).join('\n')

/** A second advisor response after the first. */
const SECOND_CALL_USAGE = {
  iterations: [
    { type: 'message', input_tokens: 3, output_tokens: 20 },
    { type: 'advisor_message', input_tokens: 1000, output_tokens: 50, model: 'claude-fable-5-1' },
  ],
}

const TWO_CALLS = [
  TRANSCRIPT,
  assistantRow('r5', 'msg_C', CALL_2, SECOND_CALL_USAGE),
  assistantRow('r6', 'msg_C', RESULT_2, SECOND_CALL_USAGE),
].join('\n')

const NOTHING_FOUND = { iterations: 0, inputTokens: 0, outputTokens: 0, serverToolUses: 0, results: 0 }

/** A transcript path as `classic.Stop` carries it on Windows (C0 run A). */
const PATH = 'C:\\Users\\me\\.claude\\projects\\D--repo\\0f7c.jsonl'

/** One advisor call counted from the append rows, at T0, its result 21.08 s later. */
function oneCall(): AdvisorSnapshot {
  return applyAppend(applyAppend(EMPTY_ADVISOR, { content: [CALL] }, T0), { content: [RESULT] }, T0 + 21_080)
}

describe('append rows: counting advisor calls', () => {
  test('a server_tool_use named advisor starts a call; its advisor_tool_result ends it with the latency', () => {
    const started = applyAppend(EMPTY_ADVISOR, { content: [CALL] }, T0)

    expect(started).toEqual({
      calls: 1,
      lastCallStartedAt: T0,
      pendingCallId: 'srvtoolu_01',
      callIds: ['srvtoolu_01'],
      source: 'append',
      inFlight: true,
      inFlightSince: T0,
      recentCalls: [],
    })
    expect(oneCall()).toEqual({
      calls: 1,
      lastCallStartedAt: T0,
      lastCallAt: T0 + 21_080,
      lastLatencyMs: 21_080,
      callIds: ['srvtoolu_01'],
      source: 'append',
      inFlight: false,
      recentCalls: [{ at: T0 + 21_080, latencyMs: 21_080 }],
    })
    expect(countAdvisorBlocks([CALL, RESULT, TEXT, { type: 'server_tool_use', id: 'w1', name: 'web_search' }])).toEqual({
      serverToolUses: 1,
      results: 1,
    })
  })

  test('double-count guard: a block seen again, a row of several blocks, a response split into rows', () => {
    const counted = oneCall()

    expect(applyAppend(counted, { content: [CALL] }, T0 + 30_000)).toBe(counted)
    expect(applyAppend(counted, { content: [RESULT] }, T0 + 30_000)).toBe(counted)
    expect(applyAppend(EMPTY_ADVISOR, { content: [CALL, RESULT, TEXT] }, T0)).toMatchObject({
      calls: 1,
      lastCallAt: T0,
      lastLatencyMs: 0,
    })

    // As C0 saw it: one response, one row per block.
    let split = EMPTY_ADVISOR

    for (const block of [CALL, RESULT, TEXT]) {
      split = applyAppend(split, { content: [block] }, T0)
    }

    expect(split.calls).toBe(1)
    expect(applyAppend(applyAppend(split, { content: [CALL_2] }, T0 + 60_000), { content: [RESULT_2] }, T0 + 62_500)).toMatchObject({
      calls: 2,
      lastCallStartedAt: T0 + 60_000,
      lastCallAt: T0 + 62_500,
      lastLatencyMs: 2500,
      callIds: ['srvtoolu_01', 'srvtoolu_02'],
    })
  })

  test('subagent rows, other server tools and a client tool named advisor are not counted', () => {
    expect(applyAppend(EMPTY_ADVISOR, { agentId: 'a855975fcff9c0909', content: [CALL] }, T0)).toBe(EMPTY_ADVISOR)
    expect(applyAppend(EMPTY_ADVISOR, { content: [{ type: 'tool_use', id: 'toolu_1', name: 'advisor' }, TEXT] }, T0)).toBe(
      EMPTY_ADVISOR,
    )
    expect(applyAppend(EMPTY_ADVISOR, { content: 'text' }, T0)).toBe(EMPTY_ADVISOR)
    expect(isAdvisorRow({ agentId: 'a1', content: [CALL] })).toBe(false)
    expect(isAdvisorRow({ agentId: null, content: [CALL] })).toBe(true)
    expect(isAdvisorRow({ content: [TEXT] })).toBe(false)
    expect(isAdvisorRow({ content: [RESULT] })).toBe(true)
  })

  test('a result whose start was not seen counts its call once, with no latency', () => {
    const orphan = applyAppend(EMPTY_ADVISOR, { content: [RESULT] }, T0)

    expect(orphan).toEqual({
      calls: 1,
      lastCallAt: T0,
      callIds: ['srvtoolu_01'],
      source: 'append',
      inFlight: false,
      recentCalls: [{ at: T0 }],
    })
    expect(applyAppend(orphan, { content: [RESULT] }, T0 + 5)).toBe(orphan)
  })
})

describe('the calls in flight and the latest five (C7c, PRD M-L5)', () => {
  test('a call is in flight from its server_tool_use block, timed from it, to its result; a row of both leaves none in flight', () => {
    expect(EMPTY_ADVISOR).toMatchObject({ inFlight: false, recentCalls: [] })
    expect(EMPTY_ADVISOR).not.toHaveProperty('inFlightSince')
    expect(MAX_RECENT_CALLS).toBe(5)

    const started = applyAppend(EMPTY_ADVISOR, { content: [CALL] }, T0)

    expect(started).toMatchObject({ inFlight: true, inFlightSince: T0, recentCalls: [] })
    // The same block again: the very snapshot, still timed from the first.
    expect(applyAppend(started, { content: [CALL] }, T0 + 9000)).toBe(started)
    // A text row of the same response changes nothing.
    expect(applyAppend(started, { content: [TEXT] }, T0 + 9000)).toBe(started)

    const ended = oneCall()

    expect(ended.inFlight).toBe(false)
    expect(ended).not.toHaveProperty('inFlightSince')
    expect(applyAppend(EMPTY_ADVISOR, { content: [CALL, RESULT, TEXT] }, T0)).toMatchObject({
      inFlight: false,
      recentCalls: [{ at: T0, latencyMs: 0 }],
    })
  })

  test('recentCalls: each result joins at the end, with its latency; past five the oldest go', () => {
    let snapshot = EMPTY_ADVISOR

    for (let index = 1; index <= 7; index += 1) {
      const id = `srvtoolu_0${index}`
      const start = T0 + index * 60_000

      snapshot = applyAppend(snapshot, { content: [{ ...CALL, id }] }, start)
      expect(snapshot.inFlight).toBe(true)
      snapshot = applyAppend(snapshot, { content: [{ ...RESULT, tool_use_id: id }] }, start + index * 1000)
      expect(snapshot.inFlight).toBe(false)
    }

    expect(snapshot.calls).toBe(7)
    expect(snapshot.recentCalls).toEqual(
      [3, 4, 5, 6, 7].map(index => ({ at: T0 + index * 60_000 + index * 1000, latencyMs: index * 1000 })),
    )
  })

  test('a result whose start was not seen joins with no latency and leaves the flag as it was: another call may be out', () => {
    const orphan = applyAppend(EMPTY_ADVISOR, { content: [RESULT] }, T0)

    expect(orphan.recentCalls).toEqual([{ at: T0 }])
    expect(orphan.inFlight).toBe(false)

    // A second call out, then the result of a first one this plugin never saw start.
    const out = applyAppend(EMPTY_ADVISOR, { content: [CALL_2] }, T0)
    const late = applyAppend(out, { content: [{ ...RESULT, tool_use_id: 'srvtoolu_09' }] }, T0 + 2000)

    expect(late).toMatchObject({ calls: 2, inFlight: true, inFlightSince: T0, pendingCallId: 'srvtoolu_02', recentCalls: [{ at: T0 + 2000 }] })
    expect(applyAppend(late, { content: [RESULT_2] }, T0 + 3000)).toMatchObject({
      inFlight: false,
      recentCalls: [{ at: T0 + 2000 }, { at: T0 + 3000, latencyMs: 3000 }],
    })
  })

  test('the transcript and its failures never set or clear the flag', () => {
    const started = applyAppend(EMPTY_ADVISOR, { content: [CALL] }, T0)
    const found = parseTranscript(TRANSCRIPT)

    for (const read of [applyTranscript(started, found), applyTooLarge(started), applyReadError(started, READ_FAILED)]) {
      expect(read).toMatchObject({ inFlight: true, inFlightSince: T0, recentCalls: [] })
    }

    for (const read of [applyTranscript(EMPTY_ADVISOR, found), applyTooLarge(EMPTY_ADVISOR), applyReadError(EMPTY_ADVISOR, READ_FAILED)]) {
      expect(read.inFlight).toBe(false)
      expect(read).not.toHaveProperty('inFlightSince')
    }
  })

  test('clearAdvisorInFlight: drops the flag and its start, keeps the pending call (its result still counts its latency); nothing set, the very snapshot', () => {
    const started = applyAppend(EMPTY_ADVISOR, { content: [CALL] }, T0)
    const cleared = clearAdvisorInFlight(started)

    expect(cleared).toEqual({ ...started, inFlight: false, inFlightSince: undefined })
    expect(cleared).not.toHaveProperty('inFlightSince')
    expect(cleared.pendingCallId).toBe('srvtoolu_01')
    expect(applyAppend(cleared, { content: [RESULT] }, T0 + 4000)).toMatchObject({
      inFlight: false,
      recentCalls: [{ at: T0 + 4000, latencyMs: 4000 }],
    })

    expect(clearAdvisorInFlight(EMPTY_ADVISOR)).toBe(EMPTY_ADVISOR)
    expect(clearAdvisorInFlight(cleared)).toBe(cleared)
    expect(clearAdvisorInFlight(oneCall())).toEqual(oneCall())
    // A start left without its flag (hand-written state) is cleared too.
    expect(clearAdvisorInFlight({ ...EMPTY_ADVISOR, inFlightSince: T0 })).toEqual(EMPTY_ADVISOR)
  })
})

describe('the transcript: advisor model and tokens', () => {
  test('rows of one response repeat its usage: each message id counts once; blocks are the cross-check', () => {
    expect(parseTranscript(TRANSCRIPT)).toEqual({
      model: 'claude-fable-5-1',
      iterations: 1,
      inputTokens: 62_064,
      outputTokens: 969,
      serverToolUses: 1,
      results: 1,
    })
    expect(parseTranscript(TWO_CALLS)).toEqual({
      model: 'claude-fable-5-1',
      iterations: 2,
      inputTokens: 63_064,
      outputTokens: 1019,
      serverToolUses: 2,
      results: 2,
    })
  })

  test('a subagent (isSidechain) advisor response is left out, as the append rows leave it out', () => {
    const withSubagent = [
      TRANSCRIPT,
      assistantRow('s1', 'msg_S', CALL_2, SECOND_CALL_USAGE, true),
      assistantRow('s2', 'msg_S', RESULT_2, SECOND_CALL_USAGE, true),
    ].join('\n')

    expect(parseTranscript(withSubagent)).toEqual(parseTranscript(TRANSCRIPT))
  })

  test('no advisor, blank or broken lines, CRLF endings: nothing found', () => {
    const plain = [assistantRow('r1', 'msg_A', TEXT, { iterations: [{ type: 'message', input_tokens: 2, output_tokens: 9 }] }), '{', ''].join('\r\n')

    expect(parseTranscript(plain)).toEqual(NOTHING_FOUND)
    expect(parseTranscript('')).toEqual(NOTHING_FOUND)
    expect(parseTranscript(EARLY)).toEqual(NOTHING_FOUND)
  })

  test('a read is due after a new call, with a path; a read before the file caught up is behind', () => {
    const counted = oneCall()

    expect(isTranscriptReadDue(EMPTY_ADVISOR, PATH)).toBe(false)
    expect(isTranscriptReadDue(counted, PATH)).toBe(true)
    expect(isTranscriptReadDue(counted, '')).toBe(false)
    expect(isTranscriptReadDue(counted, undefined)).toBe(false)

    // The stop came before the advisor response reached the file.
    expect(isTranscriptBehind(counted, parseTranscript(EARLY))).toBe(true)
    expect(isTranscriptBehind(counted, parseTranscript(TRANSCRIPT))).toBe(false)

    const read = applyTranscript(counted, parseTranscript(TRANSCRIPT))
    expect(read).toMatchObject({
      model: 'claude-fable-5-1',
      calls: 1,
      inputTokens: 62_064,
      outputTokens: 969,
      source: 'append+transcript',
      readCalls: 1,
    })
    expect(isTranscriptReadDue(read, PATH)).toBe(false)
    expect(isTranscriptReadDue(applyAppend(read, { content: [CALL_2] }, T0 + 60_000), PATH)).toBe(true)

    // A read that finds no advisor iteration keeps the figures it had; the next read waits for a new call.
    expect(applyTranscript(counted, parseTranscript(EARLY))).toEqual({ ...counted, readCalls: 1 })
  })

  test('size guard: over 3.5 MiB the tokens give way to a reason; a failed read leaves a short error', () => {
    const read = applyTranscript(oneCall(), parseTranscript(TRANSCRIPT))
    const again = applyAppend(read, { content: [CALL_2] }, T0 + 60_000)

    expect(TRANSCRIPT_MAX_BYTES).toBe(3.5 * 1024 * 1024)
    expect(TRANSCRIPT_MAX_BYTES).toBeLessThan(4 * 1024 * 1024)
    expect(isTooLargeToRead(TRANSCRIPT_MAX_BYTES)).toBe(false)
    expect(isTooLargeToRead(TRANSCRIPT_MAX_BYTES + 1)).toBe(true)
    expect(isTooLargeToRead(Number.NaN)).toBe(true)

    const tooLarge = applyTooLarge(again)
    expect(tooLarge).toMatchObject({ model: 'claude-fable-5-1', calls: 2, tokensUnavailable: TOO_LARGE, readCalls: 2 })
    expect(tooLarge).not.toHaveProperty('inputTokens')
    expect(tooLarge).not.toHaveProperty('outputTokens')
    expect(isTranscriptReadDue(tooLarge, PATH)).toBe(false)

    const failed = applyReadError(again, READ_FAILED)
    expect(failed).toMatchObject({ calls: 2, error: READ_FAILED, readCalls: 1 })
    expect(failed).not.toHaveProperty('inputTokens')
    expect(isTranscriptReadDue(failed, PATH)).toBe(true)

    const recovered = applyTranscript(failed, parseTranscript(TWO_CALLS))
    expect(recovered).not.toHaveProperty('error')
    expect(recovered).toMatchObject({ inputTokens: 63_064, outputTokens: 1019, readCalls: 2 })
  })
})

describe('the advisor clock', () => {
  test('the last time is the local time of day', () => {
    expect(clockTime(new Date(2026, 9, 2, 14, 3, 27).getTime())).toBe('14:03:27')
    expect(clockTime(new Date(2026, 9, 2, 9, 5, 7).getTime())).toBe('09:05:07')
  })
})

const SURFACES = ['terminal', 'desktop'] as const

const PANE = { plugin: 'agent-tree', component: 'Pane', requestId: 'agent-tree' } as const

/** Pane props as a docked pane of 140 columns and 30 rows receives them. */
const PROPS = {
  title: 'Agent Tree',
  isFocused: false,
  bodyColumns: 140,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const ADVISOR_PURPLE = '#bc8cff'

/** One Text of the advisor box: what it shows and how. */
type AdvisorBoxRow = { text: string; color: unknown; dim: boolean; bold: boolean; inverse: boolean }

/** The Text rows inside a drawn element, in document order. */
function textRows(node: unknown): AdvisorBoxRow[] {
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
        inverse: element.props?.inverse === true,
      },
    ]
  }

  return children.flatMap(textRows)
}

/**
 * The advisor box (the purple border): its rows, read back as one line (its
 * rows joined with ` · `, C7c), and whether its border is dim (no call in
 * flight, C7c).
 */
async function advisorBox(ui: Pick<Mounted, 'findAll'>): Promise<{ rows: AdvisorBoxRow[]; line: string; isDim: boolean }> {
  const box = (await ui.findAll({ type: 'Box' })).find(found => found.props.borderColor === ADVISOR_PURPLE)
  const rows = textRows(box)

  return { rows, line: rows.map(row => row.text).join(' · '), isDim: box?.props.borderDimColor === true }
}

/** The advisor box's line as a pattern: `HH:mm:ss` and the seconds of a latency stand for any. */
const RECENT = '◇ \\d{2}:\\d{2}:\\d{2}  \\d+\\.\\ds'

const LAST = 'last \\d{2}:\\d{2}:\\d{2} \\(\\d+\\.\\ds\\)'

/** A response row of the main loop (or of subagent `agentId`) as `session.append` hands it: one block. */
function responseRow(uuid: string, block: { type: string }, agentId?: string) {
  return {
    door: 'response' as const,
    origin: { kind: 'model' as const, model: 'claude-opus-5-5' },
    uuid,
    message: { type: 'assistant' as const, role: 'assistant' as const, content: [block] },
    ...(agentId === undefined ? {} : { agentId }),
  }
}

/**
 * Raises a response row as the query loop does. The kit keeps no rows beneath
 * the plugins, and the engine skips a `session.append` hook that answers
 * without `next`, a test's own included: the append rejects with the kit's
 * `no implementation` once the hooks above ran. What the plugin made of the
 * row is read from the pane; any other rejection fails the test.
 */
async function append($: Engine, row: ReturnType<typeof responseRow>): Promise<void> {
  await $.session.append(row).catch((error: unknown) => {
    if (!String(error).includes('no implementation for session.append')) {
      throw error
    }
  })
}

/** `$.fs.stat` of a transcript file of `size` bytes. */
function statOf(size: number) {
  return { value: { kind: 'file' as const, size, mtimeMs: T0, isLink: false } }
}

const STOP = { stop_hook_active: false, transcript_path: PATH } as const

describe('the advisor in a session', () => {
  test('one advisor call of the main loop: calls 1 and the encrypted-advice note on terminal and desktop', async ($, on) => {

    await append($, responseRow('r2', CALL))
    await append($, responseRow('r3', RESULT))
    await append($, responseRow('r4', TEXT))
    // The same block again, and a subagent's own advisor call: neither is counted.
    await append($, responseRow('r2', CALL))
    await append($, responseRow('s1', CALL_2, 'a855975fcff9c0909'))

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
      const { rows, line, isDim } = await advisorBox(ui)

      expect(line).toMatch(new RegExp(`^FABLE ADVISOR · on call · idle · calls 1 · ${LAST} · ${RECENT} · advice: encrypted by API$`))
      // C7c (PRD M-L5): the title (no model read yet), the activity, the calls,
      // the last call, the latest calls, the advice note; purple, in the box's 26 columns.
      expect(rows.map(row => row.text)).toEqual([
        'FABLE ADVISOR',
        'on call · idle',
        'calls 1',
        expect.stringMatching(new RegExp(`^${LAST}$`)),
        expect.stringMatching(new RegExp(`^${RECENT}$`)),
        'advice: encrypted by API',
      ])
      // No call in flight: the title plain, the border dim, nothing in inverse.
      expect(rows[0]?.bold).toBe(false)
      expect(isDim).toBe(true)
      expect(rows.some(row => row.inverse)).toBe(false)
      expect(rows.every(row => row.color === ADVISOR_PURPLE && widthOf(row.text) <= 26)).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'encrypted by API' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a stop after a new call reads the transcript once, 400 ms later, for the model and tokens', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const reads: string[] = []

    on('classic.Stop', () => ({}))
    on('fs.stat', () => statOf(TRANSCRIPT.length))
    on('fs.read', ($, e) => {
      reads.push(e.path)

      return { value: TRANSCRIPT }
    })

    // A stop with no advisor call reads nothing.
    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS)
    expect(reads).toEqual([])

    await append($, responseRow('r2', CALL))
    await append($, responseRow('r3', RESULT))
    await $.classic.Stop(STOP)
    await clock.settle()
    expect(reads).toEqual([])

    await clock.advance(TRANSCRIPT_DELAY_MS)
    expect(reads).toEqual([PATH])

    // The next stop with no new call leaves the file alone.
    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS + TRANSCRIPT_RETRY_MS)
    expect(reads).toEqual([PATH])

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })

      // C7c: the model in the title; the tokens after the calls, packed into 26 columns.
      expect((await advisorBox(ui)).line).toMatch(
        new RegExp(`^FABLE ADVISOR fable-5-1 · on call · idle · calls 1 · read 62k tok · out 969 tok · ${LAST} · ${RECENT} · advice: encrypted by API$`),
      )
      await ui.unmount()
    }
  })

  test('a read before the file caught up is made once more, 1.5 s later', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const reads: string[] = []

    on('classic.Stop', () => ({}))
    on('fs.stat', () => statOf(TRANSCRIPT.length))
    on('fs.read', ($, e) => {
      reads.push(e.path)

      return { value: reads.length === 1 ? EARLY : TRANSCRIPT }
    })

    await append($, responseRow('r2', CALL))
    await append($, responseRow('r3', RESULT))
    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS)
    expect(reads).toEqual([PATH])

    // Nothing written by the early read: no model, no tokens yet.
    const before = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    const early = (await advisorBox(before)).line
    expect(early).toMatch(/^FABLE ADVISOR · on call · idle · calls 1 · last /)
    expect(early).not.toContain('tok')
    await before.unmount()

    await clock.advance(TRANSCRIPT_RETRY_MS)
    expect(reads).toEqual([PATH, PATH])

    const after = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    expect((await advisorBox(after)).line).toMatch(/^FABLE ADVISOR fable-5-1 · on call · idle · calls 1 · read 62k tok · out 969 tok · /)
    await after.unmount()

    // No third read: the retry caught up, and a stop with no new call reads nothing.
    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS + TRANSCRIPT_RETRY_MS)
    expect(reads).toEqual([PATH, PATH])
  })

  test('a transcript over 3.5 MiB is not read: tok n/a (transcript too large)', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const reads: string[] = []

    on('classic.Stop', () => ({}))
    on('fs.stat', () => statOf(TRANSCRIPT_MAX_BYTES + 1))
    on('fs.read', ($, e) => {
      reads.push(e.path)

      return { value: TRANSCRIPT }
    })

    await append($, responseRow('r2', CALL))
    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS + TRANSCRIPT_RETRY_MS)

    expect(reads).toEqual([])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    // C7-0: the reason is wider than the advisor box's 26 columns and is cut there.
    // C7c: its result has not come, so the call is in flight: no last call yet.
    expect((await advisorBox(ui)).line).toMatch(
      /^FABLE ADVISOR · ◆ advising now \(\d+\.\d s\) [◐◓◑◒] · calls 1 · tok n\/a \(transcript too l~ · advice: encrypted by API$/,
    )
    await ui.unmount()
  })

  test('a failed read is tried once more, then shows a short error; the next stop tries again', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    let reads = 0

    on('classic.Stop', () => ({}))
    on('fs.stat', () => statOf(TRANSCRIPT.length))
    on('fs.read', () => {
      reads += 1

      return { deny: 'refused by the test' }
    })

    await append($, responseRow('r2', CALL))
    await append($, responseRow('r3', RESULT))
    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS)
    expect(reads).toBe(1)

    await clock.advance(TRANSCRIPT_RETRY_MS)
    expect(reads).toBe(2)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    const { line } = await advisorBox(ui)

    // C7-0: the reason is wider than the advisor box's 26 columns and is cut there.
    expect(line).toMatch(new RegExp(` · calls 1 · tok n/a \\(transcript read ~ · ${LAST} · ${RECENT} · advice: encrypted by API$`))
    expect(line).not.toContain('refused by the test')
    await ui.unmount()

    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS)
    expect(reads).toBe(3)
  })
})

/** Every `advisor` write that landed, seen from beneath the plugin. */
function advisorWrites(on: On): AdvisorSnapshot[] {
  const writes: AdvisorSnapshot[] = []

  on('state.set', { plugin: 'agent-tree', key: 'advisor' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push(e.value as AdvisorSnapshot)
    }

    return written
  })

  return writes
}

describe('the advisor call in flight in a session (C7c)', () => {
  test('session.append writes the advisor only when a row changes it: its start sets the flag, its result clears it and lists the call', async ($, on) => {
    const writes = advisorWrites(on)

    await append($, responseRow('r2', CALL))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ calls: 1, inFlight: true, pendingCallId: 'srvtoolu_01', recentCalls: [] })
    expect(writes[0]?.inFlightSince).toEqual(expect.any(Number))

    // The same block again, a text row, a subagent's own advisor call: no write.
    await append($, responseRow('r2', CALL))
    await append($, responseRow('r4', TEXT))
    await append($, responseRow('s1', CALL_2, 'a855975fcff9c0909'))
    expect(writes).toHaveLength(1)

    await append($, responseRow('r3', RESULT))
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ calls: 1, inFlight: false, recentCalls: [{ at: expect.any(Number), latencyMs: expect.any(Number) }] })
    expect(writes[1]).not.toHaveProperty('inFlightSince')

    // The same result again: no write.
    await append($, responseRow('r3', RESULT))
    expect(writes).toHaveLength(2)
  })

  test('a transcript read that fails, or finds the tokens, leaves a call in flight in flight', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const writes = advisorWrites(on)
    let reads = 0

    on('classic.Stop', () => ({}))
    on('fs.stat', () => statOf(TRANSCRIPT.length))
    on('fs.read', () => {
      reads += 1

      return reads === 1 ? { deny: 'refused by the test' } : { value: TRANSCRIPT }
    })

    // A first call came back; a second is out when the stop comes.
    await append($, responseRow('r2', CALL))
    await append($, responseRow('r3', RESULT))
    await append($, responseRow('r5', CALL_2))
    await $.classic.Stop(STOP)
    await clock.advance(TRANSCRIPT_DELAY_MS + TRANSCRIPT_RETRY_MS)

    expect(reads).toBe(2)
    expect(writes.at(-1)).toMatchObject({ calls: 2, inFlight: true, pendingCallId: 'srvtoolu_02', model: 'claude-fable-5-1' })
  })

  test('mounted (PRD M-L5, M-L8): a call out lights the border, bolds the title and draws `◆ advising now (n.n s)` and the spinner in inverse, and the status row says `fable [advising · n]`; back, all dim again and `on call`; the latest five calls listed', async ($, on) => {
    const tall = { ...PROPS, scroll: { offset: 0, bodyRows: 60 } }
    const look = async (surface: (typeof SURFACES)[number]) => {
      const ui = await $.ui.mount({ ...PANE, surface, props: tall })
      const box = await advisorBox(ui)
      const status = (await ui.findAll({ type: 'Text' })).map(found => found.text).filter(text => text.startsWith('fable ['))

      await ui.unmount()

      return { ...box, status }
    }

    // Seven calls come back.
    for (let index = 1; index <= 7; index += 1) {
      await append($, responseRow(`c${index}`, { ...CALL, id: `srvtoolu_1${index}` }))
      await append($, responseRow(`r${index}`, { ...RESULT, tool_use_id: `srvtoolu_1${index}` }))
    }

    for (const surface of SURFACES) {
      const { rows, isDim, status } = await look(surface)

      expect(rows.map(row => row.text), surface).toEqual([
        'FABLE ADVISOR',
        'on call · idle',
        'calls 7',
        expect.stringMatching(new RegExp(`^${LAST}$`)),
        ...Array.from({ length: 5 }, () => expect.stringMatching(new RegExp(`^${RECENT}$`))),
        'advice: encrypted by API',
      ])
      expect(isDim, surface).toBe(true)
      expect(rows.some(row => row.bold || row.inverse), surface).toBe(false)
      expect(status, surface).toEqual(['fable [on call · 7]'])
    }

    // An eighth goes out.
    await append($, responseRow('c8', { ...CALL, id: 'srvtoolu_18' }))

    for (const surface of SURFACES) {
      const { rows, isDim, status } = await look(surface)

      expect(isDim, surface).toBe(false)
      expect(rows[0], surface).toMatchObject({ text: 'FABLE ADVISOR', bold: true, inverse: false })
      expect(rows[1], surface).toMatchObject({ text: expect.stringMatching(/^◆ advising now \(\d+\.\d s\) [◐◓◑◒]$/), inverse: true })
      expect(rows.slice(2).map(row => row.text)[0], surface).toBe('calls 8')
      expect(rows.filter(row => row.text.startsWith('◇ ')), surface).toHaveLength(5)
      expect(rows.slice(2).some(row => row.inverse || row.bold), surface).toBe(false)
      expect(status, surface).toEqual(['fable [advising · 8]'])
    }

    // It comes back: dim again.
    await append($, responseRow('r8', { ...RESULT, tool_use_id: 'srvtoolu_18' }))

    const back = await look('terminal')

    expect(back.isDim).toBe(true)
    expect(back.status).toEqual(['fable [on call · 8]'])
  })
})
