import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentNode, JevSnapshot, LogEntry, TreeSnapshot } from '../types'
import {
  HINT_CHARS,
  MAX_LOG,
  TEXT_CHARS,
  WHO_ADVISOR,
  WHO_COLUMNS,
  WHO_JEV,
  WHO_MAIN,
  advisedEntry,
  advisingEntry,
  finishEntry,
  formatLine,
  formatLines,
  hintFor,
  jevCallingEntry,
  jevErrorEntry,
  jevOkEntry,
  logLines,
  outcomeOf,
  promptEntry,
  push,
  spawnEntry,
  toolEntry,
  turnEntry,
  whoFor,
  whoOf,
  workerEndEntries,
} from './log'
import { clockTime } from './render/sections/jev'
import { widthOf } from './render/text'
import {
  applyBackgroundTasks,
  applyExternalEnd,
  applyExternalStart,
  applyTurnComplete,
  closeForegroundExternals,
  emptyTree,
  upsertFromSpawn,
} from './tree'

/** 14:41:50 local time on 2026-10-07: the clock the log reads is local, so the tests build their times the same way. */
const AT = new Date(2026, 9, 7, 14, 41, 50).getTime()

/** A tree with subagents spawned in order, one second apart: `[id, type]`. */
function grown(spawns: readonly (readonly [string, string])[]): TreeSnapshot {
  return spawns.reduce(
    (tree, [id, subagentType], index) =>
      upsertFromSpawn(tree, { subagentType, description: `task ${id}` }, { agentId: id }, AT + index * 1000),
    emptyTree(AT),
  )
}

function nodeOf(tree: TreeSnapshot, id: string): AgentNode {
  const node = tree.agents.find(candidate => candidate.id === id)

  if (node === undefined) {
    throw new Error(`no node ${id}`)
  }

  return node
}

/** An external worker as the tree opens it: `ext:<id>`, running from AT. */
function withWorker(tree: TreeSnapshot, id: string, engine: string, extra: { background?: boolean; model?: string; task?: string } = {}) {
  return applyExternalStart(tree, { toolUseId: id, engine, ...extra, now: AT })
}

function entry(text: string, who: string = 'main', at: number = AT): LogEntry {
  return { at, who, kind: 'tool', text }
}

describe('hintFor (PRD M-L7)', () => {
  test('Read, Edit and Write give the file name only, whatever separator the path uses', () => {
    expect(hintFor('Read', { file_path: 'D:\\repo\\src\\README.md' })).toBe('README.md')
    expect(hintFor('Edit', { file_path: '/home/me/repo/src/register.tsx' })).toBe('register.tsx')
    expect(hintFor('Write', { file_path: 'C:/work\\mixed/notes.txt' })).toBe('notes.txt')
    expect(hintFor('Read', { file_path: 'bare.ts' })).toBe('bare.ts')
    expect(hintFor('Read', { file_path: '/repo/dir/' })).toBe('dir')
  })

  test('NotebookEdit reads notebook_path, not file_path', () => {
    expect(hintFor('NotebookEdit', { notebook_path: 'D:\\data\\analysis.ipynb', new_source: 'x = 1' })).toBe('analysis.ipynb')
    expect(hintFor('NotebookEdit', { file_path: '/data/other.ipynb' })).toBeUndefined()
  })

  test('Bash and PowerShell give the first 40 characters of the command: 40 stay whole, 41 are cut, a line break is a space', () => {
    const forty = '0123456789'.repeat(4)

    expect(HINT_CHARS).toBe(40)
    expect(hintFor('Bash', { command: forty })).toBe(forty)
    expect(hintFor('Bash', { command: `${forty}X` })).toBe(forty)
    expect(hintFor('PowerShell', { command: `${forty}${forty}` })).toBe(forty)
    expect(hintFor('Bash', { command: 'git status\n\nnpm test' })).toBe('git status npm test')
    expect(hintFor('Bash', { command: '  ls -la  ' })).toBe('ls -la')
  })

  test('the 40 characters of a command count characters, not columns', () => {
    expect(hintFor('Bash', { command: '修'.repeat(45) })).toBe('修'.repeat(40))
    expect(hintFor('Bash', { command: '😀'.repeat(45) })).toBe('😀'.repeat(40))
  })

  test('Grep and Glob give the pattern; Agent gives the first 40 characters of its description', () => {
    expect(hintFor('Grep', { pattern: 'shouldClearRing', path: 'src' })).toBe('shouldClearRing')
    expect(hintFor('Glob', { pattern: '**/*.test.ts' })).toBe('**/*.test.ts')
    expect(hintFor('Agent', { description: 'Review the session log wiring', prompt: 'a long prompt' })).toBe('Review the session log wiring')
    expect(hintFor('Agent', { description: `${'0123456789'.repeat(5)}` })).toBe('0123456789'.repeat(4))
  })

  test('a pattern is kept to TEXT_CHARS characters', () => {
    expect(hintFor('Grep', { pattern: 'x'.repeat(TEXT_CHARS + 30) })).toBe('x'.repeat(TEXT_CHARS))
  })

  test('any other tool, and an input that holds nothing to show, gives no hint', () => {
    expect(hintFor('WebFetch', { url: 'https://example.com/a', prompt: 'summarize' })).toBeUndefined()
    expect(hintFor('mcp__claude_ai_chatcut__apply_script', { timelineMd: 'text' })).toBeUndefined()
    expect(hintFor('Read', {})).toBeUndefined()
    expect(hintFor('Read', { file_path: '' })).toBeUndefined()
    expect(hintFor('Read', { file_path: 42 })).toBeUndefined()
    expect(hintFor('Bash', { command: '   ' })).toBeUndefined()
    expect(hintFor('Grep', null)).toBeUndefined()
    expect(hintFor('Grep', 'pattern')).toBeUndefined()
    expect(hintFor(undefined, { file_path: 'a.ts' })).toBeUndefined()
    expect(hintFor(7, { file_path: 'a.ts' })).toBeUndefined()
  })

  test('only the field of its tool is read: a hint never carries content, a prompt or a path', () => {
    const input = {
      file_path: '/secret/place/a.ts',
      content: 'SECRET-CONTENT',
      old_string: 'SECRET-OLD',
      new_string: 'SECRET-NEW',
      prompt: 'SECRET-PROMPT',
      command: 'SECRET-COMMAND',
      pattern: 'SECRET-PATTERN',
      description: 'SECRET-DESCRIPTION',
    }

    expect(hintFor('Read', input)).toBe('a.ts')
    expect(hintFor('Write', input)).toBe('a.ts')
    expect(hintFor('Grep', { ...input, pattern: 'needle' })).toBe('needle')
    expect(hintFor('WebSearch', input)).toBeUndefined()
  })
})

