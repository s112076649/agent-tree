import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ActivityCall, ActivitySnapshot, AdvisorSnapshot, AgentNode, JevSnapshot, TreeSnapshot } from '../types'
import {
  EMPTY_ACTIVITY,
  FRAMES,
  IN_FLIGHT_STALE_MS,
  JEV_CALLING,
  MAX_CALLS,
  SPINNER,
  currentCall,
  dotAt,
  elapsed,
  endTool,
  endTurn,
  isAnyActive,
  isInFlight,
  isJevCalling,
  nodeActivity,
  spinner,
  startStep,
  startTool,
  withJevCall,
} from './activity'
import { EMPTY_ADVISOR } from './advisor-core'
import { EMPTY_JEV } from './jev-core'
import { agentBoxRows, agentLine, isDrawnRunning } from './render/boxes/agents-row'
import { DOT, fanTexts } from './render/boxes/connectors'
import { isMainActive } from './render/boxes/main-box'
import { STATUS_TOOL_COLUMNS, mainWord, statusForms } from './render/boxes/status-row'
import { COLORS } from './render/theme'
import { applyExternalStart, applyStep, applyToolCall, applyTurnComplete, emptyTree, upsertFromSpawn } from './tree'

const T = 1_790_928_100_000

/** A tool call in flight: the main loop's, or with `agentId` a subagent's. */
function call(id: string, tool: string, since: number, agentId?: string): ActivityCall {
  return { id, ...(agentId === undefined ? {} : { agentId }), tool, since }
}

/** The main loop thinking since T, nothing in flight. */
const THINKING: ActivitySnapshot = { main: { phase: 'thinking', since: T }, calls: [], updatedAt: T }

/** Subagent a1 as the tree keeps it: running since T, two tool calls, the last a Grep. */
function node(changes: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'a1',
    type: 'Explore',
    description: 'List docs files',
    role: 'researcher',
    status: 'running',
    lastTool: 'Grep',
    toolCalls: 2,
    startedAt: T,
    ...changes,
  }
}

