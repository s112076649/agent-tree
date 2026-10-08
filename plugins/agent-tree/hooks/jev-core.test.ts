import { describe, expect, mock, test } from 'claude-code/testing'

import type { JevSnapshot, LogEntry, StatsSnapshot, TreeSnapshot } from '../types'
import {
  EMPTY_JEV,
  JEV_ENDPOINT,
  JEV_NO_KEY,
  JEV_PROMPT_VERSION,
  JEV_RECENT_TOOLS,
  JEV_RING_SIZE,
  answerLogLine,
  applyAnswers,
  applyError,
  buildRequestBody,
  buildSummary,
  callsWithinHour,
  decideFlags,
  eventsSince,
  httpErrorText,
  jevIntervalSec,
  jevMaxPerHour,
  parseAnswers,
  pushEvent,
  shouldCall,
  shouldClearRing,
} from './jev-core'
import type { JevAnswers, JevCallState, JevEvent, JevSummary } from './jev-core'
import { jevBoxRows } from './render/boxes/jev-box'
import { JEV_OFF, clockTime, probabilityBar } from './render/sections/jev'
import { geometry } from './render/layout'
import { enginesFrom, externalCallOf } from './external'
import { promptEntry, push, spawnEntry, toolEntry } from './log'
import { EMPTY_TREE, applyExternalEnd, applyExternalStart, applyToolCall, applyTurnComplete, emptyTree, upsertFromSpawn } from './tree'

const NOW = 1_790_928_100_000

const MINUTE = 60_000

const JEV_GREEN = '#56d364'

const FAIL_RED = '#f85149'

/** The key names the summary must never carry (PRD section 11). */
const FORBIDDEN_KEYS = ['path', 'content', 'prompt', 'text', 'file', 'command', 'input']

/** The answer of the C0 probe (docs/spike-report.md, "P2 Jev"), as TypeSafe sent it. */
const PROBE_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    looping: { type: 'noul', noul: 0.41 },
    stuck: { type: 'noul', noul: 0.29 },
    fanout_wide: { type: 'noul', noul: 0.09 },
    near_done: { type: 'noul', noul: 0.18 },
    health: {
      type: 'score',
      score: 0.91,
      confidence: 0.85,
      legend: {
        '0': 'healthy: work progresses with few errors',
        '1': 'needs attention: signs of repetition, errors or idle agents',
        '2': 'intervene now: stuck, looping or failing repeatedly',
      },
      probabilities: { '0': 0.09, '1': 0.91, '2': 0.0 },
    },
  },
  usage: { input_tokens: 1030, output_tokens: 87 },
}

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
  }

  return []
}

/** Every string of a JSON value, keys and values, at any depth. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap(stringsOf)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...stringsOf(inner)])
  }

  return []
}

/** The ring after `events`, oldest first. */
const ringOf = (events: readonly JevEvent[]): readonly JevEvent[] =>
  events.reduce<readonly JevEvent[]>((ring, event) => pushEvent(ring, event), [])

const tool = (agent: 'main' | 'sub', name: string, isError: boolean, at: number): JevEvent => ({
  kind: 'tool',
  agent,
  tool: name,
  isError,
  at,
})

/**
 * a1 (Explore) spawned b1; c1 failed. Descriptions and a1's last tool carry
 * paths, as real Agent calls do.
 */
function pathTree(): TreeSnapshot {
  let tree = emptyTree(NOW - 15 * MINUTE)
  tree = upsertFromSpawn(
    tree,
    { subagentType: 'Explore', description: 'Read D:\\所有项目\\secret-plan\\notes.md and C:/Users/admin/.ssh/config' },
    { agentId: 'a1', model: 'claude-sonnet-5-5' },
    NOW - 5 * MINUTE,
  )
  tree = upsertFromSpawn(
    tree,
    { subagentType: 'general-purpose', description: 'Edit /home/admin/secret-plan/app.ts', parentAgentId: 'a1' },
    { agentId: 'b1', model: 'claude-sonnet-5-5' },
    NOW - 4 * MINUTE,
  )
  tree = upsertFromSpawn(tree, { subagentType: 'Plan', description: 'Plan D:\\secret-plan\\prd.md' }, { agentId: 'c1' }, NOW - 3 * MINUTE)
  tree = applyToolCall(tree, { agentId: 'a1', tool: 'Read D:\\secret-plan\\notes.md', now: NOW - 2 * MINUTE })
  tree = applyTurnComplete(tree, { agentId: 'c1', reason: 'error', now: NOW - MINUTE })

  return { ...tree, main: { ...tree.main, model: 'claude-opus-5-5', turns: 4 } }
}

const STATS: StatsSnapshot = {
  contextTokens: 414_000,
  contextWindow: 1_000_000,
  contextPercent: 41.4,
  costUsd: 3.21,
  rateLimits: [{ kind: 'five_hour', percentUsed: 57, resetsAt: '2026-10-02T11:30:00.000Z' }],
  startedAt: NOW - 14 * MINUTE - 5000,
  updatedAt: NOW,
}