describe('push (PRD M-L7: a ring of 200)', () => {
  test('keeps the newest 200: the 201st line drops the oldest, line by line', () => {
    let log: LogEntry[] = []

    for (let index = 1; index <= MAX_LOG; index += 1) {
      log = push(log, entry(`line ${index}`))
    }

    expect(MAX_LOG).toBe(200)
    expect(log).toHaveLength(200)
    expect(log[0]?.text).toBe('line 1')

    log = push(log, entry('line 201'))

    expect(log).toHaveLength(200)
    expect(log[0]?.text).toBe('line 2')
    expect(log.at(-1)?.text).toBe('line 201')

    for (let index = 202; index <= 205; index += 1) {
      log = push(log, entry(`line ${index}`))
    }

    expect(log).toHaveLength(200)
    expect(log[0]?.text).toBe('line 6')
    expect(log.at(-1)?.text).toBe('line 205')
  })

  test('adds lines at the end, several at once, and leaves the log it was given as it was', () => {
    const before: LogEntry[] = [entry('one')]
    const after = push(before, entry('two'), entry('three'))

    expect(after.map(line => line.text)).toEqual(['one', 'two', 'three'])
    expect(before.map(line => line.text)).toEqual(['one'])
    expect(push(before)).toEqual(before)
  })

  test('several lines at once past the cap still keep the newest 200', () => {
    const full = Array.from({ length: MAX_LOG }, (_, index) => entry(`old ${index}`))
    const after = push(full, entry('a'), entry('b'), entry('c'))

    expect(after).toHaveLength(MAX_LOG)
    expect(after.slice(-3).map(line => line.text)).toEqual(['a', 'b', 'c'])
    expect(after[0]?.text).toBe('old 3')
  })
})

describe('who (PRD M-L7)', () => {
  test('the main loop is main; an id the tree does not hold is agent', () => {
    const tree = grown([['a1', 'Explore']])

    expect(whoFor(tree, undefined)).toBe('main')
    expect(WHO_MAIN).toBe('main')
    expect(whoFor(tree, 'ghost')).toBe('agent')
  })

  test('a subagent is its type; the second of a type is #2, the third #3, the first keeps no number for good', () => {
    const one = grown([['a1', 'Explore']])
    const two = upsertFromSpawn(one, { subagentType: 'Explore', description: 'again' }, { agentId: 'a2' }, AT + 5000)
    const three = upsertFromSpawn(two, { subagentType: 'Explore', description: 'once more' }, { agentId: 'a3' }, AT + 6000)

    expect(whoFor(one, 'a1')).toBe('Explore')
    expect(whoFor(two, 'a1')).toBe('Explore')
    expect(whoFor(two, 'a2')).toBe('Explore#2')
    expect(whoFor(three, 'a1')).toBe('Explore')
    expect(whoFor(three, 'a2')).toBe('Explore#2')
    expect(whoFor(three, 'a3')).toBe('Explore#3')
  })

  test('types are counted apart', () => {
    const tree = grown([
      ['a1', 'Explore'],
      ['a2', 'general-purpose'],
      ['a3', 'Explore'],
      ['a4', 'general-purpose'],
      ['a5', 'Plan'],
    ])

    expect(['a1', 'a2', 'a3', 'a4', 'a5'].map(id => whoFor(tree, id))).toEqual([
      'Explore',
      'general-p~',
      'Explore#2',
      'general~#2',
      'Plan',
    ])
  })

  test('a long type is cut with ~ so that its number stays inside the who column', () => {
    const tree = grown([
      ['a1', 'general-purpose'],
      ['a2', 'general-purpose'],
      ['a3', 'general-purpose'],
    ])

    expect(WHO_COLUMNS).toBe(10)
    expect(whoFor(tree, 'a1')).toBe('general-p~')
    expect(whoFor(tree, 'a2')).toBe('general~#2')
    expect(whoFor(tree, 'a3')).toBe('general~#3')
    expect(['a1', 'a2', 'a3'].every(id => widthOf(whoFor(tree, id)) <= WHO_COLUMNS)).toBe(true)
  })

  test('an external worker is its engine, counted with the subagent types', () => {
    const tree = withWorker(withWorker(grown([['a1', 'Explore']]), 't1', 'kimi'), 't2', 'kimi')

    expect(whoFor(tree, 'ext:t1')).toBe('kimi')
    expect(whoFor(tree, 'ext:t2')).toBe('kimi#2')
    expect(whoOf(tree, nodeOf(tree, 'ext:t2'))).toBe('kimi#2')
  })

  test('a subagent with no type is agent, and a line break in a type is a space', () => {
    const blank = grown([['a1', '']])
    const broken = grown([['a1', 'Code\nReviewer']])

    expect(whoFor(blank, 'a1')).toBe('agent')
    expect(whoFor(broken, 'a1')).toBe('Code Revi~')
  })
})

