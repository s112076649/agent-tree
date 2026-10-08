// The agent tree as a ledger: pure functions over TreeSnapshot, no `$`.
// register.tsx feeds them the events (agent.spawn opens a node, turn.step
// and tool.call fill it in, turn.complete closes it) and reconciles them with
// `$.agent.list()`, which lists running and background agents but drops a
// foreground subagent once it finished. An external worker (PRD M-L1b) is a
// node too: a shell tool call that starts an engine CLI opens it, the call's
// return closes it, and the background tasks of `classic.Stop` (and, from
// C7a2b, `classic.SubagentStop`) close one that ran on in the background; the
// end of its loop's turn kills a foreground one whose call never came back
// (C7a2b). Every function returns the very tree it was given when nothing
// changed, so a caller can skip the write.

import type { AgentNode, MainNode, MainStatus, TreeSnapshot } from '../types'
import { externalWorkerOf, taskText } from './external'
import { isWritingTool, roleOf } from './role'

/** The most nodes the ledger keeps; past it the oldest finished ones go first. */
export const MAX_AGENTS = 200

/** The tree before anything happened: the `tree` atom's initial value. */
export const EMPTY_TREE: TreeSnapshot = emptyTree(0)

export function emptyTree(now: number): TreeSnapshot {
  return { main: { turns: 0, status: 'idle' }, agents: [], updatedAt: now }
}

/** What `agent.spawn`'s input says about the subagent about to start. */
export type SpawnInput = {
  subagentType: string
  description: string
  /** The Agent call's prompt: only its head is read, for the role (PRD M-L1a), and none of it is kept. */
  prompt?: string
  /** The Agent call's `model` parameter (an alias or an id), when given. */
  model?: string
  background?: boolean
  /** The loop the spawn happened in; absent on the main loop. */
  parentAgentId?: string
}

/** What `agent.spawn` resolved to: the started subagent, or nothing on a deny. */
export type SpawnResult = {
  agentId?: string
  /** The model the subagent runs on (a resolved id from core). */
  model?: string
}

/** One entry of `$.agent.list()`. */
export type ListedAgent = {
  id: string
  description: string
  type: string
  status: string
  parentId?: string
}

/** What one `turn.step` says about its loop. */
export type StepInfo = {
  agentId?: string
  model: string
  effort?: string | number
  now: number
}

/** The main loop's figures from `$.session.model()` and `$.session.turns()`. */
export type MainInfo = {
  model?: string
  turns?: number
  now: number
}

export type ToolCallInfo = { agentId?: string; tool: string; now: number }

export type ToolDoneInfo = { agentId?: string; now: number }

/** What one `turn.complete` says: its loop, why it ended and how long it ran. */
export type TurnEnd = {
  agentId?: string
  /** `answer`, `aborted`, `refusal` or `error`. */
  reason: string
  durationMs?: number
  now: number
}

/** What a shell tool call that starts an engine CLI says (PRD M-L1b; external.ts externalCallOf reads it off the call). */
export type ExternalStart = {
  /** The tool call's id: the node is `ext:<toolUseId>`. */
  toolUseId: string
  /** The engine's name in the engine table (`kimi`, `codex`). */
  engine: string
  model?: string
  /** The head of the command's `-p` string. */
  task?: string
  /** The tool call's own description: it wins over the task. */
  description?: string
  /** The loop that ran the shell tool; absent on the main loop. */
  agentId?: string
  /** `run_in_background`: the tool returns while the engine runs on. */
  background?: boolean
  now: number
}

/** How the shell tool call of an external worker returned. */
export type ExternalEnd = {
  toolUseId: string
  /** An error result, a deny, or a `next(e)` that rejected (C7a2b). */
  isError: boolean
  /** The result says the command was interrupted (`interrupted: true`; C7a2b). */
  interrupted?: boolean
  /** The result's `backgroundTaskId`: the command runs on in the background as that task. */
  taskId?: string
  now: number
}