/** A prompt, then tool calls on both sides; two carry what must never be kept. */
function leakyRing(): readonly JevEvent[] {
  const extras = {
    input: { command: 'type D:\\secret-plan\\notes.md' },
    content: 'secret plan contents',
    prompt: 'read my secret plan',
    text: 'the secret answer',
    file: 'notes.md',
    path: 'D:\\secret-plan',
    command: 'rm -rf /home/admin/secret-plan',
  }
  const leakyTool: JevEvent & Record<string, unknown> = { ...tool('sub', 'Grep', true, NOW - 150_000), ...extras }
  const leakyTurn: JevEvent & Record<string, unknown> = { kind: 'turn', agent: 'sub', isError: true, at: NOW - 140_000, ...extras }

  return ringOf([
    { kind: 'prompt', agent: 'main', at: NOW - 7 * MINUTE - 1000 },
    tool('main', 'Agent', false, NOW - 300_000),
    tool('sub', 'Read', false, NOW - 240_000),
    tool('sub', 'D:\\secret-plan\\notes.md', true, NOW - 200_000),
    leakyTool,
    leakyTurn,
    tool('sub', 'Grep', true, NOW - 130_000),
  ])
}

describe('the summary sent to Jev', () => {
  test('privacy: no path, content, prompt, text, file, command or input key, and no path from the tree or the events', () => {
    const summary = buildSummary(pathTree(), STATS, leakyRing(), NOW)
    const json = JSON.stringify(summary)

    for (const key of keysOf(summary)) {
      expect(FORBIDDEN_KEYS.includes(key), `summary key ${key}`).toBe(false)
    }

    expect(json).not.toMatch(/"(path|content|prompt|text|file|command|input)"\s*:/)

    for (const fragment of ['secret', 'notes.md', 'D:', '\\', '/', 'admin', '.ssh', 'Explore', 'sonnet', 'a1']) {
      expect(json, `summary carries ${fragment}`).not.toContain(fragment)
    }

    const state = JSON.parse(buildRequestBody(summary)).state
    expect(state).toEqual(summary)

    for (const key of keysOf(state)) {
      expect(FORBIDDEN_KEYS.includes(key), `state key ${key}`).toBe(false)
    }
  })

  test('privacy: an external worker is counted, and nothing of the command that started it reaches Jev (PRD M-L1b)', () => {
    // A subagent's shell call starts Mimo: the command and the call's description carry paths.
    const command =
      'C:\\Users\\admin\\.mimocode\\bin\\mimo.exe run --dir D:\\所有项目\\secret-plan -m xiaomi/mimo-v2.6-pro --yolo -p "rewrite D:\\secret-plan\\notes.md now"'
    const worker = externalCallOf({ tool: 'PowerShell', command, description: 'Mimo rewrites C:/Users/admin/secret-plan/notes.md' }, enginesFrom(''))

    if (worker === undefined) {
      throw new Error('the command starts no engine')
    }

    expect(worker).toMatchObject({ engine: 'mimo', model: 'xiaomi/mimo-v2.6-pro', task: 'rewrite D:\\secret-plan\\notes.md now' })

    const tree = applyExternalStart(pathTree(), { ...worker, toolUseId: 'toolu_secret01', agentId: 'a1', now: NOW - MINUTE })
    const summary = buildSummary(tree, STATS, leakyRing(), NOW)
    const json = JSON.stringify(summary)
    const body = buildRequestBody(summary)

    // The tree keeps the head of the description: it is the summary that must leave it out.
    expect(tree.agents.at(-1)).toMatchObject({ id: 'ext:toolu_secret01', type: 'mimo', description: 'Mimo rewrites C:/Users/admin/secret-plan' })
    // Counted with the subagents: four, three running (a1, b1, the worker), c1 failed, the worker two deep under a1.
    expect(summary.agents).toEqual({ total: 4, running: 3, failed: 1, maxDepth: 2 })
    // And apart (C7c): two numbers, nothing else, in the summary and in the body.
    expect(Object.entries(summary.externalWorkers)).toEqual([
      ['total', 1],
      ['running', 1],
    ])
    expect(Object.entries(JSON.parse(body).state.externalWorkers)).toEqual([
      ['total', 1],
      ['running', 1],
    ])

    for (const fragment of ['secret', 'notes.md', 'D:', '\\', '/', 'admin', '.mimocode', 'mimo', 'Mimo', 'xiaomi', 'rewrite', 'ext:', 'toolu_secret01', 'a1']) {
      expect(json, `summary carries ${fragment}`).not.toContain(fragment)
    }

    for (const fragment of ['secret', 'notes.md', 'mimo', 'Mimo', 'xiaomi', 'rewrite', 'ext:', 'toolu_secret01']) {
      expect(body, `request body carries ${fragment}`).not.toContain(fragment)
    }

    // No string of the body, key or value, holds the worker's command, its model or its task, whole or in part.
    for (const fragment of [command, 'mimo.exe run', '--yolo', 'xiaomi/mimo-v2.6-pro', 'mimo-v2.6', 'rewrite D:\\secret-plan\\notes.md now', 'notes.md now']) {
      expect(stringsOf(JSON.parse(body)).filter(text => text.includes(fragment)), `request body carries ${fragment}`).toEqual([])
    }

    for (const key of keysOf(JSON.parse(body).state)) {
      expect(FORBIDDEN_KEYS.includes(key), `state key ${key}`).toBe(false)
    }
  })

  test('privacy: the session log (C7d, PRD M-L7) has no way into the request: buildSummary takes no log, and a log of distinctive hints leaves none of them in the body', () => {
    // The signatures are the proof: the tree, the stats, the whitelisted ring and the time; the body is made of the summary alone.
    expect(buildSummary.length).toBe(4)
    expect(buildRequestBody.length).toBe(1)

    // Four calls of one session, as the log and the Jev ring each take them: the log keeps the hint, the ring the tool's name only.
    const calls = [
      { tool: 'Read', file_path: 'D:\\secret-plan\\distinct-notes-7f3a.md' },
      { tool: 'Bash', command: 'distinct-command-9b2c --flag value that runs on past the fortieth character' },
      { tool: 'Grep', pattern: 'distinct-pattern-5d1e' },
      { tool: 'Agent', description: 'distinct-job-3c8f' },
    ]
    const tree = pathTree()
    let log: readonly LogEntry[] = push([], promptEntry(NOW - 10_000))
    let ring: readonly JevEvent[] = []

    calls.forEach((call, index) => {
      const at = NOW - (calls.length - index) * 1000

      log = push(log, toolEntry(tree, { tool: call.tool, input: call, isError: false }, at))
      ring = pushEvent(ring, tool('main', call.tool, false, at))
    })
    // The spawn lines carry the tree's descriptions, which hold paths.
    log = push(log, ...tree.agents.map(node => spawnEntry(tree, node, NOW)))

    // Not an empty test: the log carries the file's name alone, the command's first 40 characters, the pattern, the descriptions.
    const kept = JSON.stringify(log)

    for (const hint of ['distinct-notes-7f3a.md', 'distinct-command-9b2c --flag value that', 'distinct-pattern-5d1e', 'distinct-job-3c8f', 'secret-plan']) {
      expect(kept, `the log lacks ${hint}`).toContain(hint)
    }

    expect(kept).not.toContain('fortieth')

    const body = buildRequestBody(buildSummary(tree, STATS, ring, NOW))

    // A fifth argument would not show in `length` if it had a default: so the log passed as one changes nothing either.
    const withLog = buildSummary as (...args: unknown[]) => JevSummary

    expect(withLog(tree, STATS, ring, NOW, log)).toStrictEqual(buildSummary(tree, STATS, ring, NOW))

    for (const fragment of ['distinct', 'secret', 'notes.md', 'D:', '.ssh', '--flag', 'fortieth']) {
      expect(body, `the body carries ${fragment}`).not.toContain(fragment)
    }

    // No line of a call or a spawn is in it, whole.
    const lines = log.filter(line => line.kind === 'tool' || line.kind === 'spawn')

    expect(lines).toHaveLength(7)

    for (const line of lines) {
      expect(body, `the body carries the line ${line.text}`).not.toContain(line.text)
    }

    expect(keysOf(JSON.parse(body))).not.toContain('log')
  })

  test('externalWorkers (C7c): the external engine runs among agents, all of them and the running ones; a Claude subagent is never one', () => {
    let tree = applyExternalStart(pathTree(), { toolUseId: 'toolu_k1', engine: 'kimi', model: 'kimi-code/k3', task: 'write the tests', now: NOW - 3 * MINUTE })

    tree = applyExternalStart(tree, { toolUseId: 'toolu_c1', engine: 'codex', agentId: 'a1', now: NOW - 2 * MINUTE })
    tree = applyExternalStart(tree, { toolUseId: 'toolu_k2', engine: 'kimi', now: NOW - MINUTE })
    tree = applyExternalEnd(tree, { toolUseId: 'toolu_k1', isError: false, now: NOW - 30_000 })
    tree = applyExternalEnd(tree, { toolUseId: 'toolu_k2', isError: true, now: NOW - 20_000 })

    const summary = buildSummary(tree, STATS, [], NOW)

    // Three subagents (a1 and b1 running, c1 failed) and three engine runs (codex running, one kimi done, one failed).
    expect(summary.agents).toEqual({ total: 6, running: 3, failed: 2, maxDepth: 2 })
    expect(summary.externalWorkers).toStrictEqual({ total: 3, running: 1 })
    expect(buildSummary(pathTree(), STATS, [], NOW).externalWorkers).toStrictEqual({ total: 0, running: 0 })
  })

  test('only the whitelisted figures: counts, whole minutes, the context percent, recent tools by side and name', () => {
    const summary = buildSummary(pathTree(), STATS, leakyRing(), NOW)

    expect(summary).toStrictEqual({
      minutesActive: 14,
      turns: 4,
      contextPercent: 41,
      agents: { total: 3, running: 2, failed: 1, maxDepth: 2 },
      externalWorkers: { total: 0, running: 0 },
      recentTools: [
        { agent: 'main', tool: 'Agent', isError: false, repeatsPrevious: false },
        { agent: 'sub', tool: 'Read', isError: false, repeatsPrevious: false },
        { agent: 'sub', tool: '?', isError: true, repeatsPrevious: false },
        { agent: 'sub', tool: 'Grep', isError: true, repeatsPrevious: false },
        { agent: 'sub', tool: 'Grep', isError: true, repeatsPrevious: true },
      ],
      consecutiveErrors: 3,
      consecutiveSameTool: 2,
      minutesSinceLastTool: 2,
      minutesSinceLastUserPrompt: 7,
    })
  })

  test('before any reading the unknown figures are null, never 0', () => {
    expect(buildSummary(EMPTY_TREE, { rateLimits: [], updatedAt: 0 }, [], NOW)).toStrictEqual({
      minutesActive: null,
      turns: 0,
      contextPercent: null,
      agents: { total: 0, running: 0, failed: 0, maxDepth: 0 },
      externalWorkers: { total: 0, running: 0 },
      recentTools: [],
      consecutiveErrors: 0,
      consecutiveSameTool: 0,
      minutesSinceLastTool: null,
      minutesSinceLastUserPrompt: null,
    })
  })

  test('the latest 20 tool calls; repeats and runs are counted per side', () => {
    const events: JevEvent[] = []

    for (let index = 0; index < 25; index += 1) {
      events.push(tool('sub', index % 5 === 0 ? 'Read' : 'Grep', false, NOW - (30 - index) * 1000))
    }

    events.push(tool('main', 'Bash', true, NOW - 4000))
    events.push(tool('sub', 'Grep', true, NOW - 3000))
    events.push(tool('sub', 'Grep', true, NOW - 2000))

    const summary = buildSummary(EMPTY_TREE, STATS, ringOf(events), NOW)

    expect(summary.recentTools).toHaveLength(JEV_RECENT_TOOLS)
    expect(summary.recentTools.at(-1)).toEqual({ agent: 'sub', tool: 'Grep', isError: true, repeatsPrevious: true })
    // The main call between two sub calls does not break the sub side's repeat.
    expect(summary.recentTools.at(-2)).toEqual({ agent: 'sub', tool: 'Grep', isError: true, repeatsPrevious: true })
    expect(summary.recentTools.at(-3)).toEqual({ agent: 'main', tool: 'Bash', isError: true, repeatsPrevious: false })
    expect(summary.consecutiveErrors).toBe(3)
    // On the sub side: the two latest Grep calls, then calls 24..21 (Grep) back to call 20 (Read): 2 + 4.
    expect(summary.consecutiveSameTool).toBe(6)
    expect(summary.minutesSinceLastTool).toBe(0)
  })

  test('the request body: model, the summary as state, five questions of the right types', () => {
    const summary = buildSummary(pathTree(), STATS, leakyRing(), NOW)
    const body = JSON.parse(buildRequestBody(summary))

    expect(Object.keys(body)).toEqual(['model', 'state', 'questions'])
    expect(body.model).toBe('jev-latest')
    expect(body.state).toEqual(summary)
    expect(Object.keys(body.questions)).toEqual(['looping', 'stuck', 'fanout_wide', 'near_done', 'health'])

    for (const key of ['looping', 'stuck', 'fanout_wide', 'near_done']) {
      const question = body.questions[key]

      expect(question.type, key).toBe('noul')
      expect(question.instructions.length, key).toBeGreaterThan(10)
      expect(Object.keys(question.criteria), key).toEqual(['true', 'false'])
      expect(question.criteria.true.length, key).toBeGreaterThan(20)
      expect(question.criteria.false.length, key).toBeGreaterThan(20)
    }

    expect(body.questions.health.type).toBe('score')
    expect(body.questions.health.criteria).toHaveLength(3)
    expect(body.questions.health.criteria[0]).toMatch(/^healthy: /)
    expect(body.questions.health.criteria[1]).toMatch(/^needs attention: /)
    expect(body.questions.health.criteria[2]).toMatch(/^intervene now: /)
    expect(JEV_ENDPOINT).toBe('https://api.typesafe.ai/v1/systemone')
    // fanout_wide tells Claude subagents apart from external engine runs by the summary's two counts (C7c), so the version went up.
    expect(body.questions.fanout_wide.instructions).toContain('externalWorkers counts the engine runs among them')
    expect(body.questions.fanout_wide.criteria.true).toContain('Claude subagents run at once (agents.running minus externalWorkers.running above 4)')
    expect(body.questions.fanout_wide.criteria.true).toContain('external engine runs at once (externalWorkers.running above 4)')
    expect(body.questions.fanout_wide.criteria.false).toBe('At most three Claude subagents and at most three external engine runs run at once, and nesting stays shallow.')
    expect(JEV_PROMPT_VERSION).toBe('2')
  })

  test('the body copies the summary fields only, whatever else the object carries', () => {
    const summary = buildSummary(EMPTY_TREE, STATS, [], NOW)
    const padded = {
      ...summary,
      description: 'D:\\secret-plan',
      agents: { ...summary.agents, ids: ['a1'] },
      externalWorkers: { ...summary.externalWorkers, engines: ['kimi'], commands: ['kimi -p "fix D:\\secret-plan"'] },
      recentTools: [{ agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false, input: { file_path: 'x' } }],
    } as JevSummary

    const state = JSON.parse(buildRequestBody(padded)).state

    expect(state.description).toBeUndefined()
    expect(state.agents).toStrictEqual(summary.agents)
    expect(state.externalWorkers).toStrictEqual({ total: 0, running: 0 })
    expect(state.recentTools).toStrictEqual([{ agent: 'main', tool: 'Read', isError: false, repeatsPrevious: false }])
  })
})

