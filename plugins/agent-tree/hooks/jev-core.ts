// Jev flags (PRD 7.4, plan 04): the whitelisted session summary, the question
// set, the call policy and the answer parsing. Pure functions, no `$`:
// hooks/register.tsx reads the key, makes the call and writes the `jev` atom
// with what these return. Nothing here holds a tool's input or result, a
// file, a path, a prompt or a reply: the event ring keeps a tool's name and
// whether it failed, and the summary is counts and whole minutes (PRD M-J3).

import type { JevEvent, JevEventKind, JevFlag, JevSide, JevSnapshot, StatsSnapshot, TreeSnapshot } from '../types'
import { countRunning, flatten } from './tree'

// The ring's event types are part of the state contract (the `jevEvents`
// atom holds the ring); they are exported here beside the functions on them.
export type { JevEvent, JevEventKind, JevSide }

/**
 * The version of the questions and criteria sent to Jev (PRD section 10). 2
 * (C7c): the summary counts the external engine runs apart
 * (`externalWorkers`), and `fanout_wide` judges Claude subagents and engine
 * runs each by its own count.
 */
export const JEV_PROMPT_VERSION = '2'

/** TypeSafe System One, which serves Jev (PRD section 9). */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** The model a request names; an answer names the build that served it (`jev-1.13.0`). */
export const JEV_MODEL = 'jev-latest'

/** The error the Jev area shows while Jev is on and the environment has no key (plan 04). */
export const JEV_NO_KEY = 'TYPESAFE_API_KEY not set'

/** Jev not called yet: the `jev` atom's initial value. */
export const EMPTY_JEV: JevSnapshot = { enabled: false, calls: 0, flags: [], inFlight: false }

// ---------------------------------------------------------------------------
// Questions and thresholds (PRD section 10: change them together with
// JEV_PROMPT_VERSION).

/** The four flags Jev is asked about. */
export type JevFlagKey = 'looping' | 'stuck' | 'fanout_wide' | 'near_done'

/** A yes-or-no question: Jev answers how likely `true` holds, 0 to 1 (`noul`). */
export type NoulQuestion = {
  type: 'noul'
  instructions: string
  criteria: { true: string; false: string }
}

/** A graded question: Jev answers a score from 0 to the last level, with its confidence. */
export type ScoreQuestion = {
  type: 'score'
  instructions: string
  /** One per level, level 0 first. */
  criteria: readonly string[]
}

/** The flags in drawing order, each with the label the pane draws. */
export const JEV_FLAGS: readonly { key: JevFlagKey; label: string }[] = [
  { key: 'looping', label: 'looping' },
  { key: 'stuck', label: 'stuck' },
  { key: 'fanout_wide', label: 'fan-out wide' },
  { key: 'near_done', label: 'near done' },
]

/** The health score's levels, 0 to 2, by the names the pane draws. */
export const HEALTH_LEVELS = ['healthy', 'needs attention', 'intervene now'] as const

/** The question set: four flags and the health score (PRD M-J4). */
export const JEV_QUESTIONS: Readonly<Record<JevFlagKey, NoulQuestion>> & { readonly health: ScoreQuestion } = {
  looping: {
    type: 'noul',
    instructions: 'Is the session repeating the same tool call pattern without visible progress?',
    criteria: {
      true: 'The latest tool calls repeat one tool, or one short cycle of tools, on the same side (main or sub), with errors or no new kind of work in between: consecutiveSameTool 5 or more, or repeatsPrevious true for most of recentTools.',
      false: 'Tool calls vary, or repeats are broken up by other tools, finished agents or successful results.',
    },
  },
  stuck: {
    type: 'noul',
    instructions: 'Is the session stuck?',
    criteria: {
      true: 'Several tool calls in a row end in errors (consecutiveErrors 3 or more), or agents are still running but no tool call came for several minutes (minutesSinceLastTool 5 or more).',
      false: 'Recent tool calls succeed and work moves: new tool calls within the last minutes, agents finishing, or the session idle between prompts with no agent running.',
    },
  },
  fanout_wide: {
    type: 'noul',
    instructions:
      'Is the work fanned out too wide at once? agents counts Claude subagents and external engine runs (coding CLIs such as kimi or codex started from a shell tool) together; externalWorkers counts the engine runs among them, so the Claude subagents are agents minus externalWorkers.',
    criteria: {
      true: 'More than about four Claude subagents run at once (agents.running minus externalWorkers.running above 4), more than about four external engine runs at once (externalWorkers.running above 4), or subagents spawn subagents of their own several levels deep (agents.maxDepth 3 or more).',
      false: 'At most three Claude subagents and at most three external engine runs run at once, and nesting stays shallow.',
    },
  },
  near_done: {
    type: 'noul',
    instructions: 'Does the session look close to done?',
    criteria: {
      true: 'Recent events look like wrap-up: no subagent is running (agents.running 0), no new spawns, and the latest tool calls succeed (consecutiveErrors 0).',
      false: 'Subagents are still being spawned or running, or errors are still being fixed.',
    },
  },
  health: {
    type: 'score',
    instructions: 'How healthy is this agent session right now?',
    criteria: [
      `${HEALTH_LEVELS[0]}: work progresses with few errors`,
      `${HEALTH_LEVELS[1]}: signs of repetition, errors or idle agents`,
      `${HEALTH_LEVELS[2]}: stuck, looping or failing repeatedly`,
    ],
  },
}

