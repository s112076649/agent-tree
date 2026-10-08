import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentNode, TreeSnapshot } from '../types'
import {
  EMPTY_TREE,
  MAX_AGENTS,
  applyAgentList,
  applyBackgroundTasks,
  applyExternalEnd,
  applyExternalStart,
  applyMain,
  applyStep,
  applyToolCall,
  applyToolDone,
  applyTurnComplete,
  closeForegroundExternals,
  countRunning,
  emptyTree,
  externalId,
  flatten,
  upsertFromSpawn,
} from './tree'
import type { BackgroundTask, ExternalStart } from './tree'

const T0 = 1_790_928_000_000

const EXPLORE = { subagentType: 'Explore', description: 'List docs files', model: 'sonnet', background: false }

/** A tree with spawns in order: `[id, parentId?]`, one second apart. */
function grown(spawns: readonly (readonly [string, string?])[]): TreeSnapshot {
  return spawns.reduce(
    (tree, [id, parentAgentId], index) =>
      upsertFromSpawn(
        tree,
        { ...EXPLORE, description: `task ${id}`, ...(parentAgentId === undefined ? {} : { parentAgentId }) },
        { agentId: id, model: 'claude-sonnet-5-5' },
        T0 + index * 1000,
      ),
    emptyTree(T0),
  )
}

describe('emptyTree', () => {
  test('starts idle with no agents', () => {
    expect(emptyTree(T0)).toEqual({ main: { turns: 0, status: 'idle' }, agents: [], updatedAt: T0 })
    expect(EMPTY_TREE.updatedAt).toBe(0)
    expect(EMPTY_TREE.main.model).toBeUndefined()
  })
})

describe('upsertFromSpawn', () => {
  test('opens a running node from the spawn, preferring the resolved model', () => {
    const tree = upsertFromSpawn(
      emptyTree(T0),
      { ...EXPLORE, background: true, parentAgentId: 'p1' },
      { agentId: 'a1', model: 'claude-sonnet-5-5' },
      T0 + 5,
    )

    expect(tree.agents).toEqual([
      {
        id: 'a1',
        parentId: 'p1',
        type: 'Explore',
        description: 'List docs files',
        role: 'researcher',
        model: 'claude-sonnet-5-5',
        status: 'running',
        background: true,
        toolCalls: 0,
        startedAt: T0 + 5,
      },
    ])
    expect(tree.updatedAt).toBe(T0 + 5)
  })

  test('falls back to the requested model, and ignores a denied spawn', () => {
    const tree = upsertFromSpawn(emptyTree(T0), EXPLORE, { agentId: 'a1' }, T0)

    expect(tree.agents[0]?.model).toBe('sonnet')
    expect(upsertFromSpawn(tree, EXPLORE, {}, T0 + 1)).toBe(tree)
  })

  test('merges into a node the agent list added first, keeping one row per id', () => {
    const listed = applyAgentList(
      emptyTree(T0),
      [{ id: 'a1', description: 'List docs files', type: 'Explore', status: 'running' }],
      T0 + 10,
    )
    const tree = upsertFromSpawn(listed, EXPLORE, { agentId: 'a1', model: 'claude-sonnet-5-5' }, T0 + 20)

    expect(tree.agents).toHaveLength(1)
    expect(tree.agents[0]).toMatchObject({ id: 'a1', model: 'claude-sonnet-5-5', status: 'running', startedAt: T0 + 10 })
  })

  test(`keeps at most ${MAX_AGENTS} nodes, dropping the oldest finished ones first`, () => {
    let tree = emptyTree(T0)

    for (let index = 0; index < MAX_AGENTS + 5; index += 1) {
      tree = upsertFromSpawn(tree, EXPLORE, { agentId: `a${index}` }, T0 + index)
      tree = index === 0 ? tree : applyTurnComplete(tree, { agentId: `a${index}`, reason: 'answer', now: T0 + index })
    }

    expect(tree.agents).toHaveLength(MAX_AGENTS)
    // a0 never finished: it stays although it is the oldest.
    expect(tree.agents.some(node => node.id === 'a0')).toBe(true)
    expect(tree.agents.some(node => node.id === 'a1')).toBe(false)
    expect(tree.agents.some(node => node.id === `a${MAX_AGENTS + 4}`)).toBe(true)
  })
})

describe('applyAgentList', () => {
  test('overrides the status of listed ids and closes them with an end time', () => {
    const tree = applyAgentList(
      grown([['a1'], ['a2']]),
      [
        { id: 'a1', description: 'task a1', type: 'Explore', status: 'completed' },
        { id: 'a2', description: 'task a2', type: 'Explore', status: 'running' },
      ],
      T0 + 9000,
    )

    expect(tree.agents.map(node => [node.id, node.status, node.endedAt])).toEqual([
      ['a1', 'completed', T0 + 9000],
      ['a2', 'running', undefined],
    ])
  })

  test('adds ids it does not know, with their parent', () => {
    const tree = applyAgentList(
      grown([['a1']]),
      [{ id: 'b1', description: 'teammate work', type: 'teammate', status: 'running', parentId: 'a1' }],
      T0 + 3000,
    )

    expect(tree.agents.find(node => node.id === 'b1')).toEqual({
      id: 'b1',
      parentId: 'a1',
      type: 'teammate',
      description: 'teammate work',
      role: 'worker',
      status: 'running',
      toolCalls: 0,
      startedAt: T0 + 3000,
    })
  })

  test('keeps the ledger status of ids it no longer lists (finished foreground agents vanish)', () => {
    const finished = applyTurnComplete(grown([['a1'], ['a2']]), { agentId: 'a1', reason: 'answer', now: T0 + 5000 })
    const tree = applyAgentList(finished, [], T0 + 6000)

    expect(tree).toBe(finished)
    expect(tree.agents.map(node => node.status)).toEqual(['completed', 'running'])
  })

  test('returns the same tree when nothing changed', () => {
    const tree = grown([['a1']])

    expect(applyAgentList(tree, [{ id: 'a1', description: 'task a1', type: 'Explore', status: 'running' }], T0 + 1)).toBe(
      tree,
    )
  })
})