describe('the event ring', () => {
  test('keeps kind, side, tool name, error flag and time; drops everything else', () => {
    const leaky = { ...tool('sub', 'Bash', true, NOW), input: { command: 'dir' }, text: 'out' } as JevEvent

    expect(pushEvent([], leaky)).toStrictEqual([{ kind: 'tool', agent: 'sub', tool: 'Bash', isError: true, at: NOW }])
    expect(pushEvent([], { kind: 'prompt', agent: 'main', at: NOW })).toStrictEqual([{ kind: 'prompt', agent: 'main', at: NOW }])
    expect(pushEvent([], { kind: 'turn', agent: 'main', at: NOW })).toStrictEqual([
      { kind: 'turn', agent: 'main', isError: false, at: NOW },
    ])
  })

  test('a name that is not a tool name (a path, a command) is kept as ?; mcp names stay', () => {
    const names = ['C:/Users/admin/notes.md', 'D:\\secret\\a.ts', 'rm -rf x', '', 'mcp__claude_ai_chatcut__apply_script']
    const ring = ringOf(names.map((name, index) => tool('main', name, false, NOW + index)))

    expect(ring.map(event => event.tool)).toEqual(['?', '?', '?', '?', 'mcp__claude_ai_chatcut__apply_script'])
    expect(pushEvent([], tool('main', 'x'.repeat(100), false, NOW))[0]?.tool).toBe('x'.repeat(64))
  })

  test('an event of no known kind or with no time changes nothing', () => {
    const ring = ringOf([tool('main', 'Read', false, NOW)])

    expect(pushEvent(ring, { kind: 'reply', agent: 'main', at: NOW } as unknown as JevEvent)).toBe(ring)
    expect(pushEvent(ring, { kind: 'tool', agent: 'main', tool: 'Read', at: Number.NaN })).toBe(ring)
  })

  test('holds the latest 50, keeping the latest prompt however many tool calls follow it', () => {
    const calls = Array.from({ length: 60 }, (_, index) => tool('main', `T${index}`, false, NOW + index))
    const ring = ringOf(calls)

    expect(ring).toHaveLength(JEV_RING_SIZE)
    expect(ring[0]?.tool).toBe('T10')
    expect(ring.at(-1)?.tool).toBe('T59')

    const withPrompt = ringOf([{ kind: 'prompt', agent: 'main', at: NOW - 10 * MINUTE }, ...calls])

    expect(withPrompt).toHaveLength(JEV_RING_SIZE)
    expect(withPrompt[0]).toStrictEqual({ kind: 'prompt', agent: 'main', at: NOW - 10 * MINUTE })
    expect(withPrompt[1]?.tool).toBe('T11')
    expect(buildSummary(EMPTY_TREE, STATS, withPrompt, NOW + 60).minutesSinceLastUserPrompt).toBe(10)
  })

  test('eventsSince counts the events after the last call; all of them before the first', () => {
    const ring = ringOf([tool('main', 'Read', false, NOW - 3000), tool('main', 'Grep', false, NOW - 1000)])

    expect(eventsSince(ring, undefined)).toBe(2)
    expect(eventsSince(ring, NOW - 2000)).toBe(1)
    expect(eventsSince(ring, NOW)).toBe(0)
  })

  test('shouldClearRing: Jev turned on (off before, or a fresh state) clears; on to on, off to off and on to off keep', () => {
    const off: JevSnapshot = { ...EMPTY_JEV, calls: 2, lastAt: NOW - MINUTE, callTimes: [NOW - 2 * MINUTE, NOW - MINUTE] }
    const on: JevSnapshot = { ...off, enabled: true }

    expect(shouldClearRing(off, true), 'off to on').toBe(true)
    expect(shouldClearRing(EMPTY_JEV, true), 'fresh state, on').toBe(true)
    expect(shouldClearRing(on, true), 'on to on').toBe(false)
    expect(shouldClearRing(off, false), 'off to off').toBe(false)
    expect(shouldClearRing(EMPTY_JEV, false), 'fresh state, off').toBe(false)
    expect(shouldClearRing(on, false), 'on to off').toBe(false)
  })
})