describe('the entry builders (PRD M-L7)', () => {
  test('a spawn is `spawn <type> <description>` by the spawned subagent, at the time of the spawn', () => {
    const tree = grown([['a1', 'Explore']])
    const line = spawnEntry(tree, nodeOf(tree, 'a1'), AT + 7)

    expect(line).toEqual({ at: AT + 7, who: 'Explore', kind: 'spawn', text: 'spawn Explore task a1' })
  })

  test('the second subagent of a type spawns as #2', () => {
    const tree = upsertFromSpawn(
      grown([['a1', 'Explore']]),
      { subagentType: 'Explore', description: 'List docs files' },
      { agentId: 'a2' },
      AT + 5000,
    )

    expect(spawnEntry(tree, nodeOf(tree, 'a2'), AT)).toEqual({
      at: AT,
      who: 'Explore#2',
      kind: 'spawn',
      text: 'spawn Explore List docs files',
    })
  })

  test('an external worker spawns as `spawn <engine> <model> <task>`, who the engine; no model, no task: the parts that are there', () => {
    const tree = withWorker(emptyTree(AT), 't1', 'kimi', { model: 'kimi-code/k3', task: 'Fix the parser' })
    const bare = withWorker(tree, 't2', 'codex')
    const modelOnly = withWorker(bare, 't3', 'grok', { model: 'grok-4' })

    expect(spawnEntry(tree, nodeOf(tree, 'ext:t1'), AT)).toEqual({
      at: AT,
      who: 'kimi',
      kind: 'spawn',
      text: 'spawn kimi kimi-code/k3 Fix the parser',
    })
    expect(spawnEntry(bare, nodeOf(bare, 'ext:t2'), AT).text).toBe('spawn codex')
    expect(spawnEntry(modelOnly, nodeOf(modelOnly, 'ext:t3'), AT).text).toBe('spawn grok grok-4')
  })

  test('a tool call is `<tool> <hint>` by the loop that ran it; a tool with no hint is its name', () => {
    const tree = grown([['a1', 'Explore']])

    expect(toolEntry(tree, { tool: 'Read', input: { file_path: 'D:\\repo\\README.md' }, isError: false }, AT)).toEqual({
      at: AT,
      who: 'main',
      kind: 'tool',
      text: 'Read README.md',
    })
    expect(
      toolEntry(tree, { agentId: 'a1', tool: 'Grep', input: { tool: 'Grep', pattern: 'shouldClearRing' }, isError: false }, AT),
    ).toEqual({ at: AT, who: 'Explore', kind: 'tool', text: 'Grep shouldClearRing' })
    expect(toolEntry(tree, { tool: 'WebFetch', input: { url: 'https://example.com' }, isError: false }, AT).text).toBe('WebFetch')
  })

  test('a tool call that failed is a fail line: `fail <tool> <hint>`', () => {
    const tree = grown([['a1', 'Explore']])

    expect(toolEntry(tree, { agentId: 'a1', tool: 'Read', input: { file_path: '/x/missing.txt' }, isError: true }, AT)).toEqual({
      at: AT,
      who: 'Explore',
      kind: 'fail',
      text: 'fail Read missing.txt',
    })
    expect(toolEntry(tree, { tool: 'WebFetch', input: {}, isError: true }, AT).text).toBe('fail WebFetch')
  })

  test('a finished run is `done <age>`; a failed one `fail`, a killed one `kill`, both fail lines', () => {
    expect(finishEntry('Explore', 'done', 151_000, AT)).toEqual({ at: AT, who: 'Explore', kind: 'done', text: 'done 2m31s' })
    expect(finishEntry('Explore', 'done', undefined, AT).text).toBe('done --')
    expect(finishEntry('kimi', 'fail', 12_000, AT)).toEqual({ at: AT, who: 'kimi', kind: 'fail', text: 'fail' })
    expect(finishEntry('kimi', 'kill', 12_000, AT)).toEqual({ at: AT, who: 'kimi', kind: 'fail', text: 'kill' })
    expect(['completed', 'failed', 'killed', 'cancelled'].map(outcomeOf)).toEqual(['done', 'fail', 'kill', 'fail'])
  })

  test('a subagent turn that ended on an answer is done with its age; any other reason is a fail', () => {
    const tree = grown([['a1', 'Explore'], ['a2', 'Plan']])
    const answered = applyTurnComplete(tree, { agentId: 'a1', reason: 'answer', durationMs: 151_000, now: AT + 151_000 })
    const aborted = applyTurnComplete(tree, { agentId: 'a2', reason: 'aborted', durationMs: 4_000, now: AT + 5_000 })

    expect(turnEntry(answered, { agentId: 'a1', reason: 'answer', durationMs: 151_000, now: AT + 151_000 })).toEqual({
      at: AT + 151_000,
      who: 'Explore',
      kind: 'done',
      text: 'done 2m31s',
    })
    expect(turnEntry(aborted, { agentId: 'a2', reason: 'aborted', durationMs: 4_000, now: AT + 5_000 })).toEqual({
      at: AT + 5_000,
      who: 'Plan',
      kind: 'fail',
      text: 'fail',
    })
  })

  test('a subagent turn for a node the tree does not hold is written by agent, the age from the event', () => {
    expect(turnEntry(emptyTree(AT), { agentId: 'ghost', reason: 'answer', durationMs: 12_000, now: AT })).toEqual({
      at: AT,
      who: 'agent',
      kind: 'done',
      text: 'done 12s',
    })
  })

  test('the main loop turn is `turn done 41s`, or `turn <reason> <age>`; no age when the event gave none', () => {
    const tree = emptyTree(AT)

    expect(turnEntry(tree, { reason: 'answer', durationMs: 41_000, now: AT })).toEqual({
      at: AT,
      who: 'main',
      kind: 'turn',
      text: 'turn done 41s',
    })
    expect(turnEntry(tree, { reason: 'aborted', durationMs: 12_000, now: AT }).text).toBe('turn aborted 12s')
    expect(turnEntry(tree, { reason: 'answer', now: AT }).text).toBe('turn done')
  })

  test('a prompt is `prompt` and nothing of what was typed', () => {
    expect(promptEntry(AT)).toEqual({ at: AT, who: 'main', kind: 'prompt', text: 'prompt' })
  })

  test('the advisor: `advising...` at the call, `advised 21.1s` at its result (no latency, none shown); who is fable', () => {
    expect(advisingEntry(AT)).toEqual({ at: AT, who: 'fable', kind: 'advisor', text: 'advising...' })
    expect(advisedEntry(21_080, AT)).toEqual({ at: AT, who: 'fable', kind: 'advisor', text: 'advised 21.1s' })
    expect(advisedEntry(undefined, AT).text).toBe('advised')
    expect(advisedEntry(Number.NaN, AT).text).toBe('advised')
    expect([WHO_ADVISOR, WHO_JEV]).toEqual(['fable', 'jev'])
  })

  test('Jev: `jev calling...`, `jev ok · calls 3`, and a failure as a fail line `jev error <what>`; who is jev', () => {
    expect(jevCallingEntry(AT)).toEqual({ at: AT, who: 'jev', kind: 'jev', text: 'jev calling...' })
    expect(jevOkEntry(3, AT)).toEqual({ at: AT, who: 'jev', kind: 'jev', text: 'jev ok · calls 3' })
    expect(jevErrorEntry('HTTP 401 key rejected', AT)).toEqual({
      at: AT,
      who: 'jev',
      kind: 'fail',
      text: 'jev error HTTP 401 key rejected',
    })
    expect(jevErrorEntry(undefined, AT).text).toBe('jev error')
    expect(jevErrorEntry('line one\nline two', AT).text).toBe('jev error line one line two')
  })

  test('a line is one line of at most TEXT_CHARS characters, whatever the event held', () => {
    const tree = grown([['a1', 'Explore']])
    const long = toolEntry(tree, { tool: 'Grep', input: { pattern: `a\nb${'x'.repeat(500)}` }, isError: false }, AT)

    expect(long.text).toMatch(/^Grep a bx+$/)
    expect(Array.from(long.text).length).toBeLessThanOrEqual(TEXT_CHARS)
    expect(long.text).not.toMatch(/[\u0000-\u001f]/)
  })
})