/** A flag is sharp when its probability is at least this far from 0.5 (p >= 0.8 or p <= 0.2), split otherwise. */
export const SHARP_DISTANCE = 0.3

/** A health score answered with less confidence than this is drawn dim, `low confidence` (PRD section 10). */
export const LOW_CONFIDENCE = 0.3

/** From this probability a looping or stuck flag is drawn in the fail red. */
export const ALERT_P = 0.8

/** The flags drawn in the fail red from ALERT_P. */
export const ALERT_FLAGS: readonly string[] = ['looping', 'stuck']

// ---------------------------------------------------------------------------
// The event ring.

/** The most events the ring keeps. */
export const JEV_RING_SIZE = 50

/** The most tool calls the summary lists. */
export const JEV_RECENT_TOOLS = 20

const KINDS: readonly string[] = ['tool', 'turn', 'prompt']

/** A tool name longer than this is cut. */
const MAX_TOOL_NAME = 64

/** What a tool's name is made of (`Read`, `mcp__server__tool`): no separator, no space. */
const TOOL_NAME = /^[\w.:-]+$/

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * A tool's name as the ring keeps it: letters, digits and `_ . : -`, cut to
 * 64. Anything else (a path, a command line) is not a tool's name and is
 * kept as `?`, so no part of it reaches Jev.
 */
function toolName(name: unknown): string {
  return typeof name === 'string' && TOOL_NAME.test(name) ? name.slice(0, MAX_TOOL_NAME) : '?'
}

/** The whitelisted copy of an event, or undefined when it has no known kind or no time. */
function cleanEvent(event: JevEvent): JevEvent | undefined {
  if (typeof event?.kind !== 'string' || !KINDS.includes(event.kind) || !isFiniteNumber(event.at)) {
    return undefined
  }

  return {
    kind: event.kind,
    agent: event.agent === 'sub' ? 'sub' : 'main',
    ...(event.kind === 'tool' ? { tool: toolName(event.tool) } : {}),
    ...(event.kind === 'prompt' ? {} : { isError: event.isError === true }),
    at: event.at,
  }
}

/**
 * The ring with `event` added: only its kind, side, tool name, error flag
 * and time are kept, whatever else it carries. Past JEV_RING_SIZE the oldest
 * event goes, except the latest prompt, which stays however many tool calls
 * follow it (minutesSinceLastUserPrompt reads it). The same ring when the
 * event has no known kind or no time.
 */
export function pushEvent(ring: readonly JevEvent[], event: JevEvent): readonly JevEvent[] {
  const clean = cleanEvent(event)

  if (clean === undefined) {
    return ring
  }

  const next = [...ring, clean]

  while (next.length > JEV_RING_SIZE) {
    const isLatestPrompt = next[0]?.kind === 'prompt' && !next.slice(1).some(kept => kept.kind === 'prompt')
    next.splice(isLatestPrompt ? 1 : 0, 1)
  }

  return next
}

/** How many events of the ring happened after `since`; all of them before the first call. */
export function eventsSince(ring: readonly JevEvent[], since: number | undefined): number {
  return since === undefined ? ring.length : ring.filter(event => event.at > since).length
}

/**
 * Whether an activation empties the ring (C4c): Jev is on now and the `jev`
 * snapshot it found was not on (Jev was off, or the state is fresh). The ring
 * records while Jev is off, so without this the first summary after turning
 * Jev on would name tools used before. Every other activation keeps the ring:
 * Jev staying on, staying off, or turned off.
 */