describe('answers', () => {
  test('parseAnswers reads the documented response: four nouls, the score with its confidence, model and tokens', () => {
    const expected: JevAnswers = {
      model: 'jev-1.13.0',
      answers: {
        looping: { type: 'noul', noul: 0.41 },
        stuck: { type: 'noul', noul: 0.29 },
        fanout_wide: { type: 'noul', noul: 0.09 },
        near_done: { type: 'noul', noul: 0.18 },
        health: { type: 'score', score: 0.91, confidence: 0.85 },
      },
      usage: { inputTokens: 1030, outputTokens: 87 },
    }

    expect(parseAnswers(JSON.stringify(PROBE_RESPONSE))).toStrictEqual(expected)
    expect(parseAnswers(PROBE_RESPONSE)).toStrictEqual(expected)
  })

  test('parseAnswers: not JSON, no answers, or nothing it asked about is undefined; odd values are clamped or left out', () => {
    expect(parseAnswers('<html>502 Bad Gateway</html>')).toBeUndefined()
    expect(parseAnswers('{"error":"unauthorized"}')).toBeUndefined()
    expect(parseAnswers({ answers: { other: { type: 'noul', noul: 0.5 } } })).toBeUndefined()
    expect(
      parseAnswers({ answers: { looping: { type: 'noul', noul: 1.7 }, stuck: { type: 'noul', noul: 'high' } } }),
    ).toStrictEqual({ answers: { looping: { type: 'noul', noul: 1 } } })
  })

  test('decideFlags: sharp at 0.84 and 0.2, split at 0.44; flags in drawing order with their labels', () => {
    const decision = decideFlags({
      answers: {
        near_done: { type: 'noul', noul: 0.2 },
        looping: { type: 'noul', noul: 0.84 },
        stuck: { type: 'noul', noul: 0.44 },
        fanout_wide: { type: 'noul', noul: 0.8 },
      },
    })

    expect(decision).toStrictEqual({
      flags: [
        { key: 'looping', label: 'looping', p: 0.84, sharp: true },
        { key: 'stuck', label: 'stuck', p: 0.44, sharp: false },
        { key: 'fanout_wide', label: 'fan-out wide', p: 0.8, sharp: true },
        { key: 'near_done', label: 'near done', p: 0.2, sharp: true },
      ],
    })
  })

  test('decideFlags: the health score (0 to 2) and low confidence under 0.3', () => {
    const answers = (score: number, confidence?: number): JevAnswers => ({
      answers: { health: confidence === undefined ? { type: 'score', score } : { type: 'score', score, confidence } },
    })

    expect(decideFlags(answers(0.91, 0.85))).toStrictEqual({ flags: [], health: 0.91, healthLowConfidence: false })
    expect(decideFlags(answers(1.4, 0.29))).toStrictEqual({ flags: [], health: 1.4, healthLowConfidence: true })
    expect(decideFlags(answers(1.4, 0.3))).toStrictEqual({ flags: [], health: 1.4, healthLowConfidence: false })
    expect(decideFlags(answers(3.5))).toStrictEqual({ flags: [], health: 2, healthLowConfidence: false })
  })

  test('applyAnswers: one more call at now, the flags and health, the error cleared', () => {
    const before: JevSnapshot = { ...EMPTY_JEV, enabled: true, calls: 2, lastAt: NOW - MINUTE, error: 'HTTP 429 rate limited' }
    const parsed = parseAnswers(PROBE_RESPONSE)

    expect(parsed).toBeDefined()

    const after = applyAnswers(before, parsed as JevAnswers, NOW)

    expect(after).toStrictEqual({
      enabled: true,
      calls: 3,
      lastAt: NOW,
      flags: [
        { key: 'looping', label: 'looping', p: 0.41, sharp: false },
        { key: 'stuck', label: 'stuck', p: 0.29, sharp: false },
        { key: 'fanout_wide', label: 'fan-out wide', p: 0.09, sharp: true },
        { key: 'near_done', label: 'near done', p: 0.18, sharp: true },
      ],
      health: 0.91,
      healthLowConfidence: false,
      inFlight: false,
    })
  })

  test('applyError: the message on one line, a bearer token masked, cut at 120; calls kept, lastAt moved', () => {
    const before: JevSnapshot = { ...EMPTY_JEV, enabled: true, calls: 2, lastAt: NOW - MINUTE }

    expect(applyError(before, httpErrorText(401), NOW)).toStrictEqual({
      enabled: true,
      calls: 2,
      lastAt: NOW,
      flags: [],
      error: 'HTTP 401 key rejected',
      inFlight: false,
    })
    expect(applyError(before, 'fetch failed\nAuthorization: Bearer not-a-real-token.123', NOW).error).toBe(
      'fetch failed Authorization: Bearer ***',
    )

    const long = applyError(before, 'x'.repeat(300), NOW).error ?? ''

    expect(long).toHaveLength(120)
    expect(long.endsWith('~')).toBe(true)
    expect(applyError(before, '', NOW).error).toBe('unknown error')
  })

  test('applyError keeps the flags, the health score and its confidence mark of the last answer; the next answer clears the error', () => {
    const parsed = parseAnswers(PROBE_RESPONSE) as JevAnswers
    const answered = applyAnswers({ ...EMPTY_JEV, enabled: true, callTimes: [NOW] }, parsed, NOW)
    const failed = applyError(answered, httpErrorText(503), NOW + MINUTE)

    expect(failed).toStrictEqual({ ...answered, lastAt: NOW + MINUTE, error: 'HTTP 503 server error' })
    expect(failed.flags.map(flag => flag.key)).toEqual(['looping', 'stuck', 'fanout_wide', 'near_done'])
    expect(failed.health).toBe(0.91)
    expect(failed.healthLowConfidence).toBe(false)
    expect(applyError({ ...answered, healthLowConfidence: true }, 'network error', NOW + MINUTE).healthLowConfidence).toBe(true)
    expect(applyAnswers(failed, parsed, NOW + 2 * MINUTE).error).toBeUndefined()
  })

  test('httpErrorText names the status and a short reason, never a body', () => {
    expect(httpErrorText(401)).toBe('HTTP 401 key rejected')
    expect(httpErrorText(429)).toBe('HTTP 429 rate limited')
    expect(httpErrorText(503)).toBe('HTTP 503 server error')
    expect(httpErrorText(418)).toBe('HTTP 418')
  })

  test('answerLogLine: the time, the count of events summarized, the build, the tokens and each figure', () => {
    expect(answerLogLine(parseAnswers(PROBE_RESPONSE) as JevAnswers, Date.UTC(2026, 9, 2, 8, 1, 43, 857), 4)).toBe(
      'jev answer at 2026-10-02T08:01:43.857Z events 4 model jev-1.13.0 in 1030 out 87 looping 0.41 stuck 0.29 fanout_wide 0.09 near_done 0.18 health 0.91 confidence 0.85',
    )
  })
})