describe('the spinner, the dot and the times (activity.ts)', () => {
  test('the spinner steps through its four glyphs with the frame; a frame that is no whole number is frame 0', () => {
    expect(SPINNER).toEqual(['◐', '◓', '◑', '◒'])
    expect(FRAMES).toBe(4)
    expect([0, 1, 2, 3, 4, 5, -1, -4, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(frame => spinner(frame))).toEqual([
      '◐',
      '◓',
      '◑',
      '◒',
      '◐',
      '◓',
      '◒',
      '◐',
      '◐',
      '◐',
      '◐',
    ])
  })

  test('the dot steps from the first cell to the last in even steps over the four frames, then starts over', () => {
    // The fan of three boxes at 92 columns: 41 cells, columns 9 to 49.
    expect([0, 1, 2, 3, 4].map(frame => dotAt(frame, 41))).toEqual([0, 13, 27, 40, 0])
    expect([0, 1, 2, 3].map(frame => dotAt(frame, 4))).toEqual([0, 1, 2, 3])
    expect([0, 1, 2, 3].map(frame => dotAt(frame, 2))).toEqual([0, 0, 1, 1])
    // One cell (one box): the dot stays on it.
    expect([0, 1, 2, 3].map(frame => dotAt(frame, 1))).toEqual([0, 0, 0, 0])
    // The frame taken round, or as frame 0; the length as whole cells.
    expect(dotAt(-1, 41)).toBe(40)
    expect(dotAt(2.5, 41)).toBe(0)
    expect(dotAt(3, 4.9)).toBe(3)
    // No line: no dot.
    expect([0, 0.5, -3, Number.NaN, Number.POSITIVE_INFINITY].map(length => dotAt(1, length))).toEqual([-1, -1, -1, -1, -1])
  })

  test('elapsed: the time since, as a box shows it; -- when unknown; never below 0s', () => {
    expect(elapsed(T, undefined)).toBe('--')
    expect(elapsed(T + 2400, T)).toBe('2s')
    expect(elapsed(T + 184_000, T)).toBe('3m04s')
    expect(elapsed(T - 5000, T)).toBe('0s')
  })
})

describe('what moves, and what each loop is doing (activity.ts)', () => {
  test("isAnyActive: the main loop thinking or tooling, a running subagent or external worker; never the tree's main row alone", () => {
    const idle = emptyTree(T)
    const running = upsertFromSpawn(
      idle,
      { subagentType: 'Explore', description: 'List docs files' },
      { agentId: 'a1', model: 'claude-sonnet-5-5' },
      T,
    )
    const ended = applyTurnComplete(running, { agentId: 'a1', reason: 'answer', durationMs: 1000, now: T + 1000 })
    const worker = applyExternalStart(idle, { toolUseId: 'toolu_k1', engine: 'kimi', model: 'kimi-code/k3', now: T })
    const tooling = startTool(THINKING, call('toolu_r1', 'Read', T + 1))
    // No call of the advisor or of Jev in flight (C7c).
    const active = (tree: TreeSnapshot, activity: ActivitySnapshot): boolean => isAnyActive(tree, activity, EMPTY_ADVISOR, EMPTY_JEV, T)

    expect(active(idle, EMPTY_ACTIVITY)).toBe(false)
    expect(active(ended, EMPTY_ACTIVITY)).toBe(false)
    expect(active(idle, THINKING)).toBe(true)
    expect(active(idle, tooling)).toBe(true)
    expect(active(running, EMPTY_ACTIVITY)).toBe(true)
    expect(active(worker, EMPTY_ACTIVITY)).toBe(true)
    // The activity speaks for the main loop: a tree whose main row was left tooling moves nothing.
    expect(active(applyToolCall(idle, { tool: 'Read', now: T }), EMPTY_ACTIVITY)).toBe(false)
  })

  test('isInFlight (C7c): the flag set less than IN_FLIGHT_STALE_MS (ten minutes) before now; a stale flag, one with no start, or none is idle', () => {
    const flag = { inFlight: true, inFlightSince: T }

    expect(IN_FLIGHT_STALE_MS).toBe(600_000)
    expect(isInFlight(flag, T)).toBe(true)
    expect(isInFlight(flag, T + IN_FLIGHT_STALE_MS - 1)).toBe(true)
    expect(isInFlight(flag, T + IN_FLIGHT_STALE_MS)).toBe(false)
    expect(isInFlight(flag, T + 3_600_000)).toBe(false)
    // A start after now (written a moment later than the reading's clock): a call just begun.
    expect(isInFlight({ inFlight: true, inFlightSince: T + 5000 }, T)).toBe(true)
    // A flag with no start cannot be bounded: it is stale.
    expect(isInFlight({ inFlight: true }, T)).toBe(false)
    expect(isInFlight({ inFlight: true, inFlightSince: Number.NaN }, T)).toBe(false)
    expect(isInFlight(flag, Number.NaN)).toBe(false)
    expect(isInFlight({ inFlight: false, inFlightSince: T }, T)).toBe(false)
    expect(isInFlight({}, T)).toBe(false)
    expect(isInFlight(EMPTY_ADVISOR, T)).toBe(false)
    expect(isInFlight(EMPTY_JEV, T)).toBe(false)
  })

  test('isAnyActive (C7c): a call of the advisor or of Jev in flight moves the pane by itself; a stale flag does not', () => {
    const idle = emptyTree(T)
    const advising: AdvisorSnapshot = { ...EMPTY_ADVISOR, calls: 1, inFlight: true, inFlightSince: T }
    const calling: JevSnapshot = { ...EMPTY_JEV, enabled: true, inFlight: true, inFlightSince: T }
    const fresh = T + 30_000
    const stale = T + IN_FLIGHT_STALE_MS
    // The main loop, the advisor, Jev, the time it is read at: whether the pane moves.
    const table: [ActivitySnapshot, AdvisorSnapshot, JevSnapshot, number, boolean][] = [
      [EMPTY_ACTIVITY, EMPTY_ADVISOR, EMPTY_JEV, fresh, false],
      [EMPTY_ACTIVITY, advising, EMPTY_JEV, fresh, true],
      [EMPTY_ACTIVITY, EMPTY_ADVISOR, calling, fresh, true],
      [EMPTY_ACTIVITY, advising, calling, fresh, true],
      [EMPTY_ACTIVITY, advising, EMPTY_JEV, stale, false],
      [EMPTY_ACTIVITY, EMPTY_ADVISOR, calling, stale, false],
      [EMPTY_ACTIVITY, advising, calling, stale, false],
      [THINKING, advising, calling, stale, true],
      [THINKING, EMPTY_ADVISOR, EMPTY_JEV, fresh, true],
    ]

    for (const [activity, advisor, jev, now, expected] of table) {
      const label = `${activity.main.phase}, advisor ${advisor.inFlight}, jev ${jev.inFlight}, ${now - T} ms`

      expect(isAnyActive(idle, activity, advisor, jev, now), label).toBe(expected)
    }

    // The flag cleared, its start gone: idle again.
    const cleared: AdvisorSnapshot = { ...EMPTY_ADVISOR, calls: 1, inFlight: false }

    expect(isAnyActive(idle, EMPTY_ACTIVITY, cleared, EMPTY_JEV, fresh)).toBe(false)
  })

  test('isJevCalling and withJevCall (C7c, PRD M-L8): Jev on and its call in flight; the status entry then ends ` · jev …`, else it is left as it was', () => {
    const calling: JevSnapshot = { ...EMPTY_JEV, enabled: true, inFlight: true, inFlightSince: T }
    const entry = 'agent-tree 1/3 · fable 4'

    expect(JEV_CALLING).toBe('jev …')
    expect(isJevCalling(calling, T + 30_000)).toBe(true)
    expect(isJevCalling(calling, T + IN_FLIGHT_STALE_MS - 1)).toBe(true)
    // Stale, off with a flag left set, the flag cleared, Jev on and waiting: not calling.
    expect(isJevCalling(calling, T + IN_FLIGHT_STALE_MS)).toBe(false)
    expect(isJevCalling({ ...calling, enabled: false }, T)).toBe(false)
    expect(isJevCalling({ ...calling, inFlight: false }, T)).toBe(false)
    expect(isJevCalling({ ...EMPTY_JEV, enabled: true }, T)).toBe(false)
    expect(withJevCall(entry, calling, T)).toBe('agent-tree 1/3 · fable 4 · jev …')
    expect(withJevCall('agent-tree', calling, T)).toBe('agent-tree · jev …')
    expect(withJevCall(entry, calling, T + IN_FLIGHT_STALE_MS)).toBe(entry)
    expect(withJevCall(entry, { ...calling, enabled: false }, T)).toBe(entry)
    expect(withJevCall(entry, EMPTY_JEV, T)).toBe(entry)
  })

  test("currentCall and nodeActivity: a loop's latest call in flight; a running node's tool and time, an external worker's start; nothing once it stopped", () => {
    const activity: ActivitySnapshot = {
      main: { phase: 'tooling', tool: 'Read', since: T + 3 },
      calls: [
        call('m1', 'Agent', T + 1),
        call('s1', 'Glob', T + 2, 'a1'),
        call('m2', 'Read', T + 3),
        call('s2', 'Grep', T + 4, 'a1'),
        call('s3', 'Bash', T + 5, 'a2'),
      ],
      updatedAt: T + 5,
    }

    expect(currentCall(activity, undefined)).toEqual(call('m2', 'Read', T + 3))
    expect(currentCall(activity, 'a1')).toEqual(call('s2', 'Grep', T + 4, 'a1'))
    expect(currentCall(activity, 'a2')).toEqual(call('s3', 'Bash', T + 5, 'a2'))
    expect(currentCall(activity, 'a9')).toBeUndefined()
    expect(currentCall(EMPTY_ACTIVITY, undefined)).toBeUndefined()

    expect(nodeActivity(activity, node())).toEqual({ tool: 'Grep', since: T + 4 })
    expect(nodeActivity(activity, node({ id: 'a3' }))).toEqual({})
    expect(nodeActivity(activity, node({ status: 'completed' }))).toBeUndefined()
    expect(nodeActivity(activity, node({ status: 'failed' }))).toBeUndefined()

    // An external worker: since its start, no tool (its tools are not seen).
    const worker = node({ id: 'ext:toolu_k1', kind: 'external', type: 'kimi', lastTool: undefined, toolCalls: 0, startedAt: T + 7 })

    expect(nodeActivity(activity, worker)).toEqual({ since: T + 7 })
    expect(nodeActivity(activity, { ...worker, startedAt: undefined })).toEqual({})
    expect(nodeActivity(activity, { ...worker, status: 'killed' })).toBeUndefined()
  })
})

describe('the activity through each event (activity.ts)', () => {
  test("startStep: an idle main loop thinks from now; a subagent's request, or a later request of the turn, changes nothing", () => {
    const thinking = startStep(EMPTY_ACTIVITY, { now: T })

    expect(thinking).toEqual(THINKING)
    expect(startStep(thinking, { now: T + 5 })).toBe(thinking)
    expect(startStep(EMPTY_ACTIVITY, { agentId: 'a1', now: T })).toBe(EMPTY_ACTIVITY)

    const tooling = startTool(thinking, call('m1', 'Read', T + 1))

    expect(startStep(tooling, { now: T + 2 })).toBe(tooling)

    // A subagent's call in flight stays as it is.
    const busy = startTool(EMPTY_ACTIVITY, call('s1', 'Grep', T - 5, 'a1'))

    expect(startStep(busy, { now: T })).toEqual({ main: { phase: 'thinking', since: T }, calls: [call('s1', 'Grep', T - 5, 'a1')], updatedAt: T })
  })

  test("startTool: the main loop tools its latest call; a subagent's call leaves it as it was; past MAX_CALLS the oldest go", () => {
    const first = startTool(THINKING, call('m1', 'Agent', T + 1))

    expect(first).toEqual({ main: { phase: 'tooling', tool: 'Agent', since: T + 1 }, calls: [call('m1', 'Agent', T + 1)], updatedAt: T + 1 })

    // A parallel call: tooling the latest.
    const second = startTool(first, call('m2', 'Read', T + 2))

    expect(second.main).toEqual({ phase: 'tooling', tool: 'Read', since: T + 2 })

    const sub = startTool(second, call('s1', 'Grep', T + 3, 'a1'))

    expect(sub.main).toBe(second.main)
    expect(sub.calls.map(entry => entry.id)).toEqual(['m1', 'm2', 's1'])
    expect(sub.updatedAt).toBe(T + 3)
    expect(startTool(EMPTY_ACTIVITY, call('s1', 'Grep', T, 'a1')).main).toEqual({ phase: 'idle' })
    // A main-loop call with no request seen before it (outside a turn): tooling all the same.
    expect(startTool(EMPTY_ACTIVITY, call('m1', 'Read', T)).main).toEqual({ phase: 'tooling', tool: 'Read', since: T })

    const many = Array.from({ length: MAX_CALLS + 1 }, (_, index) => call(`s${index}`, 'Grep', T + index, 'a1')).reduce(
      startTool,
      EMPTY_ACTIVITY,
    )

    expect(MAX_CALLS).toBe(64)
    expect(many.calls).toHaveLength(MAX_CALLS)
    expect(many.calls[0]?.id).toBe('s1')
    expect(many.calls.at(-1)?.id).toBe(`s${MAX_CALLS}`)
  })

  test("endTool: the call leaves; the main loop tools its latest call still out, else thinks from now; a subagent's call leaves it as it was", () => {
    const m1 = call('m1', 'Agent', T + 1)
    const m2 = call('m2', 'Read', T + 2)
    const s1 = call('s1', 'Grep', T + 3, 'a1')
    const busy = [m1, m2, s1].reduce(startTool, THINKING)

    // The later main-loop call returns first: tooling the one still out, since it began.
    const afterM2 = endTool(busy, m2, T + 10)

    expect(afterM2).toEqual({ main: { phase: 'tooling', tool: 'Agent', since: T + 1 }, calls: [m1, s1], updatedAt: T + 10 })

    // The last main-loop call returns: thinking from then.
    const afterM1 = endTool(afterM2, m1, T + 20)

    expect(afterM1).toEqual({ main: { phase: 'thinking', since: T + 20 }, calls: [s1], updatedAt: T + 20 })
    expect(endTool(afterM1, s1, T + 30)).toEqual({ main: { phase: 'thinking', since: T + 20 }, calls: [], updatedAt: T + 30 })

    // An idle main loop stays idle, as with a call left in flight from before a reload.
    const left: ActivitySnapshot = { main: { phase: 'idle' }, calls: [m1], updatedAt: T }

    expect(endTool(left, m1, T + 50)).toEqual({ main: { phase: 'idle' }, calls: [], updatedAt: T + 50 })
  })

  test('endTool: a call no longer in flight, or one that only looks like it, changes nothing; of two calls alike one leaves at a time', () => {
    const m1 = call('m1', 'Agent', T + 1)
    const s1 = call('s1', 'Grep', T + 3, 'a1')
    const busy = [m1, s1].reduce(startTool, THINKING)
    const done = endTool(endTool(busy, s1, T + 10), m1, T + 11)

    // Its turn ended first: no longer in flight.
    expect(endTool(done, s1, T + 20)).toBe(done)
    expect(endTool(done, m1, T + 20)).toBe(done)
    // Another call's id, time, loop or tool.
    expect(endTool(busy, { ...m1, id: 'other' }, T + 20)).toBe(busy)
    expect(endTool(busy, { ...m1, since: T + 99 }, T + 20)).toBe(busy)
    expect(endTool(busy, { ...m1, agentId: 'a1' }, T + 20)).toBe(busy)
    expect(endTool(busy, { ...m1, tool: 'Read' }, T + 20)).toBe(busy)

    // Calls with no tool_use_id, the same tool and time: one leaves, the main loop still tools the other.
    const twins = [call('', 'Read', T), call('', 'Read', T)].reduce(startTool, THINKING)
    const once = endTool(twins, call('', 'Read', T), T + 5)

    expect(once.calls).toEqual([call('', 'Read', T)])
    expect(once.main).toEqual({ phase: 'tooling', tool: 'Read', since: T })
  })

  test("endTurn: the loop's calls leave; the main loop's turn makes it idle; nothing to change gives the very same value", () => {
    const m1 = call('m1', 'Read', T + 1)
    const s1 = call('s1', 'Grep', T + 3, 'a1')
    const s2 = call('s2', 'Bash', T + 4, 'a2')
    const busy = [m1, s1, s2].reduce(startTool, THINKING)
    const idle = endTurn(busy, { now: T + 10 })

    // The main loop's turn: idle, its calls gone, the subagents' kept.
    expect(idle).toEqual({ main: { phase: 'idle' }, calls: [s1, s2], updatedAt: T + 10 })
    // A subagent's turn: its calls gone, the main loop as it was.
    expect(endTurn(busy, { agentId: 'a1', now: T + 10 })).toEqual({ ...busy, calls: [m1, s2], updatedAt: T + 10 })
    expect(endTurn(THINKING, { now: T + 5 })).toEqual({ main: { phase: 'idle' }, calls: [], updatedAt: T + 5 })

    expect(endTurn(EMPTY_ACTIVITY, { now: T })).toBe(EMPTY_ACTIVITY)
    expect(endTurn(idle, { now: T + 20 })).toBe(idle)
    expect(endTurn(busy, { agentId: 'a9', now: T + 20 })).toBe(busy)
  })
})

describe('the activity as drawn (C7b)', () => {
  test('the fan carries the dot of the frame from the first box to the last; one box: on the trunk; no frame: no dot', () => {
    const fan = `┌${'─'.repeat(19)}┼${'─'.repeat(19)}┐`
    const dotted = (cell: number): string => `${' '.repeat(9)}${fan.slice(0, cell)}${DOT}${fan.slice(cell + 1)}`

    expect(DOT).toBe('●')
    expect([0, 1, 2, 3, 4].map(frame => fanTexts([9, 29, 49], 61, frame)[1])).toEqual([
      dotted(0),
      dotted(13),
      dotted(27),
      dotted(40),
      dotted(0),
    ])
    expect(fanTexts([9, 29, 49], 61)[1]).toBe(`${' '.repeat(9)}${fan}`)
    expect(fanTexts([9], 61, 2)[1]).toBe(`${' '.repeat(9)}${DOT}`)
  })

  test("a running node's rows name the tool in flight before the last one; its title is bold while it runs", () => {
    const live = nodeActivity({ ...EMPTY_ACTIVITY, calls: [call('s1', 'Glob', T + 1, 'a1')] }, node())

    expect(live).toEqual({ tool: 'Glob', since: T + 1 })
    expect(agentBoxRows(node(), 1, T + 12_000, 17, live)[3]?.text).toBe('◓ Glob/2 12s')
    expect(agentBoxRows(node(), 1, T + 12_000, 17)[3]?.text).toBe('◓ Grep/2 12s')
    expect(agentLine(node(), 1, T + 12_000, 57, live).text).toBe('◓ researcher Explore Glob/2 12s')
    expect(isDrawnRunning(node())).toBe(true)
    expect(['completed', 'failed', 'killed'].map(status => isDrawnRunning(node({ status })))).toEqual([false, false, false])
    expect(agentBoxRows(node(), 1, T, 17, live)[0]?.bold).toBe(true)
    expect(agentBoxRows(node({ status: 'completed', endedAt: T + 5000 }), 1, T + 9000, 17)[0]?.bold).toBe(false)
  })

  test("the status row: the main loop's word in its two wider forms, a long tool name cut to 16 columns; nothing while idle", () => {
    expect(mainWord({ phase: 'idle' })).toBe('')
    expect(mainWord({ phase: 'thinking', since: T })).toBe('thinking')
    expect(mainWord({ phase: 'tooling', tool: 'Read', since: T })).toBe('tooling Read')
    expect(mainWord({ phase: 'tooling', since: T })).toBe('tooling')
    expect(STATUS_TOOL_COLUMNS).toBe(16)
    expect(mainWord({ phase: 'tooling', tool: 'mcp__claude_ai_chatcut__browse_assets', since: T })).toBe('tooling mcp__claude_ai_~')

    const tree = applyStep(emptyTree(T), { model: 'claude-opus-5-5', effort: 'high', now: T })
    const mains = (activity: ActivitySnapshot): string[] =>
      statusForms({ tree, activity, advisor: EMPTY_ADVISOR, jev: EMPTY_JEV }).map(form => form[0]?.text ?? '')

    expect(mains(THINKING)).toEqual(['main [opus-5-5 · high · thinking]', 'main [opus-5-5 · thinking]', 'main [opus-5-5]'])
    expect(mains(EMPTY_ACTIVITY)).toEqual(['main [opus-5-5 · high]', 'main [opus-5-5]', 'main [opus-5-5]'])
    expect(isMainActive(THINKING)).toBe(true)
    expect(isMainActive(EMPTY_ACTIVITY)).toBe(false)
  })
})

// Through the plugin (C7b): the frame timer, the drawing and the close-out
// of a call, with the kit's world beneath the plugin.

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

/** agent.spawn's input for an Explore subagent the main loop starts. */
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

const SUBAGENT_STOP = {
  stop_hook_active: false,
  agent_id: 'toolu_1',
  agent_transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--repo\\0f7c\\subagents\\agent-toolu_1.jsonl',
  agent_type: 'Explore',
} as const

const OK = { result: undefined as never, text: 'ok' }

const MAIN_END = { answer: 'done', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' as const }

/** The end of the main loop's turn when the person interrupts it: no answer, `isAborted`. */
const MAIN_ABORTED = { answer: '', durationMs: 4200, isAborted: true, turnId: 't1', reason: 'aborted' as const }

const subagentEnd = (agentId: string) => ({
  answer: '',
  durationMs: 1000,
  isAborted: false,
  turnId: `t-${agentId}`,
  agentId,
  reason: 'answer' as const,
})

const startSession = ($: Engine) => $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

/** The main loop's Read of the README. */
const readCall = ($: Engine) => $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: 'D:/repo/README.md' } as never)

