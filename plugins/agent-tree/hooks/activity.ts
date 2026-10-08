// The live activity (PRD M-L3, M-L4; C7b): what each loop is doing right
// now, and the spinner, the moving dot and the times the pane draws from it.
// Pure, no `$`: register.tsx hands each turn.step, tool.call and
// turn.complete to these functions and writes what they return to the
// `activity` atom (types/index.d.ts), only when it changed. A tool call is
// in flight from its start until it returned, rejected, or its loop's turn
// ended; the main loop's phase follows its own calls. The advisor's and
// Jev's calls in flight live in their own atoms (C7c); isAnyActive counts
// them, a stale flag excepted (IN_FLIGHT_STALE_MS).

import type { ActivityCall, ActivitySnapshot, AgentNode, MainActivity, TreeSnapshot } from '../types'
import { formatAge } from './render/text'
import { SEP } from './stats'
import { countRunning } from './tree'

/** Nothing in flight: the main loop idle, no tool call. */
export const EMPTY_ACTIVITY: ActivitySnapshot = { main: { phase: 'idle' }, calls: [], updatedAt: 0 }

/** The most tool calls kept in flight: past it the oldest go (a call whose end never came, as a reload mid-call leaves). */
export const MAX_CALLS = 64

/** The spinner of a running box, one glyph per frame (PRD M-L3). */
export const SPINNER = ['◐', '◓', '◑', '◒'] as const

/** Frames in one round of the spinner and of the dot: the frame timer's 0 to 3 (PRD M-L4). */
export const FRAMES = SPINNER.length

/** `frame` as 0 to 3: any whole number taken round, anything else 0. */
function frameIndex(frame: number): number {
  return Number.isInteger(frame) ? ((frame % FRAMES) + FRAMES) % FRAMES : 0
}

/** The spinner glyph of `frame`: `◐ ◓ ◑ ◒` in turn. */
export function spinner(frame: number): string {
  return SPINNER[frameIndex(frame)] ?? SPINNER[0]
}

/**
 * Where the moving dot stands on a line of `length` cells at `frame` (PRD
 * M-L3): the four frames step it from the first cell to the last in even
 * steps, then it starts over; a line of one cell keeps it there. -1 when
 * there is no line.
 */
export function dotAt(frame: number, length: number): number {
  const cells = Math.floor(length)

  if (!Number.isFinite(cells) || cells < 1) {
    return -1
  }

  return Math.round((frameIndex(frame) * (cells - 1)) / (FRAMES - 1))
}

/** The time from `since` to `now` as a box shows it (`2s`, `3m04s`); `--` when `since` is unknown. */
export function elapsed(now: number, since: number | undefined): string {
  return since === undefined ? '--' : formatAge(now - since)
}

/**
 * How long a call of the advisor or of Jev counts as in flight at most (C7c):
 * a flag set this long ago or longer is stale (a reload dropped the result,
 * or the session lost it) and counts as idle, so it never keeps the frame
 * turning. Ten minutes: an advisor call takes seconds to a minute or two, a
 * Jev call about a second.
 */
export const IN_FLIGHT_STALE_MS = 600_000

/** The advisor or Jev snapshot as far as its call in flight goes (C7c). */
export type InFlight = { inFlight?: boolean; inFlightSince?: number }

/**
 * Whether a call of the advisor or of Jev is in flight at `now` (C7c): its
 * flag is set, with a start less than IN_FLIGHT_STALE_MS before `now` (a
 * start after `now` counts as just begun). A flag with no start is stale.
 */
export function isInFlight(call: InFlight, now: number): boolean {
  const since = call.inFlightSince

  return call.inFlight === true && typeof since === 'number' && Number.isFinite(since) && now - since < IN_FLIGHT_STALE_MS
}

/** Whether Jev is being called at `now` (C7c): Jev on, and its call in flight (isInFlight). */
export function isJevCalling(jev: InFlight & { enabled?: boolean }, now: number): boolean {
  return jev.enabled === true && isInFlight(jev, now)
}

/** What the status entry adds while Jev is being called (PRD M-L8). */
export const JEV_CALLING = 'jev …'

/** The status entry's text (stats.ts statusText) with JEV_CALLING after it while Jev is being called at `now` (C7c, PRD M-L8). */
export function withJevCall(text: string, jev: InFlight & { enabled?: boolean }, now: number): string {
  return isJevCalling(jev, now) ? `${text}${SEP}${JEV_CALLING}` : text
}