describe('the call policy', () => {
  const DUE: JevCallState = {
    enabled: true,
    hasKey: true,
    newEventsSinceLast: 3,
    callsThisHour: 2,
    maxPerHour: 60,
    lastAt: NOW - 61_000,
    intervalSec: 60,
    now: NOW,
  }

  test('shouldCall: off, no key, no new events, interval not passed, hourly cap: no call', () => {
    expect(shouldCall({ ...DUE, enabled: false })).toBe(false)
    expect(shouldCall({ ...DUE, hasKey: false })).toBe(false)
    expect(shouldCall({ ...DUE, newEventsSinceLast: 0 })).toBe(false)
    expect(shouldCall({ ...DUE, lastAt: NOW - 59_000 })).toBe(false)
    expect(shouldCall({ ...DUE, callsThisHour: 60 })).toBe(false)
    expect(shouldCall({ ...DUE, callsThisHour: 1, maxPerHour: 1 })).toBe(false)
  })

  test('shouldCall: on, a key, new events, the interval passed, under the cap: call; the first call needs no interval', () => {
    const { lastAt: _lastAt, ...first } = DUE

    expect(shouldCall(DUE)).toBe(true)
    expect(shouldCall({ ...DUE, lastAt: NOW - 60_000 })).toBe(true)
    expect(shouldCall({ ...DUE, callsThisHour: 59 })).toBe(true)
    expect(shouldCall(first)).toBe(true)
  })

  test('shouldCall reads the options within their bounds: an interval under 15 s still waits 15 s', () => {
    expect(shouldCall({ ...DUE, intervalSec: 1, lastAt: NOW - 10_000 })).toBe(false)
    expect(shouldCall({ ...DUE, intervalSec: 1, lastAt: NOW - 15_000 })).toBe(true)
    expect(jevIntervalSec(undefined)).toBe(60)
    expect(jevIntervalSec('30')).toBe(30)
    expect(jevIntervalSec(5)).toBe(15)
    expect(jevIntervalSec(1000)).toBe(600)
    expect(jevMaxPerHour(0)).toBe(1)
    expect(jevMaxPerHour(500)).toBe(240)
    expect(jevMaxPerHour('many')).toBe(60)
  })

  test('callsWithinHour keeps the call times of the last hour', () => {
    const times = [NOW - 3_700_000, NOW - 3_600_000, NOW - 3_599_000, NOW - 10_000]

    expect(callsWithinHour(times, NOW)).toEqual([NOW - 3_599_000, NOW - 10_000])
    expect(callsWithinHour([], NOW)).toEqual([])
  })
})