describe('workerEndEntries (external workers, PRD M-L1b and M-L7)', () => {
  const started = withWorker(emptyTree(AT), 't1', 'kimi', { model: 'kimi-code/k3', task: 'Fix the parser' })

  test('a foreground worker whose shell call returned is done with its age; an error result is a fail', () => {
    const returned = applyExternalEnd(started, { toolUseId: 't1', isError: false, now: AT + 130_000 })
    const failed = applyExternalEnd(started, { toolUseId: 't1', isError: true, now: AT + 3_000 })

    expect(workerEndEntries(started, returned, AT + 130_000)).toEqual([
      { at: AT + 130_000, who: 'kimi', kind: 'done', text: 'done 2m10s' },
    ])
    expect(workerEndEntries(started, failed, AT + 3_000)).toEqual([{ at: AT + 3_000, who: 'kimi', kind: 'fail', text: 'fail' }])
  })

  test('an interrupted call and the end of its loop turn kill the worker: a kill line', () => {
    const interrupted = applyExternalEnd(started, { toolUseId: 't1', isError: false, interrupted: true, now: AT + 2_000 })
    const cutOff = closeForegroundExternals(started, undefined, AT + 9_000)

    expect(workerEndEntries(started, interrupted, AT + 2_000)).toEqual([{ at: AT + 2_000, who: 'kimi', kind: 'fail', text: 'kill' }])
    expect(workerEndEntries(started, cutOff, AT + 9_000)).toEqual([{ at: AT + 9_000, who: 'kimi', kind: 'fail', text: 'kill' }])
  })

  test('a background worker runs on past its shell call, and is done when classic.Stop no longer lists its task', () => {
    const background = withWorker(emptyTree(AT), 't1', 'codex', { background: true })
    const returned = applyExternalEnd(background, { toolUseId: 't1', isError: false, taskId: 'bg-1', now: AT + 1_000 })
    const listed = applyBackgroundTasks(returned, [{ id: 'bg-1', type: 'shell', status: 'running' }], AT + 20_000)
    const gone = applyBackgroundTasks(returned, [], AT + 61_000)

    expect(workerEndEntries(background, returned, AT + 1_000)).toEqual([])
    expect(workerEndEntries(returned, listed, AT + 20_000)).toEqual([])
    expect(workerEndEntries(returned, gone, AT + 61_000)).toEqual([{ at: AT + 61_000, who: 'codex', kind: 'done', text: 'done 1m01s' }])
  })

  test('only a worker that was running before has a line: no line twice, none for a subagent, none when nothing changed', () => {
    const returned = applyExternalEnd(started, { toolUseId: 't1', isError: false, now: AT + 5_000 })
    const subagents = grown([['a1', 'Explore']])
    const finished = applyTurnComplete(subagents, { agentId: 'a1', reason: 'answer', now: AT + 5_000 })

    expect(workerEndEntries(returned, returned, AT + 6_000)).toEqual([])
    expect(workerEndEntries(started, started, AT + 6_000)).toEqual([])
    expect(workerEndEntries(subagents, finished, AT + 5_000)).toEqual([])
  })

  test('two workers of one engine are told apart in the line: kimi and kimi#2', () => {
    const two = withWorker(started, 't2', 'kimi')
    const cutOff = closeForegroundExternals(two, undefined, AT + 4_000)

    expect(workerEndEntries(two, cutOff, AT + 4_000).map(line => line.who)).toEqual(['kimi', 'kimi#2'])
  })
})