/** One model request: the main loop's, or with `agentId` a subagent's. */
async function step($: Engine, agentId?: string): Promise<void> {
  for await (const _chunk of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-opus-5-5',
    effort: 'high',
    messageCount: 3,
    ...(agentId === undefined ? {} : { agentId }),
  })) {
    // The bottom answers with no chunks.
  }
}

/** The world beneath the plugin: the pane opens drawn, subagents start, the model answers, turns end. */
function world(on: On): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

/** The tools beneath the plugin: a call of a `held` tool stays out until the returned release; any other returns at once. */
function holdTools(on: On, held: readonly string[]): () => void {
  let release = (): void => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  on('tool.call', async (_engine, e) => {
    if (held.includes(e.tool)) {
      await gate
    }

    return OK
  })

  return () => release()
}

/** Every `frame` write that landed, seen from beneath the plugin. */
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

/** Every `isOpen` write that landed. */
function isOpenWrites(on: On): boolean[] {
  const writes: boolean[] = []

  on('state.set', { plugin: 'agent-tree', key: 'isOpen' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push(e.value)
    }

    return written
  })

  return writes
}

/** Every `activity` write that landed: the last one is the activity as it stands. */
function activityWrites(on: On): ActivitySnapshot[] {
  const writes: ActivitySnapshot[] = []

  on('state.set', { plugin: 'agent-tree', key: 'activity' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push(e.value as ActivitySnapshot)
    }

    return written
  })

  return writes
}