export function shouldClearRing(previous: JevSnapshot, enabledNow: boolean): boolean {
  return enabledNow && previous.enabled !== true
}

// ---------------------------------------------------------------------------
// The summary Jev reads as `state`.

/** One recent tool call as Jev sees it. */
export type JevToolRow = {
  agent: JevSide
  tool: string
  isError: boolean
  /** The previous call on the same side used the same tool. */
  repeatsPrevious: boolean
}

/** Everything Jev is told about the session (PRD M-J3); a figure not known yet is null, never 0. */
export type JevSummary = {
  /** Whole minutes since the session started. */
  minutesActive: number | null
  /** Prompts the person has sent. */
  turns: number
  contextPercent: number | null
  /** Every node of the tree: Claude subagents and external engine runs alike (since C7a2). */
  agents: { total: number; running: number; failed: number; maxDepth: number }
  /** The external engine runs among `agents` (C7c): two counts, never an engine, model, command or task. */
  externalWorkers: { total: number; running: number }
  /** The latest JEV_RECENT_TOOLS tool calls, oldest first. */
  recentTools: JevToolRow[]
  /** The latest tool calls in a row that ended in an error. */
  consecutiveErrors: number
  /** On the side of the latest tool call, its latest calls in a row with that tool. */
  consecutiveSameTool: number
  minutesSinceLastTool: number | null
  minutesSinceLastUserPrompt: number | null
}

const minutesSince = (at: number | undefined, now: number): number | null =>
  isFiniteNumber(at) ? Math.floor(Math.max(0, now - at) / 60_000) : null

/** Failed or killed: the subagents the pane draws in the fail red. */
const isFailed = (status: string): boolean => status === 'failed' || status === 'killed'

function lastOfKind(events: readonly JevEvent[], kind: JevEventKind): JevEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]

    if (event?.kind === kind) {
      return event
    }
  }

  return undefined
}

function toolRows(tools: readonly JevEvent[]): JevToolRow[] {
  const previous: Partial<Record<JevSide, string>> = {}

  return tools.map(event => {
    const tool = event.tool ?? '?'
    const row = { agent: event.agent, tool, isError: event.isError === true, repeatsPrevious: previous[event.agent] === tool }
    previous[event.agent] = tool

    return row
  })
}

function trailingErrors(tools: readonly JevEvent[]): number {
  let count = 0

  for (let index = tools.length - 1; index >= 0 && tools[index]?.isError === true; index -= 1) {
    count += 1
  }

  return count
}

function sameToolRun(tools: readonly JevEvent[]): number {
  const latest = tools[tools.length - 1]
  let run = 0

  for (let index = tools.length - 1; latest !== undefined && index >= 0; index -= 1) {
    const event = tools[index]

    if (event === undefined || event.agent !== latest.agent) {
      continue
    }

    if (event.tool !== latest.tool) {
      break
    }

    run += 1
  }

  return run
}

/**
 * The summary Jev reads, built from the agent tree, the stats and the event
 * ring: counts (the external engine runs apart too, C7c), whole minutes, the
 * context percent, and the latest tool calls by side and name. No
 * description, engine, model, id, path, command or text reaches it.
 */
export function buildSummary(
  tree: TreeSnapshot,
  stats: StatsSnapshot,
  events: readonly JevEvent[],
  now: number,
): JevSummary {
  const tools = events.filter(event => event.kind === 'tool')
  const externals = tree.agents.filter(node => node.kind === 'external')

  return {
    minutesActive: minutesSince(stats.startedAt, now),
    turns: isFiniteNumber(tree.main.turns) ? tree.main.turns : 0,
    contextPercent: isFiniteNumber(stats.contextPercent) ? Math.round(stats.contextPercent) : null,
    agents: {
      total: tree.agents.length,
      running: countRunning(tree),
      failed: tree.agents.filter(node => isFailed(node.status)).length,
      maxDepth: flatten(tree).reduce((deepest, row) => Math.max(deepest, row.depth), 0),
    },
    externalWorkers: {
      total: externals.length,
      running: externals.filter(node => node.status === 'running').length,
    },
    recentTools: toolRows(tools).slice(-JEV_RECENT_TOOLS),
    consecutiveErrors: trailingErrors(tools),
    consecutiveSameTool: sameToolRun(tools),
    minutesSinceLastTool: minutesSince(tools[tools.length - 1]?.at, now),
    minutesSinceLastUserPrompt: minutesSince(lastOfKind(events, 'prompt')?.at, now),
  }
}