describe('the line as the log box draws it (PRD M-L7: `HH:mm:ss  who  text`)', () => {
  test('formatLine is the time, two blanks, the who, two blanks, the text', () => {
    expect(clockTime(AT)).toBe('14:41:50')
    expect(formatLine(entry('Read README.md'), 80)).toBe('14:41:50  main  Read README.md')
    expect(formatLine({ at: AT, who: 'Explore#2', kind: 'fail', text: 'fail Read x.ts' }, 80)).toBe(
      '14:41:50  Explore#2  fail Read x.ts',
    )
  })

  test('formatLines pads the who column to the widest who shown', () => {
    const lines = formatLines([entry('Read README.md'), entry('Grep shouldClearRing', 'Explore')], 80)

    expect(lines).toEqual([
      `14:41:50  ${'main'.padEnd(7)}  Read README.md`,
      `14:41:50  ${'Explore'.padEnd(7)}  Grep shouldClearRing`,
    ])
  })

  test('the widest who counts only the lines shown, and never more than 10 columns', () => {
    const shown = formatLines([entry('a'), entry('b', 'fable')], 80)
    const wide = formatLines([entry('a'), entry('b', 'a-type-name-far-too-long')], 80)

    expect(shown[0]).toBe(`14:41:50  ${'main'.padEnd(5)}  a`)
    expect(wide[0]).toBe(`14:41:50  ${'main'.padEnd(WHO_COLUMNS)}  a`)
    expect(wide[1]).toBe('14:41:50  a-type-na~  b')
  })

  test('a line is clipped to the width with ~, the text giving way', () => {
    const line = entry('Grep a-very-long-pattern-that-does-not-fit-in-the-box')
    const whole = formatLine(line, 200)

    expect(formatLine(line, widthOf(whole))).toBe(whole)
    expect(formatLine(line, 30)).toBe(`${whole.slice(0, 29)}~`)
    expect(widthOf(formatLine(line, 30))).toBe(30)
    expect(widthOf(formatLine(line, 40))).toBe(40)
  })

  test('a CJK character takes two columns when the line is clipped', () => {
    const line = entry('读取文件说明')

    expect(formatLine(line, 80)).toBe('14:41:50  main  读取文件说明')
    expect(formatLine(line, 24)).toBe('14:41:50  main  读取文~')
    expect(widthOf(formatLine(line, 24))).toBeLessThanOrEqual(24)
  })

  test('a line with no text has no trailing blanks', () => {
    expect(formatLine(entry(''), 80)).toBe('14:41:50  main')
  })

  test('logLines hands the box the time and the body apart: the body is who and text clipped to what the time leaves', () => {
    const [first, second] = logLines([entry('Read README.md'), entry('Grep shouldClearRing', 'Explore')], 24)

    expect(first?.entry.text).toBe('Read README.md')
    expect(first?.time).toBe('14:41:50')
    expect(first?.body).toBe('main     Read~')
    expect(second?.body).toBe('Explore  Grep~')
    expect(logLines([entry('Read README.md')], 80)[0]?.body).toBe('main  Read README.md')
    expect(logLines([], 80)).toEqual([])
  })

  test('the who column can be fixed instead of read off the lines', () => {
    expect(formatLine(entry('x'), 80, 10)).toBe(`14:41:50  ${'main'.padEnd(10)}  x`)
    expect(logLines([entry('x')], 80, 6)[0]?.body).toBe(`${'main'.padEnd(6)}  x`)
  })

  test('an entry with no usable time is drawn with the dashes the other boxes use', () => {
    expect(formatLine({ at: Number.NaN, who: 'main', kind: 'tool', text: 'x' }, 80)).toBe('--:--:--  main  x')
  })
})

// Through the plugin (C7d): each event's line, in the one write the event
// makes after its own, with the kit's world beneath the plugin.

const T = 1_790_928_100_000

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

const OK = { result: undefined as never, text: 'ok' }

/** What the person typed and what a tool touched: only the file's name may reach the log, and the prompt not at all. */
const SECRET_PATH = 'D:\\secret-plan\\notes.md'
const SECRET_PROMPT = 'read my secret plan and fix it'

/** 41 characters: the log keeps the first 40. */
const LONG_COMMAND = 'npm test -- --reporter=verbose --coverage'

/** An engine call of exactly 40 characters. */
const KIMI = 'kimi -m kimi-code/k3 -p "Fix the parser"'

const MAIN_END = { answer: 'done', durationMs: 41_000, isAborted: false, turnId: 't1', reason: 'answer' as const }

const subagentEnd = (agentId: string) => ({
  answer: '',
  durationMs: 1000,
  isAborted: false,
  turnId: `t-${agentId}`,
  agentId,
  reason: 'answer' as const,
})

/** What the shell beneath answers a background start: at once, with the task id the command goes on running as. */
const started = (taskId: string) => ({
  result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId } as never,
  text: 'started',
})

/** A stop of the main loop and of a subagent, as the engine hands them over; a test adds the list of background work in flight. */
const STOP = { stop_hook_active: false, transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--repo\\0f7c.jsonl' } as const

const SUBAGENT_STOP = {
  stop_hook_active: false,
  agent_id: 'a1',
  agent_transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--repo\\0f7c\\subagents\\agent-a1.jsonl',
  agent_type: 'general-purpose',
} as const

/** A shell task of the session's work in flight, as a stop lists it. */
const shellTask = (id: string) => ({ id, type: 'shell', status: 'running', description: 'Fix the parser', command: KIMI })

const startSession = ($: Engine) => $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

/** The world beneath the plugin: the pane opens drawn, subagents start, the person's prompt and the turns pass. */
function world(on: On): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
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

/** Every `log` write that landed, in order, seen from beneath the plugin: the last one is the log as it stands. */
function logWrites(on: On): LogEntry[][] {
  const writes: LogEntry[][] = []

  on('state.set', { plugin: 'agent-tree', key: 'log' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push([...(e.value as LogEntry[])])
    }

    return written
  })

  return writes
}

/** The key of every write of the plugin's that landed, in order: which atom an event wrote, and after which. */
function keysWritten(on: On): string[] {
  const keys: string[] = []

  on('state.set', async ($, e, next) => {
    const written = await next(e)

    if (e.plugin === 'agent-tree' && written.value?.isSet === true) {
      keys.push(e.key)
    }

    return written
  })

  return keys
}

/** A log as `who | text` lines. */
const shape =(log: readonly LogEntry[] | undefined): string[] | undefined => log?.map(line => `${line.who} | ${line.text}`)