/**
 * One entry of the `background_tasks` of `classic.Stop` and
 * `classic.SubagentStop` (the d.ts's BackgroundTaskSummary), as far as it is
 * read here.
 */
export type BackgroundTask = {
  id?: string
  /** `shell`, `subagent`, `monitor`, `workflow`, ... */
  type?: string
  status?: string
  /** The command line, for a `shell` task (cut at 1000 characters). */
  command?: string
}

/** One drawn row: the node, its depth below the main row (1 = spawned by main), its box-drawing guides. */
export type FlatRow = {
  node: AgentNode
  depth: number
  prefix: string
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isRunning = (node: AgentNode): boolean => node.status === 'running'

/** A main row with a field set, or dropped when the value is undefined (state holds no `undefined`). */
function withMain(main: MainNode, changes: Partial<MainNode>): MainNode {
  const next: Record<string, unknown> = { ...main }

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }

  return next as MainNode
}

/** A node with fields set, or dropped when the value is undefined. */
function withNode(node: AgentNode, changes: Partial<AgentNode>): AgentNode {
  const next: Record<string, unknown> = { ...node }

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }

  return next as AgentNode
}

function sameFields<T extends object>(before: T, after: T): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])

  for (const key of keys) {
    if ((before as Record<string, unknown>)[key] !== (after as Record<string, unknown>)[key]) {
      return false
    }
  }

  return true
}

function replaceMain(tree: TreeSnapshot, main: MainNode, now: number): TreeSnapshot {
  return sameFields(tree.main, main) ? tree : { ...tree, main, updatedAt: now }
}

/** The tree with node `id` changed by `change`; the same tree when it is unknown or unchanged. */
function changeNode(tree: TreeSnapshot, id: string, change: (node: AgentNode) => AgentNode, now: number): TreeSnapshot {
  const index = tree.agents.findIndex(node => node.id === id)
  const node = tree.agents[index]

  if (node === undefined) {
    return tree
  }

  const changed = change(node)

  if (sameFields(node, changed)) {
    return tree
  }

  const agents = tree.agents.slice()
  agents[index] = changed

  return { ...tree, agents, updatedAt: now }
}

/** At most MAX_AGENTS nodes: finished ones go first, oldest end first; running ones only when nothing else is left. */
function prune(agents: AgentNode[]): AgentNode[] {
  if (agents.length <= MAX_AGENTS) {
    return agents
  }

  const age = (node: AgentNode): number => node.endedAt ?? node.startedAt ?? 0
  const byAge = agents
    .map((node, index) => ({ node, index }))
    .sort((a, b) => Number(isRunning(a.node)) - Number(isRunning(b.node)) || age(a.node) - age(b.node) || a.index - b.index)
  const dropped = new Set(byAge.slice(0, agents.length - MAX_AGENTS).map(entry => entry.index))

  return agents.filter((_, index) => !dropped.has(index))
}

const effortText = (effort: string | number | undefined): string | undefined =>
  effort === undefined ? undefined : String(effort)

/** Opens (or completes) the node of a started subagent. A denied spawn starts none. */
export function upsertFromSpawn(tree: TreeSnapshot, input: SpawnInput, result: SpawnResult, now: number): TreeSnapshot {
  const id = result.agentId

  if (id === undefined || id === '') {
    return tree
  }

  const model = result.model ?? input.model
  const known = tree.agents.find(node => node.id === id)

  if (known !== undefined) {
    return changeNode(
      tree,
      id,
      node =>
        withNode(node, {
          type: input.subagentType || node.type,
          description: input.description || node.description,
          model: model ?? node.model,
          background: input.background === true ? true : node.background,
          parentId: node.parentId ?? input.parentAgentId,
          startedAt: node.startedAt ?? now,
        }),
      now,
    )
  }

  const role = roleOf({ type: input.subagentType, description: input.description, prompt: input.prompt })
  const node = withNode(
    { id, type: input.subagentType, description: input.description, role, status: 'running', toolCalls: 0 },
    {
      parentId: input.parentAgentId,
      model,
      background: input.background === true ? true : undefined,
      startedAt: now,
    },
  )

  return { ...tree, agents: prune([...tree.agents, node]), updatedAt: now }
}