/** Every `tree` write that landed. */
function treeWrites(on: On): TreeSnapshot[] {
  const writes: TreeSnapshot[] = []

  on('state.set', { plugin: 'agent-tree', key: 'tree' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push(e.value as TreeSnapshot)
    }

    return written
  })

  return writes
}

/** Whether the advisor box (the purple border) is drawn dim, as it is while no call is in flight (C7c); undefined when no such box is drawn. */
async function isAdvisorDim(ui: Pick<Mounted, 'findAll'>): Promise<boolean | undefined> {
  const box = (await ui.findAll({ type: 'Box' })).find(found => found.props.borderColor === COLORS.advisor)

  return box === undefined ? undefined : box.props.borderDimColor === true
}

/** One Text of a drawing: what it shows, and whether in bold. */
type DrawnRow = { text: string; bold: boolean }

/** The Text rows inside a drawn element, in document order. */
function textRows(element: unknown): DrawnRow[] {
  if (typeof element !== 'object' || element === null) {
    return []
  }

  const found = element as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const children = found.children ?? []

  if (found.type === 'Text') {
    return [{ text: children.filter((child): child is string => typeof child === 'string').join(''), bold: found.props?.bold === true }]
  }

  return children.flatMap(textRows)
}

/** The main box as drawn: its border dim or lit, its title bold or plain, its status line; and the status row's main part. */
async function mainLook(ui: Pick<Mounted, 'find' | 'findAll'>) {
  const box = (await ui.findAll({ type: 'Box' })).find(found => found.props.borderColor === COLORS.main)
  const rows = textRows(box)
  const word = await ui.find({ type: 'Text', text: /^main \[/ })

  return { dim: box?.props.borderDimColor === true, bold: rows[0]?.bold === true, status: rows.at(-1)?.text ?? '', word: word?.text ?? '' }
}

/** Each subagent box as drawn: its description, its border dim or lit, its title bold or plain, its status line. */
async function subLooks(ui: Pick<Mounted, 'findAll'>) {
  const boxes = (await ui.findAll({ type: 'Box' })).filter(found => found.props.borderColor === COLORS.sub)

  return boxes.map(box => {
    const rows = textRows(box)

    return { description: rows[2]?.text ?? '', dim: box.props.borderDimColor === true, bold: rows[0]?.bold === true, status: rows[3]?.text ?? '' }
  })
}

describe('the frame tick follows the activity (C7b, PRD M-L4)', () => {
  test("a main-loop call out: 4 frame writes a second; returned, the main loop thinks on until its turn ends; idle, none", { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const release = holdTools(on, ['Read'])

    world(on)
    await startSession($)
    await clock.settle()
    await clock.advance(1000)
    expect(frames).toEqual([])

    const pending = readCall($)

    await clock.settle()
    await clock.advance(1000)
    expect(frames).toEqual([1, 2, 3, 0])

    release()
    await pending
    await clock.advance(1000)
    expect(frames).toEqual([1, 2, 3, 0, 1, 2, 3, 0])

    await $.turn.complete(MAIN_END)
    await clock.advance(1000)
    expect(frames).toHaveLength(8)
  })

  test('the pane closed: a main-loop call out and the main loop thinking move no frame', { options: { autoOpen: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const release = holdTools(on, ['Read'])

    world(on)
    await startSession($)
    await step($)

    const pending = readCall($)

    await clock.advance(1000)
    release()
    await pending
    await clock.advance(1000)
    expect(frames).toEqual([])
  })

  test("the refresh syncs isOpen with the engine's record of the pane, writing it only when it changed: the frame starts and stops with it", { options: { autoOpen: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const opens = isOpenWrites(on)
    let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []

    world(on)
    on('ui.panes', () => ({ value: panes }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('ui.status', () => ({ value: undefined }))

    await startSession($)
    await step($)
    await clock.settle()
    await clock.advance(1000)
    expect(opens).toEqual([])
    expect(frames).toEqual([])

    // The person opens the pane, or the terminal widens to its floor: no event; the next refresh (every 2 s) reads it.
    panes = [{ id: 'agent-tree', title: 'Agent Tree', isShown: true, isFocused: false, isPlaced: true }]
    await clock.advance(1000)
    expect(opens).toEqual([true])

    const opened = frames.length

    await clock.advance(1000)
    expect(frames.length - opened).toBe(4)

    // The same answer at the next refresh: nothing written.
    await clock.advance(2000)
    expect(opens).toEqual([true])

    // No longer placed (the terminal narrowed): written false, the frame stands still.
    panes = [{ id: 'agent-tree', title: 'Agent Tree', isShown: true, isFocused: false, isPlaced: false }]
    await clock.advance(2000)
    expect(opens).toEqual([true, false])

    const closed = frames.length

    await clock.advance(1000)
    expect(frames).toHaveLength(closed)
  })
})

// Through the plugin (C7c): the calls of the advisor and of Jev in flight
// move the frame by themselves, the main loop idle and no subagent running.

/** An advisor call's blocks as the main loop's response rows carry them (C0 run A; the advice cut short). */
const ADVISOR_CALL = { type: 'server_tool_use', id: 'srvtoolu_01', name: 'advisor', input: {} }

const ADVISOR_RESULT = {
  type: 'advisor_tool_result',
  tool_use_id: 'srvtoolu_01',
  content: { type: 'advisor_redacted_result', encrypted_content: 'Et8KCioIFBgC' },
}

/** A response row of the main loop as `session.append` hands it: one block. */
function responseRow(uuid: string, block: { type: string }) {
  return {
    door: 'response' as const,
    origin: { kind: 'model' as const, model: 'claude-opus-5-5' },
    uuid,
    message: { type: 'assistant' as const, role: 'assistant' as const, content: [block] },
  }
}

/** Raises a response row; the kit keeps no rows beneath the plugins, so the append rejects with `no implementation` once the hooks ran. */
async function append($: Engine, row: ReturnType<typeof responseRow>): Promise<void> {
  await $.session.append(row).catch((error: unknown) => {
    if (!String(error).includes('no implementation for session.append')) {
      throw error
    }
  })
}

/** Not a real key: what `$.env.get('TYPESAFE_API_KEY')` answers in these tests. */
const KEY = 'fake-key-for-tests-0123456789'

/** Jev's answer of the C0 probe. */
const PROBE_ANSWER = {
  model: 'jev-1.13.0',
  answers: {
    looping: { type: 'noul', noul: 0.41 },
    stuck: { type: 'noul', noul: 0.29 },
    fanout_wide: { type: 'noul', noul: 0.09 },
    near_done: { type: 'noul', noul: 0.18 },
    health: { type: 'score', score: 0.91, confidence: 0.85 },
  },
}

/** Jev beneath the plugin: each `$.http.fetch` is held until the returned release, then answered with `status`. */
function holdJev(on: On, status: number = 200): { release: () => void; fetches: () => number } {
  let release = (): void => {}
  let fetches = 0
  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  on('http.fetch', async () => {
    fetches += 1
    await gate

    return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(PROBE_ANSWER) : 'unavailable' } }
  })

  return { release: () => release(), fetches: () => fetches }
}

/** Every write of `key` that landed, seen from beneath the plugin. */
function writesOf<T>(on: On, key: 'advisor' | 'jev'): T[] {
  const writes: T[] = []

  on('state.set', { plugin: 'agent-tree', key }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push(e.value as T)
    }

    return written
  })

  return writes
}

describe('the frame tick follows the advisor and Jev (C7c, PRD M-L4)', () => {
  test("the advisor alone in flight: 4 frame writes a second from its server_tool_use block; none once its result came", { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)

    world(on)
    await startSession($)
    await clock.settle()
    await clock.advance(1000)
    expect(frames).toEqual([])

    await append($, responseRow('r1', ADVISOR_CALL))
    await clock.advance(1000)
    expect(frames).toEqual([1, 2, 3, 0])

    await append($, responseRow('r2', ADVISOR_RESULT))
    await clock.advance(1000)
    expect(frames).toHaveLength(4)
  })

  test('Jev alone in flight: 4 frame writes a second while its call is out; none once the answer came', {
    options: { autoOpen: true, jevEnabled: true, refreshMs: 10_000 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const jev = holdJev(on)

    world(on)
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await clock.settle()

    // The main loop's turn ends (it is idle from then): Jev is asked, and its answer is held.
    await $.turn.complete(MAIN_END)
    await clock.settle()
    expect(jev.fetches()).toBe(1)
    expect(frames).toEqual([])

    await clock.advance(1000)
    expect(frames).toEqual([1, 2, 3, 0])

    jev.release()
    await clock.settle()
    await clock.advance(1000)
    expect(frames).toHaveLength(4)
  })

  test('Jev alone in flight, its call failing (HTTP 503): the frame turns while it is out and stops with the failure', {
    options: { autoOpen: true, jevEnabled: true, refreshMs: 10_000 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const jev = holdJev(on, 503)

    world(on)
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await $.turn.complete(MAIN_END)
    await clock.settle()
    await clock.advance(1000)
    expect(frames).toEqual([1, 2, 3, 0])

    jev.release()
    await clock.settle()
    await clock.advance(1000)
    expect(frames).toHaveLength(4)
  })

  test('a flag set IN_FLIGHT_STALE_MS ago or more moves no frame, though it is still set', async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const advisors = writesOf<AdvisorSnapshot>(on, 'advisor')

    // The advisor's start, written as if it had come eleven minutes ago: the
    // drawing clock is the machine's (`Date.now()`), not the mock clock.
    on('state.set', { plugin: 'agent-tree', key: 'advisor' }, ($, e, next) => {
      const value = e.value as AdvisorSnapshot

      return next(value.inFlight === true ? { ...e, value: { ...value, inFlightSince: Date.now() - IN_FLIGHT_STALE_MS - 60_000 } } : e)
    })
    world(on)
    await startSession($)
    await append($, responseRow('r1', ADVISOR_CALL))
    await clock.advance(1000)

    expect(advisors.at(-1)).toMatchObject({ calls: 1, inFlight: true })
    expect(frames).toEqual([])
  })

  test('session.start clears a call the advisor left in flight (a reload drops its result): one write, the frame stops; with nothing in flight it writes nothing', { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const advisors = writesOf<AdvisorSnapshot>(on, 'advisor')

    world(on)
    await startSession($)
    expect(advisors).toEqual([])

    await append($, responseRow('r1', ADVISOR_CALL))
    await clock.advance(1000)
    expect(frames).toEqual([1, 2, 3, 0])
    expect(advisors).toHaveLength(1)

    // The reload's session.start: the flag goes, the pending call stays.
    await startSession($)
    expect(advisors).toHaveLength(2)
    expect(advisors.at(-1)).toMatchObject({ calls: 1, inFlight: false, pendingCallId: 'srvtoolu_01' })
    expect(advisors.at(-1)).not.toHaveProperty('inFlightSince')

    await clock.advance(1000)
    expect(frames).toHaveLength(4)

    // Nothing in flight: another session.start writes no advisor.
    await startSession($)
    expect(advisors).toHaveLength(2)

    // The result that still comes is counted with its latency and listed.
    await append($, responseRow('r2', ADVISOR_RESULT))
    expect(advisors).toHaveLength(3)
    expect(advisors.at(-1)).toMatchObject({ calls: 1, inFlight: false, recentCalls: [{ at: expect.any(Number), latencyMs: expect.any(Number) }] })
  })

  test("the main loop's turn end clears the advisor's flag, interrupted or not (C7c2, probe F2): one write, the frame stops and the box goes dim; the pending call stays, so a result that still comes keeps its latency; a subagent's turn end and one with nothing in flight write nothing", { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const frames = frameWrites(on)
    const advisors = writesOf<AdvisorSnapshot>(on, 'advisor')

    world(on)
    await startSession($)
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    // Nothing in flight: the main loop's turn end writes no advisor.
    await $.turn.complete(MAIN_END)
    expect(advisors).toEqual([])
    expect(await isAdvisorDim(ui)).toBe(true)

    // A call goes out: the box lights and the frame turns.
    await append($, responseRow('r1', ADVISOR_CALL))
    await clock.advance(1000)
    expect(advisors).toHaveLength(1)
    expect(frames).toEqual([1, 2, 3, 0])
    expect(await isAdvisorDim(ui)).toBe(false)

    // A subagent's turn end says nothing of the main loop's call.
    await $.turn.complete(subagentEnd('a1'))
    expect(advisors).toHaveLength(1)
    expect(await isAdvisorDim(ui)).toBe(false)

    // The person interrupts the main loop, and no result row comes: the flag goes in one write, the pending call stays.
    await $.turn.complete(MAIN_ABORTED)
    expect(advisors).toHaveLength(2)
    expect(advisors.at(-1)).toMatchObject({ calls: 1, inFlight: false, pendingCallId: 'srvtoolu_01' })
    expect(advisors.at(-1)).not.toHaveProperty('inFlightSince')
    expect(await isAdvisorDim(ui)).toBe(true)

    await clock.advance(1000)
    expect(frames).toHaveLength(4)

    // Nothing in flight any more: another turn end writes nothing. A result that still comes keeps its latency.
    await $.turn.complete(MAIN_END)
    expect(advisors).toHaveLength(2)
    await append($, responseRow('r2', ADVISOR_RESULT))
    expect(advisors).toHaveLength(3)
    expect(advisors.at(-1)).toMatchObject({ calls: 1, inFlight: false, recentCalls: [{ at: expect.any(Number), latencyMs: expect.any(Number) }] })

    // A turn that ended with no interrupt ends a call still out the same way.
    await append($, responseRow('r3', { ...ADVISOR_CALL, id: 'srvtoolu_02' }))
    await clock.advance(1000)
    expect(frames).toHaveLength(8)
    expect(await isAdvisorDim(ui)).toBe(false)

    await $.turn.complete(MAIN_END)
    expect(advisors.at(-1)).toMatchObject({ calls: 2, inFlight: false, pendingCallId: 'srvtoolu_02' })
    expect(advisors.at(-1)).not.toHaveProperty('inFlightSince')
    expect(await isAdvisorDim(ui)).toBe(true)

    await clock.advance(1000)
    expect(frames).toHaveLength(8)
    await ui.unmount()
  })
})

describe('the activity on the pane (C7b, PRD M-L3, M-L8)', () => {
  test('the main box: dim and plain while idle; lit, bold, spinning and timed while the main loop thinks or tools; the status row says which', { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const release = holdTools(on, ['Read'])

    world(on)
    await startSession($)
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    expect(await mainLook(ui)).toEqual({ dim: true, bold: false, status: 'idle', word: 'main [--]' })

    await step($)
    expect(await mainLook(ui)).toEqual({
      dim: false,
      bold: true,
      status: expect.stringMatching(/^◐ thinking \d+s$/),
      word: 'main [opus-5-5 · high · thinking]',
    })

    const pending = readCall($)

    await clock.settle()
    expect(await mainLook(ui)).toEqual({
      dim: false,
      bold: true,
      status: expect.stringMatching(/^◐ tooling Read \d+s$/),
      word: 'main [opus-5-5 · high · tooling Read]',
    })

    // One period: the next glyph.
    await clock.advance(250)
    expect((await mainLook(ui)).status).toMatch(/^◓ tooling Read \d+s$/)

    release()
    await pending
    expect(await mainLook(ui)).toEqual({
      dim: false,
      bold: true,
      status: expect.stringMatching(/^◓ thinking \d+s$/),
      word: 'main [opus-5-5 · high · thinking]',
    })

    await $.turn.complete(MAIN_END)
    expect(await mainLook(ui)).toEqual({ dim: true, bold: false, status: 'idle', word: 'main [opus-5-5 · high]' })
    await ui.unmount()
  })

  test("subagent boxes: lit with a bold title while running, dim and plain once ended; the fan's dot steps from the first box to the last in four frames, gone once none runs", { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })

    world(on)
    await startSession($)
    await clock.settle()

    for (const id of ['a1', 'a2', 'a3']) {
      await $.agent.spawn({ ...SPAWN, tool_use_id: id, description: `task ${id}` })
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    const look = (description: string, dim: boolean) => ({ description, dim, bold: !dim, status: expect.any(String) })

    expect(await subLooks(ui)).toEqual([look('task a1', false), look('task a2', false), look('task a3', false)])

    // The fan's arrows stand over the boxes' centres; the dot is on the fan row.
    const arrows = (await ui.find({ type: 'Text', text: /^ *▼( +▼)*$/ }))?.text ?? ''
    const centres = [...arrows].flatMap((char, index) => (char === '▼' ? [index] : []))
    const seen: number[] = []

    for (let period = 0; period < 5; period += 1) {
      seen.push((await ui.find({ type: 'Text', text: /●/ }))?.text.indexOf(DOT) ?? -1)
      await clock.advance(250)
    }

    expect(centres).toHaveLength(3)
    expect(seen[0]).toBe(centres[0])
    expect((seen[0] ?? 0) < (seen[1] ?? 0) && (seen[1] ?? 0) < (seen[2] ?? 0) && (seen[2] ?? 0) < (seen[3] ?? 0)).toBe(true)
    expect(seen[3]).toBe(centres[2])
    expect(seen[4]).toBe(centres[0])

    await $.turn.complete(subagentEnd('a2'))
    expect(await subLooks(ui)).toEqual([look('task a1', false), look('task a2', true), look('task a3', false)])
    expect(await ui.find({ type: 'Text', text: /●/ })).toBeDefined()

    await $.turn.complete(subagentEnd('a1'))
    await $.turn.complete(subagentEnd('a3'))
    expect(await subLooks(ui)).toEqual([look('task a1', true), look('task a2', true), look('task a3', true)])
    expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
    await ui.unmount()
  })

  test("a running subagent's box and line name its tool in flight: a call still out before a later one that returned", async ($, on) => {
    const release = holdTools(on, ['Glob'])

    world(on)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'a1' })

    const glob = $.tool.call({ tool: 'Glob', tool_use_id: 'toolu_g1', pattern: '**/*.md', agentId: 'a1' } as never)

    await $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_g2', pattern: 'TODO', agentId: 'a1' } as never)

    // One instance per surface: the box at 100 columns on the terminal, the line at 60 on desktop.
    const wide = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })
    const narrow = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PROPS, bodyColumns: 60 } })

    expect((await subLooks(wide))[0]?.status).toMatch(/^◐ Glob\/2 \d+s$/)
    expect(await narrow.find({ type: 'Text', text: /^◐ researcher sonnet-5-5 Explore Glob\/2 \d+s$/ })).toBeDefined()

    release()
    await glob
    expect((await subLooks(wide))[0]?.status).toMatch(/^◐ Grep\/2 \d+s$/)
    expect(await narrow.find({ type: 'Text', text: /^◐ researcher sonnet-5-5 Explore Grep\/2 \d+s$/ })).toBeDefined()
    await wide.unmount()
    await narrow.unmount()
  })
})