describe('the log through the plugin (C7d, PRD M-L7)', () => {
  test('one line per event, in order, each in one write: a prompt, a spawn, a call of the main loop and of a subagent, a failed call, the subagent\'s end, the turn\'s end', async ($, on) => {
    const writes = logWrites(on)

    world(on)
    on('tool.call', (_engine, e) => (e.tool === 'Bash' ? { isError: true, result: 'exit 1' as never, text: 'exit 1' } : OK))

    const before = Date.now()

    await startSession($)
    expect(writes).toHaveLength(0)

    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'a1' })
    await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: SECRET_PATH } as never)
    await $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_g1', pattern: 'shouldClearRing', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b1', command: LONG_COMMAND } as never)
    await $.turn.complete(subagentEnd('a1'))
    await $.turn.complete(MAIN_END)

    const log = writes.at(-1) ?? []

    expect(LONG_COMMAND).toHaveLength(41)
    expect(writes.map(written => written.length)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(shape(log)).toEqual([
      'main | prompt',
      'Explore | spawn Explore List docs files',
      'main | Read notes.md',
      'Explore | Grep shouldClearRing',
      `main | fail Bash ${LONG_COMMAND.slice(0, 40)}`,
      'Explore | done 1s',
      'main | turn done 41s',
    ])
    expect(log.map(line => line.kind)).toEqual(['prompt', 'spawn', 'tool', 'tool', 'fail', 'done', 'turn'])

    // On the clock the pane is drawn on, in order.
    const after = Date.now()

    expect(log.every((line, index) => line.at >= before && line.at <= after && line.at >= (log[index - 1]?.at ?? 0))).toBe(true)

    // The path's name only, never its directory; the prompt's words nowhere.
    const text = JSON.stringify(writes)

    for (const fragment of ['secret', 'D:', SECRET_PROMPT, 'fix it']) {
      expect(text, `the log carries ${fragment}`).not.toContain(fragment)
    }
  })

  test('a second subagent of one type is told apart in every line it writes: Explore, Explore#2; a loop the tree does not know is agent', async ($, on) => {
    const writes = logWrites(on)

    world(on)
    on('tool.call', () => OK)

    await $.agent.spawn({ ...SPAWN, tool_use_id: 'a1' })
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'a2', description: 'List src files' })
    await $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_g1', pattern: 'one', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_g2', pattern: 'two', agentId: 'a2' } as never)
    await $.tool.call({ tool: 'Glob', tool_use_id: 'toolu_g3', pattern: '**/*.ts', agentId: 'ghost' } as never)
    await $.turn.complete(subagentEnd('a2'))

    expect(shape(writes.at(-1))).toEqual([
      'Explore | spawn Explore List docs files',
      'Explore#2 | spawn Explore List src files',
      'Explore | Grep one',
      'Explore#2 | Grep two',
      'agent | Glob **/*.ts',
      'Explore#2 | done 1s',
    ])
  })

  test('a denied call is a fail line, an engine call that fails too; a call whose next(e) rejects writes no call line, an engine call so ended a fail line after its spawn', async ($, on) => {
    const writes = logWrites(on)
    let mode: 'deny' | 'reject' = 'deny'

    world(on)
    on('tool.call', () => {
      if (mode === 'reject') {
        throw new Error('the tool beneath broke')
      }

      return { deny: 'refused by the test' }
    })

    await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: 'D:/repo/README.md' } as never)
    expect(shape(writes.at(-1))).toEqual(['main | fail Read README.md'])
    expect(writes.at(-1)?.map(line => line.kind)).toEqual(['fail'])

    mode = 'reject'
    await expect($.tool.call({ tool: 'Read', tool_use_id: 'toolu_r2', file_path: 'D:/repo/other.md' } as never)).rejects.toThrow(
      'no implementation for tool.call',
    )
    expect(writes).toHaveLength(1)

    await expect($.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: KIMI } as never)).rejects.toThrow(
      'no implementation for tool.call',
    )
    expect(shape(writes.at(-1))).toEqual([
      'main | fail Read README.md',
      'kimi | spawn kimi kimi-code/k3 Fix the parser',
      'kimi | fail',
    ])
    expect(writes).toHaveLength(3)
  })

  test("an engine call: its spawn line while it runs, then the call's line and the worker's end in one write", async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = logWrites(on)
    const release = holdTools(on, ['Bash'])

    world(on)
    await startSession($)

    const pending = $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: KIMI } as never)

    await clock.settle()
    expect(KIMI).toHaveLength(40)
    expect(shape(writes.at(-1))).toEqual(['kimi | spawn kimi kimi-code/k3 Fix the parser'])
    expect(writes).toHaveLength(1)

    release()
    await pending

    expect(writes).toHaveLength(2)
    expect(shape(writes.at(-1))).toEqual([
      'kimi | spawn kimi kimi-code/k3 Fix the parser',
      `main | Bash ${KIMI}`,
      expect.stringMatching(/^kimi \| done \d+s$/),
    ])
    expect(writes.at(-1)?.map(line => line.kind)).toEqual(['spawn', 'tool', 'done'])
  })

  test("the end of the turn kills an engine call still out: a kill line in the turn's write; the late return adds only the call's line", async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = logWrites(on)
    const release = holdTools(on, ['Bash'])

    world(on)
    await startSession($)

    const pending = $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: KIMI } as never)

    await clock.settle()
    await $.turn.complete(MAIN_END)

    expect(writes).toHaveLength(2)
    expect(shape(writes.at(-1))).toEqual(['kimi | spawn kimi kimi-code/k3 Fix the parser', 'main | turn done 41s', 'kimi | kill'])
    expect(writes.at(-1)?.map(line => line.kind)).toEqual(['spawn', 'turn', 'fail'])

    release()
    await pending

    expect(writes).toHaveLength(3)
    expect(shape(writes.at(-1))?.slice(3)).toEqual([`main | Bash ${KIMI}`])
  })

  test('a background engine call goes on past its call: its end line comes when classic.Stop no longer lists its task, one write after the tree\'s, once', async ($, on) => {
    const writes = logWrites(on)
    const keys = keysWritten(on)

    world(on)
    on('tool.call', () => started('task-7'))
    on('classic.Stop', () => ({}))

    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: KIMI, run_in_background: true } as never)

    // The spawn line, then the call's line alone: the worker is still out.
    expect(writes).toHaveLength(2)
    expect(shape(writes.at(-1))).toEqual(['kimi | spawn kimi kimi-code/k3 Fix the parser', `main | Bash ${KIMI}`])

    // Its task still listed and running, or no list at all: nothing is written, the log neither.
    await $.classic.Stop({ ...STOP, background_tasks: [shellTask('task-7')] } as never)
    await $.classic.Stop(STOP as never)
    expect(writes).toHaveLength(2)

    // No longer listed: the tree, then one log write with the worker's end line.
    const before = keys.length

    await $.classic.Stop({ ...STOP, background_tasks: [] } as never)
    expect(keys.slice(before)).toEqual(['tree', 'log'])
    expect(writes).toHaveLength(3)
    expect(shape(writes.at(-1))).toEqual([
      'kimi | spawn kimi kimi-code/k3 Fix the parser',
      `main | Bash ${KIMI}`,
      expect.stringMatching(/^kimi \| done \d+s$/),
    ])
    expect(writes.at(-1)?.map(line => line.kind)).toEqual(['spawn', 'tool', 'done'])

    // Closed: a second stop that lists nothing has nothing to close, and writes nothing.
    await $.classic.Stop({ ...STOP, background_tasks: [] } as never)
    expect(writes).toHaveLength(3)
    expect(keys.slice(before)).toEqual(['tree', 'log'])
  })

  test('classic.SubagentStop closes a background engine call in the log the same way, once', async ($, on) => {
    const writes = logWrites(on)
    const keys = keysWritten(on)

    world(on)
    on('tool.call', () => started('task-7'))
    on('classic.SubagentStop', () => ({}))

    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: KIMI, run_in_background: true } as never)
    expect(writes).toHaveLength(2)

    await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: [shellTask('task-7')] } as never)
    await $.classic.SubagentStop(SUBAGENT_STOP as never)
    expect(writes).toHaveLength(2)

    const before = keys.length

    await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: [] } as never)
    expect(keys.slice(before)).toEqual(['tree', 'log'])
    expect(writes).toHaveLength(3)
    expect(shape(writes.at(-1))?.slice(2)).toEqual([expect.stringMatching(/^kimi \| done \d+s$/)])
    expect(writes.at(-1)?.at(-1)?.kind).toBe('done')

    await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: [] } as never)
    expect(writes).toHaveLength(3)
  })

  test('a stop writes the end line of the workers it closed only: kimi is done while kimi#2 is still listed, and kimi#2 at the next stop', async ($, on) => {
    const writes = logWrites(on)

    world(on)
    on('tool.call', (_engine, e) => started(e.tool_use_id === 'toolu_k1' ? 'task-1' : 'task-2'))
    on('classic.Stop', () => ({}))

    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: KIMI, run_in_background: true } as never)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k2', command: KIMI, run_in_background: true } as never)
    expect(shape(writes.at(-1))).toEqual([
      'kimi | spawn kimi kimi-code/k3 Fix the parser',
      `main | Bash ${KIMI}`,
      'kimi#2 | spawn kimi kimi-code/k3 Fix the parser',
      `main | Bash ${KIMI}`,
    ])

    await $.classic.Stop({ ...STOP, background_tasks: [shellTask('task-2')] } as never)
    expect(writes).toHaveLength(5)
    expect(shape(writes.at(-1))?.slice(4)).toEqual([expect.stringMatching(/^kimi \| done \d+s$/)])

    await $.classic.Stop({ ...STOP, background_tasks: [] } as never)
    expect(writes).toHaveLength(6)
    expect(shape(writes.at(-1))?.slice(5)).toEqual([expect.stringMatching(/^kimi#2 \| done \d+s$/)])
  })

  test('the ring keeps the newest 200 lines, one write a call', async ($, on) => {
    const writes = logWrites(on)

    world(on)
    on('tool.call', () => OK)

    for (let index = 1; index <= 205; index += 1) {
      await $.tool.call({ tool: 'Read', tool_use_id: `toolu_${index}`, file_path: `D:/repo/f${index}.ts` } as never)
    }

    expect(writes).toHaveLength(205)
    expect(writes.at(-1)).toHaveLength(200)
    expect(writes.at(-1)?.[0]?.text).toBe('Read f6.ts')
    expect(writes.at(-1)?.at(-1)?.text).toBe('Read f205.ts')
  })

  test('session.start leaves the log as it is, and writes nothing to it; the pane draws from it and writes nothing to it', async ($, on) => {
    const writes = logWrites(on)

    world(on)
    on('tool.call', () => OK)

    await startSession($)
    await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: 'D:/repo/README.md' } as never)
    expect(writes).toHaveLength(1)

    await startSession($)
    expect(writes).toHaveLength(1)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: PROPS })

      await ui.unmount()
    }

    expect(writes).toHaveLength(1)
    expect(shape(writes.at(-1))).toEqual(['main | Read README.md'])
  })
})