/**
 * Reconciles the ledger with `$.agent.list()`: a listed id's status is the
 * engine's, an unknown listed id becomes a node, and an id the list no longer
 * names keeps the status the ledger gave it (a finished foreground subagent
 * is dropped from the list; its turn.complete already closed the node).
 */
export function applyAgentList(tree: TreeSnapshot, agents: readonly ListedAgent[], now: number): TreeSnapshot {
  let next = tree

  for (const info of agents) {
    if (typeof info?.id !== 'string' || info.id === '') {
      continue
    }

    const known = next.agents.some(node => node.id === info.id)

    if (!known) {
      // The list names no prompt: the role comes from the type and the description (PRD section 9).
      const role = roleOf({ type: info.type, description: info.description })
      const node = withNode(
        { id: info.id, type: info.type, description: info.description, role, status: info.status, toolCalls: 0 },
        { parentId: info.parentId, startedAt: now, endedAt: info.status === 'running' ? undefined : now },
      )
      next = { ...next, agents: prune([...next.agents, node]), updatedAt: now }
      continue
    }

    next = changeNode(
      next,
      info.id,
      node => {
        const wasRunning = isRunning(node)
        const nowRunning = info.status === 'running'

        return withNode(node, {
          status: info.status,
          type: node.type || info.type,
          description: node.description || info.description,
          parentId: node.parentId ?? info.parentId,
          // Stopped: it ended no later than now. Running again (a resumed agent): no end yet.
          endedAt: nowRunning ? undefined : wasRunning ? (node.endedAt ?? now) : node.endedAt,
          durationMs: nowRunning ? undefined : node.durationMs,
        })
      },
      now,
    )
  }

  return next
}

/** One model request: the main loop thinks; a subagent's model and effort are recorded. */
export function applyStep(tree: TreeSnapshot, step: StepInfo): TreeSnapshot {
  const effort = effortText(step.effort)

  if (step.agentId === undefined) {
    const status: MainStatus = (tree.main.toolsRunning ?? 0) > 0 ? 'tooling' : 'thinking'

    return replaceMain(tree, withMain(tree.main, { model: step.model, effort, status }), step.now)
  }

  return changeNode(tree, step.agentId, node => withNode(node, { model: step.model || node.model, effort }), step.now)
}

/** The main loop's model and turn count as the session reports them. */
export function applyMain(tree: TreeSnapshot, info: MainInfo): TreeSnapshot {
  return replaceMain(
    tree,
    withMain(tree.main, {
      model: info.model === undefined || info.model === '' ? tree.main.model : info.model,
      turns: isFiniteNumber(info.turns) ? info.turns : tree.main.turns,
    }),
    info.now,
  )
}

/**
 * A tool call starts: the main loop is tooling; a subagent's last tool and
 * count move on, and a tool that writes files makes it a worker, one way
 * (PRD M-L1a): no later call makes it a researcher again.
 */
export function applyToolCall(tree: TreeSnapshot, call: ToolCallInfo): TreeSnapshot {
  if (call.agentId === undefined) {
    const running = (tree.main.toolsRunning ?? 0) + 1

    return replaceMain(tree, withMain(tree.main, { toolsRunning: running, status: 'tooling' }), call.now)
  }

  return changeNode(
    tree,
    call.agentId,
    node =>
      withNode(node, {
        lastTool: call.tool,
        toolCalls: node.toolCalls + 1,
        role: isWritingTool(call.tool) ? 'worker' : node.role,
      }),
    call.now,
  )
}