/**
 * Whether anything on the pane moves (PRD M-L4): the main loop is not idle,
 * a subagent or an external worker runs, or a call of the advisor or of Jev
 * is in flight at `now` (C7c: isInFlight, so a stale flag does not count).
 */
export function isAnyActive(
  tree: TreeSnapshot,
  activity: ActivitySnapshot,
  advisor: InFlight,
  jev: InFlight,
  now: number,
): boolean {
  return activity.main.phase !== 'idle' || countRunning(tree) > 0 || isInFlight(advisor, now) || isInFlight(jev, now)
}

/** A loop's current call: its latest call in flight (`agentId` undefined: the main loop's). */
export function currentCall(activity: ActivitySnapshot, agentId: string | undefined): ActivityCall | undefined {
  return activity.calls.filter(call => call.agentId === agentId).at(-1)
}

/** What a node is doing now: its current tool and since when (an external worker: since its start, no tool, as its tools are not seen). */
export type NodeActivity = { tool?: string; since?: number }

/** A running node's activity (nodeActivity); undefined once it stopped. */
export function nodeActivity(activity: ActivitySnapshot, node: AgentNode): NodeActivity | undefined {
  if (node.status !== 'running') {
    return undefined
  }

  if (node.kind === 'external') {
    return node.startedAt === undefined ? {} : { since: node.startedAt }
  }

  const call = currentCall(activity, node.id)

  return call === undefined ? {} : { tool: call.tool, since: call.since }
}

/** A model request starts (turn.step): an idle main loop thinks from `now`; anything else stays as it is. */
export function startStep(activity: ActivitySnapshot, step: { agentId?: string; now: number }): ActivitySnapshot {
  if (step.agentId !== undefined || activity.main.phase !== 'idle') {
    return activity
  }

  return { ...activity, main: { phase: 'thinking', since: step.now }, updatedAt: step.now }
}

/** The main loop's phase while `calls` are in flight: tooling its latest call, else what `otherwise` says. */
function mainWith(calls: readonly ActivityCall[], otherwise: MainActivity): MainActivity {
  const latest = calls.filter(call => call.agentId === undefined).at(-1)

  return latest === undefined ? otherwise : { phase: 'tooling', tool: latest.tool, since: latest.since }
}

/** A tool call starts: it is in flight from its `since`; the main loop's call makes it tooling that tool. */
export function startTool(activity: ActivitySnapshot, call: ActivityCall): ActivitySnapshot {
  const calls = [...activity.calls, call].slice(-MAX_CALLS)
  const main = call.agentId === undefined ? mainWith(calls, activity.main) : activity.main

  return { main, calls, updatedAt: call.since }
}

/**
 * A tool call ended, however (C7b: register.tsx calls this in a finally):
 * it leaves the calls in flight. The main loop's: tooling its latest call
 * still in flight, else thinking from `now`; an idle main loop stays idle.
 * A call no longer in flight (its turn ended first) changes nothing.
 */
export function endTool(activity: ActivitySnapshot, call: ActivityCall, now: number): ActivitySnapshot {
  const at = activity.calls.findIndex(
    entry => entry.id === call.id && entry.agentId === call.agentId && entry.tool === call.tool && entry.since === call.since,
  )

  if (at < 0) {
    return activity
  }

  const calls = activity.calls.filter((_, index) => index !== at)

  if (call.agentId !== undefined || activity.main.phase === 'idle') {
    return { ...activity, calls, updatedAt: now }
  }

  return { main: mainWith(calls, { phase: 'thinking', since: now }), calls, updatedAt: now }
}

/**
 * A turn ended: its loop's calls leave the calls in flight (no event closes
 * them now), and the main loop goes idle. Nothing to change: the same value.
 */
export function endTurn(activity: ActivitySnapshot, end: { agentId?: string; now: number }): ActivitySnapshot {
  const calls = activity.calls.filter(call => call.agentId !== end.agentId)
  const isSame = calls.length === activity.calls.length

  if (end.agentId !== undefined) {
    return isSame ? activity : { ...activity, calls, updatedAt: end.now }
  }

  return isSame && activity.main.phase === 'idle' ? activity : { main: { phase: 'idle' }, calls, updatedAt: end.now }
}