/** The summary's fields and nothing else, whatever else the object carries. */
function whitelisted(summary: JevSummary): JevSummary {
  return {
    minutesActive: summary.minutesActive,
    turns: summary.turns,
    contextPercent: summary.contextPercent,
    agents: {
      total: summary.agents.total,
      running: summary.agents.running,
      failed: summary.agents.failed,
      maxDepth: summary.agents.maxDepth,
    },
    externalWorkers: {
      total: summary.externalWorkers.total,
      running: summary.externalWorkers.running,
    },
    recentTools: summary.recentTools.map(row => ({
      agent: row.agent,
      tool: row.tool,
      isError: row.isError,
      repeatsPrevious: row.repeatsPrevious,
    })),
    consecutiveErrors: summary.consecutiveErrors,
    consecutiveSameTool: summary.consecutiveSameTool,
    minutesSinceLastTool: summary.minutesSinceLastTool,
    minutesSinceLastUserPrompt: summary.minutesSinceLastUserPrompt,
  }
}

/** The request body for JEV_ENDPOINT: `{ model, state, questions }` as JSON text, the summary as `state`. */
export function buildRequestBody(summary: JevSummary): string {
  return JSON.stringify({ model: JEV_MODEL, state: whitelisted(summary), questions: JEV_QUESTIONS })
}

// ---------------------------------------------------------------------------
// Answers.

/** One answer: a noul probability, or a score with its confidence. */
export type JevAnswer = { type: 'noul'; noul: number } | { type: 'score'; score: number; confidence?: number }

/** What one response carried that the pane and the debug log use. */
export type JevAnswers = {
  /** The Jev build that answered (`jev-1.13.0`). */
  model?: string
  answers: Partial<Record<JevFlagKey | 'health', JevAnswer>>
  usage?: { inputTokens: number; outputTokens: number }
}

/** Flags, health score and its confidence mark, as the `jev` atom holds them. */
export type JevDecision = {
  flags: JevFlag[]
  health?: number
  healthLowConfidence?: boolean
}

const ANSWER_KEYS: readonly (JevFlagKey | 'health')[] = [...JEV_FLAGS.map(flag => flag.key), 'health']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readAnswer(raw: unknown): JevAnswer | undefined {
  if (!isRecord(raw)) {
    return undefined
  }

  if (raw.type === 'noul' && isFiniteNumber(raw.noul)) {
    return { type: 'noul', noul: clamp(raw.noul, 0, 1) }
  }

  if (raw.type === 'score' && isFiniteNumber(raw.score)) {
    return isFiniteNumber(raw.confidence)
      ? { type: 'score', score: raw.score, confidence: clamp(raw.confidence, 0, 1) }
      : { type: 'score', score: raw.score }
  }

  return undefined
}

/**
 * The answers of a System One response (its body as text, or already
 * parsed): the five questions' answers, the model and the token usage. A
 * response that is not JSON, or answers none of the questions, is undefined.
 */
export function parseAnswers(json: unknown): JevAnswers | undefined {
  let data = json

  if (typeof json === 'string') {
    try {
      data = JSON.parse(json)
    } catch {
      return undefined
    }
  }

  if (!isRecord(data) || !isRecord(data.answers)) {
    return undefined
  }

  const answers: JevAnswers['answers'] = {}

  for (const key of ANSWER_KEYS) {
    const answer = readAnswer(data.answers[key])

    if (answer !== undefined) {
      answers[key] = answer
    }
  }

  if (Object.keys(answers).length === 0) {
    return undefined
  }

  const parsed: JevAnswers = { answers }

  if (typeof data.model === 'string' && data.model !== '') {
    parsed.model = data.model.slice(0, MAX_TOOL_NAME)
  }

  const usage = data.usage

  if (isRecord(usage) && isFiniteNumber(usage.input_tokens) && isFiniteNumber(usage.output_tokens)) {
    parsed.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
  }

  return parsed
}

/**
 * One debug-log line for an answer (PRD section 10: the time, the tokens and
 * each answer's figure, kept in memory and the debug log only), with how many
 * ring events the summary was built from, a count and no names (C4c):
 * `jev answer at 2026-10-02T08:01:43.857Z events 4 model jev-1.13.0 in 1030 out 87 looping 0.41 ... health 0.91 confidence 0.85`.
 */