describe('the Jev clock and probability bar', () => {
  test('helpers: the clock reads local time; the bar is proportional and clamped', () => {
    expect(clockTime(new Date(2026, 9, 2, 9, 5, 7).getTime())).toBe('09:05:07')
    expect(clockTime(undefined)).toBe('--:--:--')
    expect(probabilityBar(0.5, 8)).toBe('████░░░░')
    expect(probabilityBar(1.4, 4)).toBe('████')
    expect(probabilityBar(-1, 4)).toBe('░░░░')
  })
})

describe('the Jev area in the pane', () => {
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

  test('Jev on and not called yet: JEV · advisory idle, then calls 0 · waiting for events, dim green, on terminal and desktop', {
    options: { jevEnabled: true, autoOpen: false },
  }, async ($, on) => {
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })
      const waiting = await ui.find({ type: 'Text', text: 'calls 0 · waiting for events' })

      expect(waiting).toBeDefined()
      expect(waiting?.props.color).toBe(JEV_GREEN)
      expect(waiting?.props.dimColor).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'JEV · advisory' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'idle' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: JEV_OFF })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('each state draws the lines jevBoxRows counts in the Jev box, off to an error after an answer: the flags stay, the error goes below them in the fail red, and 15 body rows keep the first line and the error; on terminal and desktop', {
    options: { jevEnabled: true, autoOpen: false, refreshMs: 10_000, jevIntervalSec: 15 },
  }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    // Jev's replies in turn: a failure, the probe's answer, a failure.
    const statuses = [503, 200, 503]
    let fetches = 0

    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.log', () => ({ value: undefined }))
    on('http.fetch', () => {
      const status = statuses[fetches] ?? 503
      fetches += 1

      return {
        value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(PROBE_RESPONSE) : 'unavailable' },
      }
    })
    mock.env(on, { TYPESAFE_API_KEY: 'fake-key-for-tests-0123456789' })

    /** One main-loop turn: a prompt, then the turn's end, which asks Jev when a call is due. */
    const mainTurn = async (): Promise<void> => {
      await $.prompt.submit({ text: 'carry on', origin: { kind: 'composer' }, wait: false })
      await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-main', reason: 'answer' })
      await clock.settle()
    }

    /** One Text of a drawing: its text, color, dim and bold. */
    type Row = { text: string; color: unknown; dim: boolean; bold: boolean }

    /** The Text rows inside a drawn element, in document order. */
    const rowsIn = (node: unknown): Row[] => {
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

      return children.flatMap(rowsIn)
    }

    /** Every row the pane draws on `surface` with `bodyRows`; the Texts of its Jev box (the green border) and how many lines it has. */
    const drawn = async (surface: (typeof SURFACES)[number], bodyRows: number) => {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PROPS, scroll: { offset: 0, bodyRows } } })
      const rows = rowsIn(await ui.drawn())
      const jevBox = (await ui.findAll({ type: 'Box' })).find(box => box.props.borderColor === JEV_GREEN)
      await ui.unmount()

      return { rows, jevBox: rowsIn(jevBox), lineCount: (jevBox?.children ?? []).length }
    }

    /** The text room of the Jev box at the pane's 100 columns (the left column less its frame). */
    const JEV_BOX_WIDTH = geometry(100).columnInner

    /** The Jev box drawn (its Texts, line by line) is jevBoxRows of `expected` at the box's width, the wide box (C7c). */
    const expectArea = async (expected: JevSnapshot): Promise<void> => {
      const lines = jevBoxRows({ jev: expected, frame: 0, now: Date.now() }, JEV_BOX_WIDTH, true)
      const parts = lines.flat().map(part => ({ text: part.text, color: part.color, dim: part.dim, bold: part.bold }))

      for (const surface of SURFACES) {
        const { jevBox: area, lineCount: count } = await drawn(surface, 30)

        expect(area, surface).toStrictEqual(parts)
        expect(count, surface).toBe(lines.length)
      }
    }

    const parsed = parseAnswers(PROBE_RESPONSE) as JevAnswers
    const waiting: JevSnapshot = { ...EMPTY_JEV, enabled: true }
    const failedFirst = applyError(waiting, httpErrorText(503), NOW)
    const answered = applyAnswers(failedFirst, parsed, NOW + 16_000)
    const failedAfter = applyError(answered, httpErrorText(503), NOW + 32_000)

    // Before session.start syncs the flag: Jev off.
    await expectArea(EMPTY_JEV)

    await $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

    for (let index = 0; index < 10; index += 1) {
      await $.agent.spawn({
        tool_use_id: `a${index}`,
        prompt: 'Look around.',
        description: `task ${index}`,
        subagentType: 'Explore',
        provider: { plugin: 'engine', tier: 'core' },
        model: 'sonnet',
        parentModel: 'claude-opus-5-5',
        permissionMode: 'default',
        background: false,
        fork: false,
      })
    }

    await expectArea(waiting)

    // The first call fails: the header and the error.
    await mainTurn()
    expect(fetches).toBe(1)
    await expectArea(failedFirst)

    // Past the interval the next call answers: the header, four flags, the health row; no error.
    await clock.advance(16_000)
    await mainTurn()
    expect(fetches).toBe(2)
    await expectArea(answered)

    // The third call fails: that answer's flags and health stay, the error goes below them.
    await clock.advance(16_000)
    await mainTurn()
    expect(fetches).toBe(3)
    await expectArea(failedAfter)

    for (const surface of SURFACES) {
      const { rows, jevBox, lineCount } = await drawn(surface, 30)

      expect(rows.some(row => /^looping +█+░+ 0\.41 split$/.test(row.text)), surface).toBe(true)
      expect(rows.some(row => /^near done +█*░+ 0\.18 sharp$/.test(row.text)), surface).toBe(true)
      expect(rows.some(row => row.text === 'health 0.9 needs attention'), surface).toBe(true)
      expect(rows.find(row => row.text === 'JEV error: HTTP 503 server error')?.color, surface).toBe(FAIL_RED)

      // 30 body rows hold the 6 Jev lines (C7c: the title and idle, the calls,
      // two lines of two flags, the health, the error). 15 body rows (C7a row
      // budget): the main box, one line of subagent boxes (the latest two and
      // +8 more) and the status row come first; the Jev box gets two lines,
      // its first and, pinned below it, the error.
      const fitted = await drawn(surface, 15)

      expect(jevBox.map(row => row.text).slice(0, 2), surface).toEqual(['JEV · advisory', 'idle'])
      expect(lineCount, surface).toBe(6)
      expect(fitted.rows.length, surface).toBeLessThan(rows.length)
      expect(fitted.rows.some(row => row.text === '+8 more'), surface).toBe(true)
      expect(fitted.lineCount, surface).toBe(2)
      expect(fitted.jevBox.at(-1)?.text, surface).toBe('JEV error: HTTP 503 server error')
      expect(fitted.jevBox, surface).toStrictEqual([jevBox[0], jevBox[1], jevBox.at(-1)])
    }
  })
})