describe('the activity through the plugin: the close-out and the writes (C7b)', () => {
  test("a main-loop call whose next(e) rejects: the rejection goes up as it came; the tree and the activity have the main loop thinking, nothing in flight; an engine call so ended fails its worker as before", async ($, on) => {
    const trees = treeWrites(on)
    const activities = activityWrites(on)

    world(on)
    // The tools beneath throw: the engine skips that hook, and the kit's bottom hook rejects the plugin's next(e).
    on('tool.call', () => {
      throw new Error('the tool beneath broke')
    })

    await step($)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'a1' })
    await expect(readCall($)).rejects.toThrow('no implementation for tool.call')

    expect(trees.at(-1)?.main).toMatchObject({ status: 'thinking', toolsRunning: 0 })
    expect(activities.at(-1)).toMatchObject({ main: { phase: 'thinking' }, calls: [] })

    await expect(
      $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: 'kimi -m kimi-code/k3 -p "do X"' } as never),
    ).rejects.toThrow('no implementation for tool.call')

    expect(trees.at(-1)?.agents.find(found => found.id === 'ext:toolu_k1')).toMatchObject({ status: 'failed' })
    expect(trees.at(-1)?.main).toMatchObject({ status: 'thinking', toolsRunning: 0 })
    expect(activities.at(-1)).toMatchObject({ main: { phase: 'thinking' }, calls: [] })

    // A subagent's call that rejects leaves the activity too, the main loop as it was.
    await expect($.tool.call({ tool: 'Grep', tool_use_id: 'toolu_s1', pattern: 'x', agentId: 'a1' } as never)).rejects.toThrow(
      'no implementation for tool.call',
    )
    expect(activities.at(-1)).toMatchObject({ main: { phase: 'thinking' }, calls: [] })

    // On the pane: thinking, not tooling.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PROPS })

    expect((await mainLook(ui)).status).toMatch(/^◐ thinking \d+s$/)
    expect(await ui.find({ type: 'Text', text: /tooling/ })).toBeUndefined()
    await ui.unmount()
  })

  test("the activity is written only when it changes: a call writes its start and its end; a subagent's request, a later request, a stop and an idle turn end write nothing", async ($, on) => {
    const activities = activityWrites(on)

    world(on)
    on('tool.call', () => OK)
    on('classic.SubagentStop', () => ({}))

    await $.agent.spawn(SPAWN)
    await step($, 'toolu_1')
    expect(activities).toHaveLength(0)

    await step($)
    await step($)
    expect(activities).toHaveLength(1)

    await readCall($)
    expect(activities).toHaveLength(3)

    await $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_s1', pattern: 'x', agentId: 'toolu_1' } as never)
    expect(activities).toHaveLength(5)
    expect(activities.slice(1).map(written => [written.main.phase, written.calls.map(entry => entry.tool).join(',')])).toEqual([
      ['tooling', 'Read'],
      ['thinking', ''],
      ['thinking', 'Grep'],
      ['thinking', ''],
    ])

    await $.classic.SubagentStop(SUBAGENT_STOP as never)
    await $.turn.complete(subagentEnd('toolu_1'))
    expect(activities).toHaveLength(5)

    await $.turn.complete(MAIN_END)
    expect(activities).toHaveLength(6)
    expect(activities.at(-1)).toMatchObject({ main: { phase: 'idle' }, calls: [] })

    await $.turn.complete(MAIN_END)
    expect(activities).toHaveLength(6)
  })
})