/** A tool call ended: the main loop thinks again after its last running tool. */
export function applyToolDone(tree: TreeSnapshot, done: ToolDoneInfo): TreeSnapshot {
  if (done.agentId !== undefined) {
    return tree
  }

  const running = Math.max(0, (tree.main.toolsRunning ?? 0) - 1)
  const status: MainStatus = running > 0 ? 'tooling' : tree.main.status === 'idle' ? 'idle' : 'thinking'

  return replaceMain(tree, withMain(tree.main, { toolsRunning: running, status }), done.now)
}

/** A turn ended: the main loop goes idle; a subagent completes on an answer and fails otherwise. */
export function applyTurnComplete(tree: TreeSnapshot, end: TurnEnd): TreeSnapshot {
  if (end.agentId === undefined) {
    return replaceMain(tree, withMain(tree.main, { status: 'idle', toolsRunning: 0 }), end.now)
  }

  const status = end.reason === 'answer' ? 'completed' : 'failed'

  return changeNode(
    tree,
    end.agentId,
    node =>
      withNode(node, {
        status,
        endedAt: end.now,
        durationMs: isFiniteNumber(end.durationMs) ? end.durationMs : node.durationMs,
      }),
    end.now,
  )
}

/** The node id of the external worker that the shell tool call `toolUseId` started. */
export function externalId(toolUseId: string): string {
  return `ext:${toolUseId}`
}

/**
 * Opens the node of an external worker (PRD M-L1b): `ext:<toolUseId>`, the
 * engine as its type, running from `now`. Its description is the call's
 * description, else the command's task, cut to 40 characters; its role is
 * roleOf's reading of the engine and that text (a worker unless the text
 * holds a research word). A call with no id, or one already open, changes
 * nothing.
 */
export function applyExternalStart(tree: TreeSnapshot, start: ExternalStart): TreeSnapshot {
  if (typeof start.toolUseId !== 'string' || start.toolUseId === '') {
    return tree
  }

  const id = externalId(start.toolUseId)

  if (tree.agents.some(node => node.id === id)) {
    return tree
  }

  // The call's description when it says anything, else the task: the node keeps its head, the role reads all of it.
  const text = taskText(start.description) === undefined ? start.task : start.description
  const node = withNode(
    {
      id,
      kind: 'external',
      type: start.engine,
      description: taskText(text) ?? '',
      role: roleOf({ type: start.engine, description: text ?? '' }),
      status: 'running',
      toolCalls: 0,
    },
    {
      parentId: start.agentId,
      model: start.model,
      background: start.background === true ? true : undefined,
      startedAt: start.now,
    },
  )

  return { ...tree, agents: prune([...tree.agents, node]), updatedAt: start.now }
}

/**
 * The shell tool call of an external worker returned. A background task id
 * in its result: the engine runs on in the background as that task (a call
 * the person or its timeout moved to the background too), still running.
 * Else an error, a deny or a rejected call fails it; an interrupted command
 * is killed (C7a2b); a background call is left running for `classic.Stop` to
 * reconcile; a foreground one completed. An unknown or finished node: the
 * same tree.
 */
export function applyExternalEnd(tree: TreeSnapshot, end: ExternalEnd): TreeSnapshot {
  return changeNode(
    tree,
    externalId(end.toolUseId),
    node => {
      if (!isRunning(node)) {
        return node
      }

      if (end.taskId !== undefined) {
        return withNode(node, { background: true, taskId: end.taskId })
      }

      if (end.isError) {
        return withNode(node, { status: 'failed', endedAt: end.now })
      }

      if (end.interrupted === true) {
        return withNode(node, { status: 'killed', endedAt: end.now })
      }

      return node.background === true ? node : withNode(node, { status: 'completed', endedAt: end.now })
    },
    end.now,
  )
}

/**
 * A loop's turn ended (C7a2b): an external worker that loop started in the
 * foreground and that still runs was cut off with it (an Esc, or a call
 * whose `next(e)` never came back), so it is killed at `now`. `loopId` is the
 * loop's agent id, undefined for the main loop. A worker run in the
 * background runs on, and another loop's is left alone. Nothing to close:
 * the same tree.
 */