// The advisor's lines (C7d): the append rows of the main loop's calls.

const CALL = { type: 'server_tool_use', id: 'srvtoolu_01', name: 'advisor', input: {} }
const RESULT = {
  type: 'advisor_tool_result',
  tool_use_id: 'srvtoolu_01',
  content: { type: 'advisor_redacted_result', encrypted_content: 'Et8KCioIFBgC' },
}
const TEXT = { type: 'text', text: 'Adding a nullable column is safer.' }

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

/** Raises a response row as the query loop does; the kit's `no implementation` once the hooks above ran is expected. */
async function append($: Engine, row: ReturnType<typeof responseRow>): Promise<void> {
  await $.session.append(row).catch((error: unknown) => {
    if (!String(error).includes('no implementation for session.append')) {
      throw error
    }
  })
}

describe('the advisor in the log through the plugin (C7d, PRD M-L7)', () => {
  test('a call is `advising...` at its server_tool_use block and `advised <latency>` at its result, who fable; a block seen again, a text row and a subagent\'s call add nothing', async ($, on) => {
    const writes = logWrites(on)

    await append($, responseRow('r2', CALL))
    expect(shape(writes.at(-1))).toEqual(['fable | advising...'])
    expect(writes).toHaveLength(1)

    await append($, responseRow('r2', CALL))
    await append($, responseRow('r4', TEXT))
    await append($, responseRow('s1', { ...CALL, id: 'srvtoolu_02' }, 'a855975fcff9c0909'))
    expect(writes).toHaveLength(1)

    await append($, responseRow('r3', RESULT))
    expect(writes).toHaveLength(2)
    expect(shape(writes.at(-1))).toEqual(['fable | advising...', expect.stringMatching(/^fable \| advised \d+\.\ds$/)])
    expect(writes.at(-1)?.map(line => line.kind)).toEqual(['advisor', 'advisor'])

    await append($, responseRow('r3', RESULT))
    expect(writes).toHaveLength(2)
  })

  test('a result whose start the plugin did not see is `advised` with no latency', async ($, on) => {
    const writes = logWrites(on)

    await append($, responseRow('r3', RESULT))
    expect(shape(writes.at(-1))).toEqual(['fable | advised'])
  })
})