describe('applyStep and applyMain', () => {
  test('a main step sets model, effort and thinking', () => {
    const tree = applyStep(emptyTree(T0), { model: 'claude-opus-5-5', effort: 'medium', now: T0 + 1 })

    expect(tree.main).toEqual({ model: 'claude-opus-5-5', effort: 'medium', turns: 0, status: 'thinking' })
  })

  test('a subagent step sets its model and effort; a numeric effort is kept as text', () => {
    const tree = applyStep(grown([['a1']]), { agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'xhigh', now: T0 + 1 })
    const numeric = applyStep(tree, { agentId: 'a1', model: 'claude-sonnet-5-5', effort: 3, now: T0 + 2 })

    expect(tree.agents[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
    expect(numeric.agents[0]?.effort).toBe('3')
  })

  test('a step of a loop the tree does not know changes nothing (engine forks carry such ids)', () => {
    const tree = grown([['a1']])

    expect(applyStep(tree, { agentId: 'fork-1', model: 'claude-haiku-5', effort: 'low', now: T0 + 1 })).toBe(tree)
  })

  test('applyMain copies the session model and turn count, and keeps the tree when they match', () => {
    const tree = applyMain(emptyTree(T0), { model: 'claude-opus-5-5', turns: 3, now: T0 + 1 })

    expect(tree.main).toMatchObject({ model: 'claude-opus-5-5', turns: 3 })
    expect(applyMain(tree, { model: 'claude-opus-5-5', turns: 3, now: T0 + 2 })).toBe(tree)
  })
})

describe('applyToolCall and applyToolDone', () => {
  test('a subagent tool call records the last tool and counts calls', () => {
    let tree = grown([['a1']])
    tree = applyToolCall(tree, { agentId: 'a1', tool: 'Glob', now: T0 + 1 })
    tree = applyToolCall(tree, { agentId: 'a1', tool: 'Grep', now: T0 + 2 })

    expect(tree.agents[0]).toMatchObject({ lastTool: 'Grep', toolCalls: 2 })
    expect(applyToolCall(tree, { agentId: 'nobody', tool: 'Read', now: T0 + 3 })).toBe(tree)
  })

  test('the main loop is tooling while any of its tools runs, thinking after the last one', () => {
    let tree = applyStep(emptyTree(T0), { model: 'claude-opus-5-5', now: T0 })
    tree = applyToolCall(tree, { tool: 'Agent', now: T0 + 1 })
    tree = applyToolCall(tree, { tool: 'Read', now: T0 + 2 })

    expect(tree.main).toMatchObject({ status: 'tooling', toolsRunning: 2 })

    tree = applyToolDone(tree, { now: T0 + 3 })
    expect(tree.main).toMatchObject({ status: 'tooling', toolsRunning: 1 })

    tree = applyToolDone(tree, { now: T0 + 4 })
    expect(tree.main).toMatchObject({ status: 'thinking', toolsRunning: 0 })
  })

  test('a subagent tool finishing changes nothing', () => {
    const tree = applyToolCall(grown([['a1']]), { agentId: 'a1', tool: 'Glob', now: T0 + 1 })

    expect(applyToolDone(tree, { agentId: 'a1', now: T0 + 2 })).toBe(tree)
  })
})

describe('applyTurnComplete', () => {
  test('an answer completes the node; error, aborted and refusal fail it; the duration is kept', () => {
    let tree = grown([['a1'], ['a2'], ['a3'], ['a4']])
    tree = applyTurnComplete(tree, { agentId: 'a1', reason: 'answer', durationMs: 9276, now: T0 + 10_000 })
    tree = applyTurnComplete(tree, { agentId: 'a2', reason: 'error', durationMs: 1200, now: T0 + 10_001 })
    tree = applyTurnComplete(tree, { agentId: 'a3', reason: 'aborted', now: T0 + 10_002 })
    tree = applyTurnComplete(tree, { agentId: 'a4', reason: 'refusal', now: T0 + 10_003 })

    expect(tree.agents.map(node => [node.id, node.status, node.endedAt, node.durationMs])).toEqual([
      ['a1', 'completed', T0 + 10_000, 9276],
      ['a2', 'failed', T0 + 10_001, 1200],
      ['a3', 'failed', T0 + 10_002, undefined],
      ['a4', 'failed', T0 + 10_003, undefined],
    ])
  })

  test('the main turn ending makes the main row idle', () => {
    let tree = applyToolCall(applyStep(emptyTree(T0), { model: 'claude-opus-5-5', now: T0 }), { tool: 'Bash', now: T0 })
    tree = applyTurnComplete(tree, { reason: 'answer', now: T0 + 1 })

    expect(tree.main).toMatchObject({ status: 'idle', toolsRunning: 0 })
  })

  test('the end of a loop the tree does not know changes nothing', () => {
    const tree = grown([['a1']])

    expect(applyTurnComplete(tree, { agentId: 'fork-9', reason: 'answer', now: T0 + 1 })).toBe(tree)
  })
})

describe('flatten and countRunning', () => {
  test('nests two levels by parentId, children in start order, with box-drawing prefixes', () => {
    // a1 and a3 are spawned by the main loop, a2 by a1, a4 by a2 (two levels below a1).
    const tree = grown([['a1'], ['a2', 'a1'], ['a3'], ['a4', 'a2'], ['a5', 'a1']])

    expect(flatten(tree).map(row => [row.node.id, row.depth, row.prefix])).toEqual([
      ['a1', 1, '├─ '],
      ['a2', 2, '│  ├─ '],
      ['a4', 3, '│  │  └─ '],
      ['a5', 2, '│  └─ '],
      ['a3', 1, '└─ '],
    ])
  })

  test('a child whose parent is not in the tree is drawn at the top level', () => {
    const tree = grown([['a1'], ['a2', 'gone']])

    expect(flatten(tree).map(row => [row.node.id, row.depth])).toEqual([
      ['a1', 1],
      ['a2', 1],
    ])
  })

  test('a parent loop never hides its members', () => {
    const tree: TreeSnapshot = {
      ...emptyTree(T0),
      agents: [
        { id: 'x', parentId: 'y', type: 'Explore', description: '', role: 'researcher', status: 'running', toolCalls: 0, startedAt: T0 },
        { id: 'y', parentId: 'x', type: 'Explore', description: '', role: 'researcher', status: 'running', toolCalls: 0, startedAt: T0 + 1 },
      ],
    }

    expect(flatten(tree).map(row => row.node.id).sort()).toEqual(['x', 'y'])
  })

  test('countRunning counts running nodes only', () => {
    let tree = grown([['a1'], ['a2'], ['a3']])
    tree = applyTurnComplete(tree, { agentId: 'a2', reason: 'error', now: T0 + 5000 })

    expect(countRunning(tree)).toBe(2)
    expect(countRunning(emptyTree(T0))).toBe(0)
  })
})

describe('roles: researcher or worker (PRD M-L1a)', () => {
  const FIX = { subagentType: 'general-purpose', description: 'Fix the failing test' }

  test('a spawned node takes its role from the type, the description and the prompt; the prompt is not kept', () => {
    const prompt = 'Find where the session cache is cleared and report the call sites.'
    const byType = upsertFromSpawn(emptyTree(T0), EXPLORE, { agentId: 'e1' }, T0)
    const plain = upsertFromSpawn(emptyTree(T0), FIX, { agentId: 'w1' }, T0)
    const byPrompt = upsertFromSpawn(emptyTree(T0), { ...FIX, prompt }, { agentId: 'r1' }, T0)

    expect(byType.agents[0]?.role).toBe('researcher')
    expect(plain.agents[0]?.role).toBe('worker')
    expect(byPrompt.agents[0]?.role).toBe('researcher')
    expect(JSON.stringify(byPrompt)).not.toContain('session cache')
  })

  test('a node the agent list adds takes its role from its type and description; a known node keeps its role', () => {
    const tree = applyAgentList(
      emptyTree(T0),
      [
        { id: 'l1', description: 'Watch the build', type: 'general-purpose', status: 'running' },
        { id: 'l2', description: 'Review the diff', type: 'general-purpose', status: 'running' },
        { id: 'l3', description: 'Draft the plan', type: 'Plan', status: 'running' },
      ],
      T0,
    )

    expect(tree.agents.map(node => node.role)).toEqual(['worker', 'researcher', 'researcher'])

    // The list named l1 first; the spawn's prompt does not change its role.
    const merged = upsertFromSpawn(tree, { ...FIX, prompt: 'Read the build log first.' }, { agentId: 'l1' }, T0 + 1)

    expect(merged.agents[0]?.role).toBe('worker')
  })

  test('applyToolCall: Edit, Write and NotebookEdit make a researcher a worker, Bash and Read do not; only the caller changes', () => {
    const researchers = grown([['a1'], ['a2']])

    expect(researchers.agents.map(node => node.role)).toEqual(['researcher', 'researcher'])

    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(applyToolCall(researchers, { agentId: 'a1', tool, now: T0 + 1 }).agents[0]?.role, tool).toBe('worker')
    }

    for (const tool of ['Bash', 'Read', 'Grep', 'edit', 'mcp__files__write_file']) {
      expect(applyToolCall(researchers, { agentId: 'a1', tool, now: T0 + 1 }).agents[0]?.role, tool).toBe('researcher')
    }

    const flipped = applyToolCall(researchers, { agentId: 'a1', tool: 'Edit', now: T0 + 1 })

    expect(flipped.agents[0]).toMatchObject({ role: 'worker', lastTool: 'Edit', toolCalls: 1 })
    expect(flipped.agents[1]).toBe(researchers.agents[1])
  })

  test('one way: a worker stays a worker; the main loop writing and an unknown loop change no subagent', () => {
    const researchers = grown([['a1']])
    const flipped = applyToolCall(researchers, { agentId: 'a1', tool: 'Write', now: T0 + 1 })
    const worker = upsertFromSpawn(emptyTree(T0), FIX, { agentId: 'w1' }, T0)

    expect(applyToolCall(flipped, { agentId: 'a1', tool: 'Read', now: T0 + 2 }).agents[0]?.role).toBe('worker')
    expect(applyToolCall(worker, { agentId: 'w1', tool: 'Edit', now: T0 + 1 }).agents[0]?.role).toBe('worker')
    expect(applyToolCall(worker, { agentId: 'w1', tool: 'Grep', now: T0 + 1 }).agents[0]?.role).toBe('worker')

    // The main loop's Edit is no subagent's: the very same agents and nodes.
    expect(applyToolCall(researchers, { tool: 'Edit', now: T0 + 1 }).agents).toBe(researchers.agents)
    // A loop the tree does not know: the very same tree.
    expect(applyToolCall(researchers, { agentId: 'fork-1', tool: 'Write', now: T0 + 1 })).toBe(researchers)
  })
})

// C7a2: external engine workers (PRD M-L1b). A shell tool call that starts
// an engine CLI is a node `ext:<tool_use_id>` from the call to its return;
// one run in the background lives until a classic.Stop no longer lists its
// task.

/** A Kimi run the main loop starts in the foreground, as external.ts reads `kimi -m kimi-code/k3 -p "do X"`. */
const KIMI: ExternalStart = {
  toolUseId: 'toolu_k1',
  engine: 'kimi',
  model: 'kimi-code/k3',
  task: 'do X',
  description: 'Run kimi on card C7',
  now: T0 + 1000,
}

/** The tree with the KIMI run open, `changes` made to its start. */
const kimiTree = (changes: Partial<ExternalStart> = {}): TreeSnapshot => applyExternalStart(emptyTree(T0), { ...KIMI, ...changes })

/** The one external node of `tree`. */
const externalOf = (tree: TreeSnapshot | undefined): AgentNode | undefined => tree?.agents.find(node => node.kind === 'external')

/** A background task of the engine's, as `classic.Stop` lists it. */
const task = (changes: BackgroundTask = {}): BackgroundTask => ({
  id: 'task-7',
  type: 'shell',
  status: 'running',
  command: 'kimi -m kimi-code/k3 -p "do X"',
  ...changes,
})

describe('external workers: applyExternalStart and applyExternalEnd (PRD M-L1b)', () => {
  test('a shell call that starts an engine opens a running node: ext:<id>, the engine as its type, the model, the role, the start', () => {
    const tree = kimiTree({ agentId: 'a1' })

    expect(externalId('toolu_k1')).toBe('ext:toolu_k1')
    expect(tree.agents).toEqual([
      {
        id: 'ext:toolu_k1',
        kind: 'external',
        parentId: 'a1',
        type: 'kimi',
        description: 'Run kimi on card C7',
        role: 'worker',
        model: 'kimi-code/k3',
        status: 'running',
        toolCalls: 0,
        startedAt: T0 + 1000,
      },
    ])
    expect(tree.updatedAt).toBe(T0 + 1000)
    // The main loop's call: no parent; a background one says so; no model read, none kept.
    expect(externalOf(kimiTree({ model: undefined, background: true }))).toEqual({
      id: 'ext:toolu_k1',
      kind: 'external',
      type: 'kimi',
      description: 'Run kimi on card C7',
      role: 'worker',
      status: 'running',
      background: true,
      toolCalls: 0,
      startedAt: T0 + 1000,
    })
  })

  test('the description wins over the -p task; either is cut to 40 characters; the role reads the whole text', () => {
    const long = 'Implement the external worker parser and then review the diff it makes'

    expect(externalOf(kimiTree())?.description).toBe('Run kimi on card C7')
    expect(externalOf(kimiTree({ description: undefined }))?.description).toBe('do X')
    expect(externalOf(kimiTree({ description: '   ' }))?.description).toBe('do X')
    expect(externalOf(kimiTree({ description: '   ', task: 'Summarize the logs' }))?.role).toBe('researcher')
    expect(externalOf(kimiTree({ description: undefined, task: undefined }))?.description).toBe('')
    expect(externalOf(kimiTree({ description: long }))?.description).toBe('Implement the external worker parser and')
    // `review` lies past the cut: the role is read from the whole description, which is not kept.
    expect(externalOf(kimiTree({ description: long }))?.role).toBe('researcher')
    expect(externalOf(kimiTree({ description: undefined, task: 'Summarize the logs' }))?.role).toBe('researcher')
    expect(JSON.stringify(kimiTree({ description: long }))).not.toContain('review the diff')
  })

  test('no call id, or a call already open: the same tree; the nodes share the MAX_AGENTS cap with the subagents', () => {
    const tree = kimiTree()

    expect(applyExternalStart(tree, KIMI)).toBe(tree)
    expect(applyExternalStart(tree, { ...KIMI, toolUseId: '' })).toBe(tree)
    expect(applyExternalStart(tree, { ...KIMI, toolUseId: undefined as unknown as string })).toBe(tree)

    let full = emptyTree(T0)

    for (let index = 0; index < MAX_AGENTS; index += 1) {
      full = upsertFromSpawn(full, EXPLORE, { agentId: `a${index}` }, T0 + index)
      full = applyTurnComplete(full, { agentId: `a${index}`, reason: 'answer', now: T0 + index })
    }

    const capped = applyExternalStart(full, KIMI)

    expect(capped.agents).toHaveLength(MAX_AGENTS)
    expect(capped.agents.at(-1)?.id).toBe('ext:toolu_k1')
    expect(capped.agents.some(node => node.id === 'a0')).toBe(false)
  })

  test('applyExternalEnd: a foreground call completes on its result and fails on an error; the end time is kept', () => {
    const done = applyExternalEnd(kimiTree(), { toolUseId: 'toolu_k1', isError: false, now: T0 + 9000 })
    const failed = applyExternalEnd(kimiTree(), { toolUseId: 'toolu_k1', isError: true, now: T0 + 9000 })

    expect(externalOf(done)).toMatchObject({ status: 'completed', endedAt: T0 + 9000 })
    expect(externalOf(failed)).toMatchObject({ status: 'failed', endedAt: T0 + 9000 })
    expect(done.updatedAt).toBe(T0 + 9000)
    // Once closed it stays as it is.
    expect(applyExternalEnd(done, { toolUseId: 'toolu_k1', isError: true, now: T0 + 9999 })).toBe(done)
  })

  test('applyExternalEnd: a background call runs on; its task id is kept; a foreground call moved to the background runs on too', () => {
    const background = kimiTree({ background: true })

    expect(applyExternalEnd(background, { toolUseId: 'toolu_k1', isError: false, now: T0 + 2000 })).toBe(background)

    const withTask = applyExternalEnd(background, { toolUseId: 'toolu_k1', isError: false, taskId: 'task-7', now: T0 + 2000 })

    expect(externalOf(withTask)).toMatchObject({ status: 'running', background: true, taskId: 'task-7' })
    expect(externalOf(withTask)?.endedAt).toBeUndefined()

    // A foreground call whose result names a background task (Ctrl+B, or its timeout): running in the background.
    expect(externalOf(applyExternalEnd(kimiTree(), { toolUseId: 'toolu_k1', isError: false, taskId: 'task-8', now: T0 + 2000 }))).toMatchObject({
      status: 'running',
      background: true,
      taskId: 'task-8',
    })
    // A background call that came back with an error and no task never ran: failed.
    expect(externalOf(applyExternalEnd(background, { toolUseId: 'toolu_k1', isError: true, now: T0 + 2000 }))).toMatchObject({
      status: 'failed',
      endedAt: T0 + 2000,
    })
  })

  test('applyExternalEnd: an unknown call, or a subagent id, changes nothing', () => {
    const tree = applyExternalStart(grown([['a1']]), KIMI)

    expect(applyExternalEnd(tree, { toolUseId: 'toolu_other', isError: false, now: T0 + 2000 })).toBe(tree)
    expect(applyExternalEnd(tree, { toolUseId: 'a1', isError: true, now: T0 + 2000 })).toBe(tree)
    expect(countRunning(tree)).toBe(2)
  })
})

describe('external workers: applyBackgroundTasks at classic.Stop (PRD M-L1b)', () => {
  /** The KIMI run in the background, its result naming task-7 when `taskId` is given. */
  const backgroundTree = (taskId?: string): TreeSnapshot => {
    const started = kimiTree({ background: true })

    return taskId === undefined ? started : applyExternalEnd(started, { toolUseId: 'toolu_k1', isError: false, taskId, now: T0 + 2000 })
  }

  test('its task still listed and running (or pending): the very same tree', () => {
    const tree = backgroundTree('task-7')

    expect(applyBackgroundTasks(tree, [task()], T0 + 5000)).toBe(tree)
    expect(applyBackgroundTasks(tree, [task({ id: 'other', status: 'running' }), task({ status: 'pending' })], T0 + 5000)).toBe(tree)
  })

  test('its task no longer listed, or listed but not in flight: completed at the stop', () => {
    const tree = backgroundTree('task-7')

    for (const tasks of [[], [task({ id: 'other' })], [task({ status: 'completed' })], [task({ status: 'killed' })]]) {
      const next = applyBackgroundTasks(tree, tasks, T0 + 5000)

      expect(externalOf(next), JSON.stringify(tasks)).toMatchObject({ status: 'completed', endedAt: T0 + 5000 })
      expect(next.updatedAt).toBe(T0 + 5000)
    }
  })

  test('the task id is the key; a node with none is known by a shell task that starts its engine with its model', () => {
    const tree = backgroundTree()

    // The task id given: another task with the same command is not its own.
    expect(externalOf(applyBackgroundTasks(backgroundTree('task-7'), [task({ id: 'task-9' })], T0 + 5000))?.status).toBe('completed')
    // No task id: the command, read for this node's engine and compared by its model.
    expect(applyBackgroundTasks(tree, [task({ id: 'any', command: 'Start-Process kimi -ArgumentList \'-m\',\'kimi-code/k3\'' })], T0 + 5000)).toBe(tree)
    expect(externalOf(applyBackgroundTasks(tree, [task({ command: 'kimi -m kimi-code/k2' })], T0 + 5000))?.status).toBe('completed')
    expect(externalOf(applyBackgroundTasks(tree, [task({ command: 'codex -m kimi-code/k3' })], T0 + 5000))?.status).toBe('completed')
    expect(externalOf(applyBackgroundTasks(tree, [task({ type: 'subagent' })], T0 + 5000))?.status).toBe('completed')
    expect(externalOf(applyBackgroundTasks(tree, [task({ command: undefined })], T0 + 5000))?.status).toBe('completed')
    // No model on either side is the same model.
    const bare = kimiTree({ background: true, model: undefined })

    expect(applyBackgroundTasks(bare, [task({ command: 'kimi -p "do X"' })], T0 + 5000)).toBe(bare)
  })

  test('only external workers running in the background are reconciled; no task list at all changes nothing', () => {
    // A foreground external call, a background Claude subagent and a finished background worker: none is touched.
    let tree = applyExternalStart(emptyTree(T0), { ...KIMI, toolUseId: 'toolu_fg' })
    tree = upsertFromSpawn(tree, { ...EXPLORE, background: true }, { agentId: 'bg1' }, T0)
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_done', background: true })
    tree = applyExternalEnd(tree, { toolUseId: 'toolu_done', isError: true, now: T0 + 2000 })

    expect(applyBackgroundTasks(tree, [], T0 + 5000)).toBe(tree)

    const running = backgroundTree('task-7')

    expect(applyBackgroundTasks(running, undefined as unknown as BackgroundTask[], T0 + 5000)).toBe(running)
  })

  test('countRunning counts a running external worker as it counts a subagent', () => {
    let tree = applyExternalStart(grown([['a1'], ['a2']]), KIMI)
    tree = applyTurnComplete(tree, { agentId: 'a2', reason: 'answer', now: T0 + 3000 })

    expect(countRunning(tree)).toBe(2)
    expect(countRunning(applyExternalEnd(tree, { toolUseId: 'toolu_k1', isError: false, now: T0 + 4000 }))).toBe(1)
  })
})

// C7a2b: the close-out of an external worker whose call was cut off. An
// interrupted command is killed; the end of its loop's turn kills a
// foreground worker that is still open (its call never came back).

describe('external workers: the close-out (C7a2b, PRD M-L1b)', () => {
  test('applyExternalEnd: an interrupted command is killed; an error still fails it; a background task id keeps it running', () => {
    const killed = applyExternalEnd(kimiTree(), { toolUseId: 'toolu_k1', isError: false, interrupted: true, now: T0 + 9000 })

    expect(externalOf(killed)).toMatchObject({ status: 'killed', endedAt: T0 + 9000 })
    expect(killed.updatedAt).toBe(T0 + 9000)
    // An error result (a deny, a rejected call) that says interrupted too: failed.
    expect(externalOf(applyExternalEnd(kimiTree(), { toolUseId: 'toolu_k1', isError: true, interrupted: true, now: T0 + 9000 }))?.status).toBe('failed')
    // Moved to the background as it was cut off (a task id): it runs on.
    expect(
      externalOf(applyExternalEnd(kimiTree(), { toolUseId: 'toolu_k1', isError: false, interrupted: true, taskId: 'task-7', now: T0 + 9000 })),
    ).toMatchObject({ status: 'running', background: true, taskId: 'task-7' })
    // A background call cut off before it had a task never ran on: killed.
    expect(
      externalOf(applyExternalEnd(kimiTree({ background: true }), { toolUseId: 'toolu_k1', isError: false, interrupted: true, now: T0 + 9000 }))
        ?.status,
    ).toBe('killed')
    // `interrupted: false` is a plain return.
    expect(
      externalOf(applyExternalEnd(kimiTree(), { toolUseId: 'toolu_k1', isError: false, interrupted: false, now: T0 + 9000 }))?.status,
    ).toBe('completed')
    // Once closed it stays as it is.
    expect(applyExternalEnd(killed, { toolUseId: 'toolu_k1', isError: true, now: T0 + 9999 })).toBe(killed)
  })

  test("closeForegroundExternals, the main loop: its running foreground workers are killed; background, finished and other loops' stay", () => {
    let tree = grown([['a1']])
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_m1' })
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_m2', background: true })
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_m3' })
    tree = applyExternalEnd(tree, { toolUseId: 'toolu_m3', isError: false, now: T0 + 2000 })
    // A foreground call moved to the background (Ctrl+B): it runs on as a task.
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_m4' })
    tree = applyExternalEnd(tree, { toolUseId: 'toolu_m4', isError: false, taskId: 'task-4', now: T0 + 2000 })
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_s1', agentId: 'a1' })

    const closed = closeForegroundExternals(tree, undefined, T0 + 5000)

    expect(closed.agents.map(node => [node.id, node.status, node.endedAt])).toEqual([
      ['a1', 'running', undefined],
      ['ext:toolu_m1', 'killed', T0 + 5000],
      ['ext:toolu_m2', 'running', undefined],
      ['ext:toolu_m3', 'completed', T0 + 2000],
      ['ext:toolu_m4', 'running', undefined],
      ['ext:toolu_s1', 'running', undefined],
    ])
    expect(closed.updatedAt).toBe(T0 + 5000)
    // Nothing left to close: the very same tree.
    expect(closeForegroundExternals(closed, undefined, T0 + 6000)).toBe(closed)
  })

  test("closeForegroundExternals, a subagent's turn: its own foreground workers only, not the subagent itself", () => {
    let tree = grown([['a1'], ['a2']])
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_s1', agentId: 'a1' })
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_s2', agentId: 'a2' })
    tree = applyExternalStart(tree, { ...KIMI, toolUseId: 'toolu_m1' })

    const closed = closeForegroundExternals(tree, 'a1', T0 + 5000)

    expect(closed.agents.map(node => [node.id, node.status, node.endedAt])).toEqual([
      ['a1', 'running', undefined],
      ['a2', 'running', undefined],
      ['ext:toolu_s1', 'killed', T0 + 5000],
      ['ext:toolu_s2', 'running', undefined],
      ['ext:toolu_m1', 'running', undefined],
    ])
  })

  test('closeForegroundExternals: a tree with no external worker, or a loop with none open, is the very same tree', () => {
    const subagents = grown([['a1'], ['a2', 'a1']])
    const empty = emptyTree(T0)

    expect(closeForegroundExternals(subagents, undefined, T0 + 5000)).toBe(subagents)
    expect(closeForegroundExternals(subagents, 'a1', T0 + 5000)).toBe(subagents)
    expect(closeForegroundExternals(empty, undefined, T0 + 5000)).toBe(empty)

    const tree = applyExternalStart(subagents, { ...KIMI, agentId: 'a1' })

    expect(closeForegroundExternals(tree, 'a2', T0 + 5000)).toBe(tree)
    expect(closeForegroundExternals(tree, undefined, T0 + 5000)).toBe(tree)
    expect(closeForegroundExternals(tree, 'fork-1', T0 + 5000)).toBe(tree)
  })
})

// The same through the plugin: its `tool.call` and `classic.Stop` hooks,
// with the shell beneath it (the test's own hooks), read through the tree
// writes that land (the test `$` has no `state` noun).

/** Every tree write that landed, in order, seen from beneath the plugin: the last one is the tree as it stands. */
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

/** What the shell beneath answers: an exit 0 with no background task. */
const EXIT_0 = { result: { stdout: 'done', stderr: '', interrupted: false } as never, text: 'done' }

const STOP = { stop_hook_active: false, transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--repo\\0f7c.jsonl' } as const

describe('external workers through the plugin (PRD M-L1b)', () => {
  test('a Bash call that runs kimi: a running ext:<id> worker while it runs, titled worker, type kimi, model kimi-code/k3; its result completes it', async ($, on) => {
    const writes = treeWrites(on)
    const during: (AgentNode | undefined)[] = []

    on('tool.call', () => {
      during.push(externalOf(writes.at(-1)))

      return EXIT_0
    })

    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: 'kimi -m kimi-code/k3 -p "do X"', description: 'Run kimi on card C7' } as never)

    expect(during).toHaveLength(1)
    expect(during[0]).toMatchObject({
      id: 'ext:toolu_k1',
      kind: 'external',
      type: 'kimi',
      model: 'kimi-code/k3',
      description: 'Run kimi on card C7',
      role: 'worker',
      status: 'running',
    })
    expect(typeof during[0]?.startedAt).toBe('number')
    expect(during[0]?.parentId).toBeUndefined()
    expect(during[0]?.background).toBeUndefined()

    const done = externalOf(writes.at(-1))

    expect(done).toMatchObject({ id: 'ext:toolu_k1', status: 'completed' })
    expect(typeof done?.endedAt).toBe('number')
    // The command itself is kept nowhere in the tree.
    expect(JSON.stringify(writes)).not.toContain('kimi -m')
  })

  test('an error result or a deny fails the worker', async ($, on) => {
    const writes = treeWrites(on)

    on('tool.call', ($, e) =>
      (e as { command?: string }).command?.startsWith('codex') === true
        ? { deny: 'refused by the test' }
        : { isError: true, result: 'exit 1' as never, text: 'exit 1' },
    )

    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_e1', command: 'kimi -m kimi-code/k3' } as never)
    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_e2', command: 'codex exec -m chatgpt-6.1sol "fix"' } as never)

    expect(writes.at(-1)?.agents.map(node => [node.id, node.status])).toEqual([
      ['ext:toolu_e1', 'failed'],
      ['ext:toolu_e2', 'failed'],
    ])
  })

  test('run_in_background: still running after the result; a stop that lists its task leaves it, one that does not completes it', async ($, on) => {
    const writes = treeWrites(on)
    const command = 'codex exec -m chatgpt-6.1sol "fix tests"'

    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-7' } as never, text: 'started' }))
    on('classic.Stop', () => ({}))

    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_b1', command, description: 'Codex fixes the tests', run_in_background: true } as never)

    expect(externalOf(writes.at(-1))).toMatchObject({
      id: 'ext:toolu_b1',
      type: 'codex',
      model: 'chatgpt-6.1sol',
      status: 'running',
      background: true,
      taskId: 'task-7',
    })

    const before = writes.length

    // Still listed and running; then no task list at all: no write.
    await $.classic.Stop({ ...STOP, background_tasks: [{ id: 'task-7', type: 'shell', status: 'running', description: 'Codex fixes the tests', command }] } as never)
    await $.classic.Stop(STOP as never)
    expect(writes).toHaveLength(before)
    expect(externalOf(writes.at(-1))?.status).toBe('running')

    // No longer listed: completed, in one write.
    await $.classic.Stop({ ...STOP, background_tasks: [{ id: 'task-9', type: 'shell', status: 'running', description: 'other', command: 'npm test' }] } as never)
    expect(writes).toHaveLength(before + 1)
    expect(externalOf(writes.at(-1))).toMatchObject({ status: 'completed', background: true })
    expect(typeof externalOf(writes.at(-1))?.endedAt).toBe('number')
  })

  test('a result with no task id: the background worker is known at the stop by its engine and model', async ($, on) => {
    const writes = treeWrites(on)

    on('tool.call', () => EXIT_0)
    on('classic.Stop', () => ({}))

    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b2', command: 'kimi -m kimi-code/k3 -p "do X"', run_in_background: true } as never)
    expect(externalOf(writes.at(-1))).toMatchObject({ status: 'running', background: true, description: 'do X' })

    const before = writes.length

    await $.classic.Stop({ ...STOP, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'x', command: 'kimi -m kimi-code/k3 -p "do X"' }] } as never)
    expect(writes).toHaveLength(before)

    await $.classic.Stop({ ...STOP, background_tasks: [] } as never)
    expect(externalOf(writes.at(-1))?.status).toBe('completed')
  })

  test('a non-shell tool and a command that starts no engine write no node: two tree writes a call, as before C7a2', async ($, on) => {
    const writes = treeWrites(on)

    on('tool.call', () => EXIT_0)

    await $.tool.call({ tool: 'Read', file_path: 'D:/repo/kimi.md' } as never)
    expect(writes).toHaveLength(2)

    await $.tool.call({ tool: 'Monitor', command: 'kimi -m kimi-code/k3', description: 'watch kimi', timeout_ms: 1000 } as never)
    await $.tool.call({ tool: 'Bash', command: 'git log --oneline -3' } as never)
    await $.tool.call({ tool: 'PowerShell', command: 'Write-Output kimi; grep kimi docs' } as never)
    // Not in the table without the workerCommands option.
    await $.tool.call({ tool: 'PowerShell', command: 'qwen -m qwen3-coder' } as never)

    expect(writes).toHaveLength(10)
    expect(writes.every(tree => tree.agents.length === 0)).toBe(true)
  })

  test('the workerCommands option adds engines, in any case', { options: { workerCommands: 'qwen, My-Agent' } }, async ($, on) => {
    const writes = treeWrites(on)

    on('tool.call', () => EXIT_0)

    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_q1', command: 'QWEN -m qwen3-coder -p "port the parser"' } as never)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_m1', command: 'C:\\bin\\My-Agent.CMD --model=m1' } as never)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_k1', command: 'kimi' } as never)

    expect(writes.at(-1)?.agents.map(node => [node.id, node.type, node.model, node.description, node.status])).toEqual([
      ['ext:toolu_q1', 'qwen', 'qwen3-coder', 'port the parser', 'completed'],
      ['ext:toolu_m1', 'my-agent', 'm1', '', 'completed'],
      ['ext:toolu_k1', 'kimi', undefined, '', 'completed'],
    ])
  })

  test("a subagent's shell call: the worker hangs under that subagent, whose own last tool is the shell", async ($, on) => {
    const writes = treeWrites(on)

    on('agent.spawn', ($, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
    on('tool.call', () => EXIT_0)

    await $.agent.spawn({
      tool_use_id: 'a1',
      prompt: 'Drive kimi through card C7.',
      description: 'Drive the kimi card',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      model: 'sonnet',
      parentModel: 'claude-opus-5-5',
      permissionMode: 'default',
      background: false,
      fork: false,
    })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_s1', command: 'kimi -m kimi-code/k3 -p "card C7"', agentId: 'a1' } as never)

    const tree = writes.at(-1)

    expect(tree?.agents.find(node => node.id === 'a1')).toMatchObject({ lastTool: 'Bash', toolCalls: 1 })
    expect(externalOf(tree)).toMatchObject({ id: 'ext:toolu_s1', parentId: 'a1', status: 'completed', description: 'card C7' })
    expect(flatten(tree ?? EMPTY_TREE).map(row => [row.node.id, row.depth])).toEqual([
      ['a1', 1],
      ['ext:toolu_s1', 2],
    ])
  })
})