export function answerLogLine(parsed: JevAnswers, now: number, events: number): string {
  const parts = [`jev answer at ${new Date(now).toISOString()}`, `events ${events}`, `model ${parsed.model ?? '?'}`]

  if (parsed.usage !== undefined) {
    parts.push(`in ${parsed.usage.inputTokens} out ${parsed.usage.outputTokens}`)
  }

  for (const key of ANSWER_KEYS) {
    const answer = parsed.answers[key]

    if (answer?.type === 'noul') {
      parts.push(`${key} ${answer.noul.toFixed(2)}`)
    } else if (answer?.type === 'score') {
      const confidence = answer.confidence === undefined ? '' : ` confidence ${answer.confidence.toFixed(2)}`
      parts.push(`${key} ${answer.score.toFixed(2)}${confidence}`)
    }
  }

  return parts.join(' ')
}

/** Sharp at p >= 0.8 or p <= 0.2, split between. */
export const isSharp = (p: number): boolean => Math.abs(p - 0.5) >= SHARP_DISTANCE

/**
 * The flags in drawing order, each answered one with its probability and
 * sharp or split; the health score (0 to 2) and whether its confidence is
 * under LOW_CONFIDENCE. An unanswered question is left out.
 */
export function decideFlags(answers: JevAnswers): JevDecision {
  const flags: JevFlag[] = []

  for (const { key, label } of JEV_FLAGS) {
    const answer = answers.answers[key]

    if (answer?.type === 'noul') {
      flags.push({ key, label, p: answer.noul, sharp: isSharp(answer.noul) })
    }
  }

  const health = answers.answers.health

  if (health?.type !== 'score') {
    return { flags }
  }

  return {
    flags,
    health: clamp(health.score, 0, HEALTH_LEVELS.length - 1),
    healthLowConfidence: health.confidence !== undefined && health.confidence < LOW_CONFIDENCE,
  }
}

/**
 * A Jev call answered at `now`: one more call, its flags and health score,
 * no error; the call times and the call in flight kept (endCall clears the
 * flag in the same write, C7c).
 */
export function applyAnswers(snapshot: JevSnapshot, parsed: JevAnswers, now: number): JevSnapshot {
  const decision = decideFlags(parsed)
  const next: JevSnapshot = {
    enabled: snapshot.enabled,
    calls: snapshot.calls + 1,
    lastAt: now,
    flags: decision.flags,
    inFlight: snapshot.inFlight === true,
  }

  if (snapshot.inFlightSince !== undefined) {
    next.inFlightSince = snapshot.inFlightSince
  }

  if (snapshot.callTimes !== undefined) {
    next.callTimes = snapshot.callTimes
  }

  if (decision.health !== undefined) {
    next.health = decision.health
    next.healthLowConfidence = decision.healthLowConfidence === true
  }

  return next
}

/** The longest error the Jev area keeps. */
const MAX_ERROR = 120

/** One line, a bearer token masked, at most MAX_ERROR characters. */
function errorText(message: string): string {
  const line = String(message)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
    .trim()
  const chars = Array.from(line)

  if (chars.length === 0) {
    return 'unknown error'
  }

  return chars.length > MAX_ERROR ? `${chars.slice(0, MAX_ERROR - 1).join('')}~` : line
}

/**
 * A failure at `now`: the message becomes `error`, and the flags, the health
 * score and its confidence mark of the last answer stay, so the Jev area
 * draws them with the error on a row below (C4f) until the next answer. The
 * calls count answers only, but `lastAt` moves, so a failed call waits out
 * the interval like an answered one (PRD section 11: no retry storm).
 */
export function applyError(snapshot: JevSnapshot, message: string, now: number): JevSnapshot {
  return { ...snapshot, lastAt: now, error: errorText(message) }
}

const HTTP_REASONS: Readonly<Record<number, string>> = {
  400: 'request refused',
  401: 'key rejected',
  403: 'forbidden',
  404: 'endpoint not found',
  408: 'timed out',
  413: 'request too large',
  429: 'rate limited',
}

/** `HTTP 401 key rejected`: the status and a short reason, never the response body (plan 04). */
export function httpErrorText(status: number): string {
  const reason = HTTP_REASONS[status] ?? (status >= 500 ? 'server error' : undefined)

  return reason === undefined ? `HTTP ${status}` : `HTTP ${status} ${reason}`
}

/**
 * `text` (a failed call's error, for the debug log) with every copy of
 * `secret` and any bearer token masked: the key never reaches a log line.
 */