export function closeForegroundExternals(tree: TreeSnapshot, loopId: string | undefined, now: number): TreeSnapshot {
  let next = tree

  for (const node of tree.agents) {
    if (node.kind !== 'external' || node.background === true || !isRunning(node) || node.parentId !== loopId) {
      continue
    }

    next = changeNode(next, node.id, running => withNode(running, { status: 'killed', endedAt: now }), now)
  }

  return next
}

/** The statuses of work in flight: `background_tasks` lists "running/pending" work (the d.ts's StopHookInput). */
const IN_FLIGHT: readonly string[] = ['running', 'pending']

/**
 * Whether `task` is `node`'s background task: by the task id its tool call's
 * result named; a node without one, by a shell task whose command starts the
 * node's engine with its model.
 */
function isTaskOf(task: BackgroundTask, node: AgentNode): boolean {
  if (typeof task !== 'object' || task === null) {
    return false
  }

  if (node.taskId !== undefined) {
    return task.id === node.taskId
  }

  if (task.type !== 'shell' || typeof task.command !== 'string') {
    return false
  }

  const worker = externalWorkerOf(task.command, [node.type])

  return worker !== undefined && worker.model === node.model
}

/**
 * Reconciles the external workers running in the background with the
 * `background_tasks` of `classic.Stop` or `classic.SubagentStop` (PRD M-L1b;
 * the latter from C7a2b): one whose task is still listed in flight runs on;
 * one whose task is no longer listed, or listed otherwise, completed at
 * `now`. Nothing changed: the same tree.
 */
export function applyBackgroundTasks(tree: TreeSnapshot, tasks: readonly BackgroundTask[], now: number): TreeSnapshot {
  if (!Array.isArray(tasks)) {
    return tree
  }

  let next = tree

  for (const node of tree.agents) {
    if (node.kind !== 'external' || node.background !== true || !isRunning(node)) {
      continue
    }

    if (tasks.some(task => isTaskOf(task, node) && IN_FLIGHT.includes(task.status ?? ''))) {
      continue
    }

    next = changeNode(next, node.id, running => withNode(running, { status: 'completed', endedAt: now }), now)
  }

  return next
}

/**
 * The nodes in drawing order: depth first by `parentId`, siblings by start
 * time. A node whose parent is not in the tree is drawn at the top level, and
 * a parent loop (which no engine makes) still draws every member once.
 */
export function flatten(tree: TreeSnapshot): FlatRow[] {
  const ids = new Set(tree.agents.map(node => node.id))
  const children = new Map<string | undefined, AgentNode[]>()

  for (const node of tree.agents) {
    const parent = node.parentId !== undefined && node.parentId !== node.id && ids.has(node.parentId) ? node.parentId : undefined
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }

  const order = (a: AgentNode, b: AgentNode): number =>
    (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  for (const list of children.values()) {
    list.sort(order)
  }

  const rows: FlatRow[] = []
  const seen = new Set<string>()

  const visit = (node: AgentNode, depth: number, guides: string, isLast: boolean): void => {
    if (seen.has(node.id)) {
      return
    }

    seen.add(node.id)
    rows.push({ node, depth, prefix: `${guides}${isLast ? '└─ ' : '├─ '}` })

    const kids = (children.get(node.id) ?? []).filter(kid => !seen.has(kid.id))
    kids.forEach((kid, index) => visit(kid, depth + 1, `${guides}${isLast ? '   ' : '│  '}`, index === kids.length - 1))
  }

  const roots = children.get(undefined) ?? []
  roots.forEach((root, index) => visit(root, 1, '', index === roots.length - 1))

  // Members of a parent loop: none of them is a root, so draw each unseen one from the top.
  const rest = tree.agents.filter(node => !seen.has(node.id)).sort(order)
  rest.forEach((node, index) => visit(node, 1, '', index === rest.length - 1))

  return rows
}

export function countRunning(tree: TreeSnapshot): number {
  return tree.agents.filter(isRunning).length
}