// C7a2b through the plugin: a call whose next(e) rejects, a command the
// result says was interrupted, a turn that ends while its loop's engine call
// is still out, and classic.SubagentStop.

/** Every write of the Jev ring that landed, seen from beneath the plugin (as jev-wiring.test.ts counts them). */
function ringWrites(on: On): unknown[][] {
  const writes: unknown[][] = []

  on('state.set', { plugin: 'agent-tree', key: 'jevEvents' }, async ($, e, next) => {
    const written = await next(e)

    if (written.value?.isSet === true) {
      writes.push([...e.value])
    }

    return written
  })

  return writes
}

/** The key of every state write of the plugin's that landed, whatever its key. */
function stateWrites(on: On): string[] {
  const writes: string[] = []

  on('state.set', async ($, e, next) => {
    const written = await next(e)

    if (e.plugin === 'agent-tree' && written.value?.isSet === true) {
      writes.push(e.key)
    }

    return written
  })

  return writes
}

/** Each node of `tree` as `[id, status]`. */
const statusesOf = (tree: TreeSnapshot | undefined): string[][] => (tree?.agents ?? []).map(node => [node.id, node.status])

/** The end of a turn the person cut short: the main loop's, or with `agentId` a subagent's. */
const abortedTurn = (agentId?: string) => ({
  answer: '',
  durationMs: 5000,
  isAborted: true,
  turnId: agentId === undefined ? 't-main' : `t-${agentId}`,
  reason: 'aborted' as const,
  ...(agentId === undefined ? {} : { agentId }),
})