export function withoutSecret(text: string, secret: string): string {
  const masked = secret === '' ? String(text) : String(text).split(secret).join('***')

  return masked.replace(/\bBearer\s+\S+/gi, 'Bearer ***')
}

// ---------------------------------------------------------------------------
// The call policy.

/** What the call policy decides on (plan 04). */
export type JevCallState = {
  enabled: boolean
  hasKey: boolean
  /** Events recorded since the last call (eventsSince). */
  newEventsSinceLast: number
  callsThisHour: number
  maxPerHour: number
  /** When Jev was last asked, answered or failed; absent before the first call. */
  lastAt?: number
  intervalSec: number
  now: number
}

/** The `jevIntervalSec` option's bounds and default, as the manifest declares them. */
const INTERVAL_SEC = { min: 15, max: 600, fallback: 60 } as const

/** The `jevMaxCallsPerHour` option's bounds and default, as the manifest declares them. */
const MAX_PER_HOUR = { min: 1, max: 240, fallback: 60 } as const

function boundedOption(value: unknown, bounds: { min: number; max: number; fallback: number }): number {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN

  return Number.isFinite(number) ? clamp(Math.round(number), bounds.min, bounds.max) : bounds.fallback
}

/** The `jevIntervalSec` option in seconds: within 15 to 600, 60 when unreadable. */
export function jevIntervalSec(value: unknown): number {
  return boundedOption(value, INTERVAL_SEC)
}

/** The `jevMaxCallsPerHour` option: within 1 to 240, 60 when unreadable. */
export function jevMaxPerHour(value: unknown): number {
  return boundedOption(value, MAX_PER_HOUR)
}

const HOUR_MS = 3_600_000

/**
 * The call times of the last hour, oldest first: what to keep, and its
 * length is `callsThisHour`. A time an hour old or older, or not a time, goes.
 */
export function callsWithinHour(times: readonly number[], now: number): number[] {
  return times.filter(at => isFiniteNumber(at) && now - at < HOUR_MS)
}

/**
 * A call about to be made at `now`: its time joins the call times of the
 * last hour (the cap counts every attempt, a failed one too), and `lastAt`
 * moves, so a tick that comes while the call runs waits out the interval
 * instead of calling again. The answer or the failure moves `lastAt` to the
 * same time. The same write marks the call in flight from `since` (C7c; the
 * clock the pane is drawn on, which `now` need not be) until endCall.
 */
export function startCall(snapshot: JevSnapshot, now: number, since: number): JevSnapshot {
  return {
    ...snapshot,
    lastAt: now,
    callTimes: [...callsWithinHour(snapshot.callTimes ?? [], now), now],
    inFlight: true,
    inFlightSince: since,
  }
}

/** The snapshot with no call in flight. */
function withoutCall(snapshot: JevSnapshot): JevSnapshot {
  const { inFlightSince: _since, ...rest } = snapshot

  return { ...rest, inFlight: false }
}

/**
 * The call claimed at `since` came back, answered or failed (C7c): its flag
 * is cleared, in the write of the answer or the failure. A flag set by a
 * later claim, or none (session.start cleared it), stays as it is: each call
 * clears its own flag only. The very snapshot when there is nothing to clear.
 */
export function endCall(snapshot: JevSnapshot, since: number): JevSnapshot {
  return snapshot.inFlight === true && snapshot.inFlightSince === since ? withoutCall(snapshot) : snapshot
}

/**
 * A call left in flight by the environment before this activation (a reload
 * drops the answer it was waiting for): the flag cleared at session.start
 * (C7c). The very snapshot when no flag is set.
 */
export function clearJevInFlight(snapshot: JevSnapshot): JevSnapshot {
  return snapshot.inFlight === true || snapshot.inFlightSince !== undefined ? withoutCall(snapshot) : snapshot
}

/**
 * Whether a Jev call is due (PRD M-J5): Jev is on, the key is there, events
 * arrived since the last call, the hour's calls are under the cap, and the
 * interval has passed since the last call (none before the first one).
 */
export function shouldCall(state: JevCallState): boolean {
  if (!state.enabled || !state.hasKey || !(state.newEventsSinceLast > 0)) {
    return false
  }

  if (!(state.callsThisHour < jevMaxPerHour(state.maxPerHour))) {
    return false
  }

  return !isFiniteNumber(state.lastAt) || state.now - state.lastAt >= jevIntervalSec(state.intervalSec) * 1000
}