// Jev's lines (C7d): the claim, and the answer or the failure.

/** Not a real key: what `$.env.get('TYPESAFE_API_KEY')` answers in these tests. */
const KEY = 'fake-key-for-tests-0123456789'

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

const answered = (status: number, text: string) => ({
  value: { status, ok: status >= 200 && status < 300, headers: {}, text },
})

/** Jev on, the slowest refresh, the pane left closed. */
const JEV_ON = { jevEnabled: true, autoOpen: false, refreshMs: 10_000 } as const

/** One main-loop turn: a prompt, a Read, the turn's end (which asks Jev when due). */
async function mainTurn($: Engine): Promise<void> {
  await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: SECRET_PATH } as never)
  await $.turn.complete({ ...MAIN_END, durationMs: 1000 })
}

describe('Jev in the log through the plugin (C7d, PRD M-L7)', () => {
  test('a call: `jev calling...` at the claim, `jev ok · calls 1` at its answer, each in a write of its own after the turn\'s lines', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = logWrites(on)

    world(on)
    on('tool.call', () => OK)
    on('http.fetch', () => answered(200, JSON.stringify(PROBE_RESPONSE)))
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()

    expect(shape(writes.at(-1))).toEqual([
      'main | prompt',
      'main | Read notes.md',
      'main | turn done 1s',
      'jev | jev calling...',
      'jev | jev ok · calls 1',
    ])
    expect(writes.at(-1)?.map(line => line.kind)).toEqual(['prompt', 'tool', 'turn', 'jev', 'jev'])
    expect(writes).toHaveLength(5)
    expect(JSON.stringify(writes)).not.toContain(KEY)
  })

  test('a failure is a fail line with the error the Jev box shows: `jev error HTTP 401 key rejected`, never the body', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = logWrites(on)

    world(on)
    on('tool.call', () => OK)
    on('http.fetch', () => answered(401, '{"error":"invalid key","detail":"sk-leaked-detail"}'))
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await clock.settle()

    expect(shape(writes.at(-1))?.slice(3)).toEqual(['jev | jev calling...', 'jev | jev error HTTP 401 key rejected'])
    expect(writes.at(-1)?.map(line => line.kind).slice(3)).toEqual(['jev', 'fail'])
    expect(JSON.stringify(writes)).not.toContain('sk-leaked-detail')
  })

  test('a throw after the claim (the tree read refused): the catch ends the call in the log too, `jev error call failed`', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = logWrites(on)
    let isRefusingTree = false

    world(on)
    on('tool.call', () => OK)
    on('http.fetch', () => answered(200, JSON.stringify(PROBE_RESPONSE)))

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
    await mainTurn($)
    await clock.settle()

    expect(isRefusingTree).toBe(true)
    expect(shape(writes.at(-1))?.slice(3)).toEqual(['jev | jev calling...', 'jev | jev error call failed'])
    expect(writes.at(-1)?.map(line => line.kind).slice(3)).toEqual(['jev', 'fail'])
  })

  test('Jev off: no line of its own, however many turns', async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = logWrites(on)

    world(on)
    on('tool.call', () => OK)
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await mainTurn($)
    await mainTurn($)
    await clock.settle()

    expect(writes.at(-1)?.some(line => line.who === 'jev')).toBe(false)
    expect(writes.at(-1)).toHaveLength(6)
  })

  test('privacy (PRD section 11): the log holds the hints of a session (a file name, a command, a pattern, a description) and the POST to Jev carries none of them', {
    options: JEV_ON,
  }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const writes = logWrites(on)
    const bodies: string[] = []

    world(on)
    on('tool.call', () => OK)
    on('http.fetch', (_engine, e) => {
      bodies.push(e.init?.body ?? '')

      return answered(200, JSON.stringify(PROBE_RESPONSE))
    })
    mock.env(on, { TYPESAFE_API_KEY: KEY })
    await startSession($)
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'a1', description: 'distinct-job-3c8f' })
    await $.prompt.submit({ text: SECRET_PROMPT, origin: { kind: 'composer' }, wait: false })
    await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: 'D:\\secret-plan\\distinct-notes-7f3a.md' } as never)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b1', command: 'distinct-command-9b2c --flag value', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_g1', pattern: 'distinct-pattern-5d1e' } as never)
    await $.turn.complete({ ...MAIN_END, durationMs: 1000 })
    await clock.settle()

    // The test is not empty: the log carries every hint.
    const log = JSON.stringify(writes.at(-1))

    for (const hint of ['distinct-job-3c8f', 'distinct-notes-7f3a.md', 'distinct-command-9b2c --flag value', 'distinct-pattern-5d1e']) {
      expect(log, `the log lacks ${hint}`).toContain(hint)
    }

    // Jev was asked once, and the POST has none of them: the summary is made of counts and tool names.
    expect(bodies).toHaveLength(1)

    for (const fragment of ['distinct', 'secret', 'D:', SECRET_PROMPT, KEY]) {
      expect(bodies[0], `the POST carries ${fragment}`).not.toContain(fragment)
    }

    // No line of a call or a spawn, whole, is in it either.
    const lines = (writes.at(-1) ?? []).filter(line => line.kind === 'tool' || line.kind === 'spawn')

    expect(lines).toHaveLength(4)

    for (const line of lines) {
      expect(bodies[0], `the POST carries the line ${line.text}`).not.toContain(line.text)
    }
  })
})