/** What the shell beneath answers a background start: at once, with the task the command runs on as. */
const STARTED = { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-7' } as never, text: 'started' }

const SUBAGENT_STOP = {
  stop_hook_active: false,
  agent_id: 'a1',
  agent_transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--repo\\0f7c\\subagents\\agent-a1.jsonl',
  agent_type: 'general-purpose',
} as const

describe('external workers: the close-out through the plugin (C7a2b, PRD M-L1b)', () => {
  test('a call whose next(e) rejects: the worker fails, the rejection goes up as it came, the Jev ring records nothing', async ($, on) => {
    const writes = treeWrites(on)
    const ring = ringWrites(on)

    // The shell beneath throws on the first call: the engine skips that hook, and the kit's bottom hook rejects the plugin's next(e).
    on('tool.call', (_engine, e) => {
      if (e.tool_use_id === 'toolu_r1') {
        throw new Error('the shell beneath broke')
      }

      return EXIT_0
    })

    await expect(
      $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_r1', command: 'kimi -m kimi-code/k3 -p "do X"' } as never),
    ).rejects.toThrow('no implementation for tool.call')

    expect(externalOf(writes.at(-1))).toMatchObject({ id: 'ext:toolu_r1', status: 'failed' })
    expect(typeof externalOf(writes.at(-1))?.endedAt).toBe('number')
    expect(ring).toHaveLength(0)

    // A call that returns is recorded, once: the ring is watched.
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_r2', command: 'kimi -m kimi-code/k3' } as never)

    expect(ring).toHaveLength(1)
    expect(statusesOf(writes.at(-1))).toEqual([
      ['ext:toolu_r1', 'failed'],
      ['ext:toolu_r2', 'completed'],
    ])
  })

  test('a result that says the command was interrupted: the worker is killed; with an error result it failed', async ($, on) => {
    const writes = treeWrites(on)
    const cut = { stdout: '', stderr: '', interrupted: true } as never

    on('tool.call', (_engine, e) => (e.tool_use_id === 'toolu_i2' ? { isError: true, result: cut, text: 'Interrupted' } : { result: cut, text: 'Interrupted' }))

    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_i1', command: 'kimi -m kimi-code/k3 -p "do X"' } as never)
    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_i2', command: 'codex exec -m chatgpt-6.1sol "fix"' } as never)

    expect(statusesOf(writes.at(-1))).toEqual([
      ['ext:toolu_i1', 'killed'],
      ['ext:toolu_i2', 'failed'],
    ])
    expect(writes.at(-1)?.agents.every(node => typeof node.endedAt === 'number')).toBe(true)
  })

  test("the main loop's turn ends with its engine call still out: killed in that write and after the late return; a background one runs on", async ($, on) => {
    const writes = treeWrites(on)
    let turnWrites = 0
    let atTurnEnd: AgentNode | undefined

    on('turn.complete', () => ({ text: '' }))
    on('tool.call', async (_engine, e) => {
      if (e.tool_use_id === 'toolu_bg') {
        return STARTED
      }

      // The person pressed Esc: the turn ends while the command is out; the call comes back later.
      const before = writes.length
      await $.turn.complete(abortedTurn())
      turnWrites = writes.length - before
      atTurnEnd = writes.at(-1)?.agents.find(node => node.id === 'ext:toolu_fg')

      return EXIT_0
    })

    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_bg', command: 'codex exec -m chatgpt-6.1sol "x"', run_in_background: true } as never)
    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_fg', command: 'kimi -m kimi-code/k3 -p "do X"' } as never)

    expect(turnWrites).toBe(1)
    expect(atTurnEnd).toMatchObject({ status: 'killed' })
    expect(typeof atTurnEnd?.endedAt).toBe('number')
    expect(statusesOf(writes.at(-1))).toEqual([
      ['ext:toolu_bg', 'running'],
      ['ext:toolu_fg', 'killed'],
    ])
    expect(writes.at(-1)?.agents.find(node => node.id === 'ext:toolu_fg')?.endedAt).toBe(atTurnEnd?.endedAt)
  })

  test("a subagent's turn ends while its engine call is still out: its worker is killed; the main loop's turn end left it running", async ($, on) => {
    const writes = treeWrites(on)
    const seen: Record<string, string | undefined> = {}

    on('agent.spawn', (_engine, e) => ({ model: 'claude-sonnet-5-5', agentId: e.tool_use_id }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', async () => {
      await $.turn.complete(abortedTurn())
      seen.afterMain = externalOf(writes.at(-1))?.status
      await $.turn.complete(abortedTurn('a1'))
      seen.afterSubagent = externalOf(writes.at(-1))?.status
      seen.subagent = writes.at(-1)?.agents.find(node => node.id === 'a1')?.status

      return EXIT_0
    })

    await $.agent.spawn({
      tool_use_id: 'a1',
      prompt: 'Drive kimi through card C7.',
      description: 'Drive the kimi card',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      model: 'sonnet',
      parentModel: 'claude-opus-5-5',
      permissionMode: 'default',
      background: false,
      fork: false,
    })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_s1', command: 'kimi -m kimi-code/k3 -p "card C7"', agentId: 'a1' } as never)

    expect(seen).toEqual({ afterMain: 'running', afterSubagent: 'killed', subagent: 'failed' })
    expect(externalOf(writes.at(-1))).toMatchObject({ id: 'ext:toolu_s1', parentId: 'a1', status: 'killed' })
  })

  test('classic.SubagentStop with a task list reconciles the background workers as classic.Stop does', async ($, on) => {
    const writes = treeWrites(on)
    const command = 'codex exec -m chatgpt-6.1sol "fix tests"'

    on('tool.call', () => STARTED)
    on('classic.SubagentStop', () => ({}))

    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_b1', command, run_in_background: true } as never)

    expect(externalOf(writes.at(-1))).toMatchObject({ status: 'running', background: true, taskId: 'task-7' })

    const before = writes.length

    // Its task still listed and running: no write.
    await $.classic.SubagentStop({
      ...SUBAGENT_STOP,
      background_tasks: [{ id: 'task-7', type: 'shell', status: 'running', description: 'Codex fixes the tests', command }],
    } as never)
    expect(writes).toHaveLength(before)

    // No longer listed: completed, in one write.
    await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: [] } as never)
    expect(writes).toHaveLength(before + 1)
    expect(externalOf(writes.at(-1))).toMatchObject({ status: 'completed', background: true })
    expect(typeof externalOf(writes.at(-1))?.endedAt).toBe('number')
  })

  test('classic.SubagentStop without a task list writes nothing at all', async ($, on) => {
    const writes = stateWrites(on)

    on('tool.call', () => STARTED)
    on('classic.SubagentStop', () => ({}))

    await $.tool.call({ tool: 'PowerShell', tool_use_id: 'toolu_b1', command: 'kimi -m kimi-code/k3', run_in_background: true } as never)

    const before = writes.length

    await $.classic.SubagentStop(SUBAGENT_STOP as never)
    expect(writes).toHaveLength(before)

    // The same stop with a list that no longer names the task: the tree, once, then the worker's end line in the log (C7d; the count is live).
    await $.classic.SubagentStop({ ...SUBAGENT_STOP, background_tasks: [] } as never)
    expect(writes.slice(before)).toEqual(['tree', 'log'])
  })
})
