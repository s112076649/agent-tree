// Advisor figures (plan 03, path A of the C0 spike): pure functions, no `$`.
// Calls and their timing come from the main loop's response rows as
// `session.append` hands them: a `server_tool_use` block named `advisor`
// starts a call, an `advisor_tool_result` block ends it. The advisor's model
// and tokens are on no event; register.tsx reads them from the transcript
// file a moment after a stop that follows a new call. The advice is encrypted
// by the API (`advisor_redacted_result`): nothing here reads or keeps it. A
// call is in flight from its start to its result (C7c), and the latest five
// results are kept with their latency for the advisor box.

import type { AdvisorCall, AdvisorSnapshot } from '../types'

/** No advisor call seen: the `advisor` atom's initial value. */
export const EMPTY_ADVISOR: AdvisorSnapshot = { calls: 0, source: 'none', inFlight: false, recentCalls: [] }

/** How many calls whose result came the advisor box lists (PRD M-L5). */
export const MAX_RECENT_CALLS = 5

/** How long after a stop the transcript is read: the last response reaches the file within 250 ms of it (C0). */
export const TRANSCRIPT_DELAY_MS = 400

/** How long after a read that failed, or found fewer calls than counted, the one more read comes. */
export const TRANSCRIPT_RETRY_MS = 1500

/** The largest transcript read: `$.fs.read` refuses a file over 4 MiB and reads no range. */
export const TRANSCRIPT_MAX_BYTES = 3.5 * 1024 * 1024

/** Why the tokens are not shown: the transcript is past TRANSCRIPT_MAX_BYTES. */
export const TOO_LARGE = 'transcript too large'

/** Why the tokens are not shown: the transcript could not be stat'ed or read. */
export const READ_FAILED = 'transcript read failed'

/** How many call ids the double-count guard keeps. */
const MAX_CALL_IDS = 20

/** One row `session.append` hands over: the loop that keeps it (absent or null on main) and its blocks. */
export type AppendedRow = {
  agentId?: string | null
  content: unknown
}

/** What a transcript says about the main loop's advisor: totals over every advisor call in it. */
export type TranscriptAdvisor = {
  /** The model of the latest `advisor_message` iteration. */
  model?: string
  /** `advisor_message` iterations, each API response counted once. */
  iterations: number
  inputTokens: number
  outputTokens: number
  /** The cross-check: advisor `server_tool_use` and `advisor_tool_result` blocks, each block counted once. */
  serverToolUses: number
  results: number
}

/** An advisor block of a row: a call starting (its id) or a result (the id of its call). */
type AdvisorBlock = { kind: 'call' | 'result'; id?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const isMainLoop = (agentId: unknown): boolean => agentId === undefined || agentId === null

/** The advisor blocks of a row's content, in order; a client tool that happens to be named advisor is not one. */
function advisorBlocksOf(content: unknown): AdvisorBlock[] {
  const blocks: AdvisorBlock[] = []

  if (!Array.isArray(content)) {
    return blocks
  }

  for (const block of content) {
    if (!isRecord(block)) {
      continue
    }

    if (block.type === 'server_tool_use' && block.name === 'advisor') {
      blocks.push({ kind: 'call', id: textOf(block.id) })
    } else if (block.type === 'advisor_tool_result') {
      blocks.push({ kind: 'result', id: textOf(block.tool_use_id) })
    }
  }

  return blocks
}

/** How many advisor calls and results a row's content holds. */
export function countAdvisorBlocks(content: unknown): { serverToolUses: number; results: number } {
  const blocks = advisorBlocksOf(content)
  const serverToolUses = blocks.filter(block => block.kind === 'call').length

  return { serverToolUses, results: blocks.length - serverToolUses }
}

/** Whether a row can change the advisor figures: a main-loop row holding an advisor block. */
export function isAdvisorRow(row: AppendedRow): boolean {
  return isMainLoop(row.agentId) && advisorBlocksOf(row.content).length > 0
}

/** A snapshot with fields set, or dropped when the value is undefined (state holds no `undefined`). */
function withFields(snapshot: AdvisorSnapshot, changes: Partial<AdvisorSnapshot>): AdvisorSnapshot {
  const next: Record<string, unknown> = { ...snapshot }

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }

  return next as AdvisorSnapshot
}

/** The kept ids with `id` added, the oldest dropped past MAX_CALL_IDS. */
function remember(ids: readonly string[] | undefined, id: string | undefined): string[] | undefined {
  if (id === undefined || ids?.includes(id) === true) {
    return ids === undefined ? undefined : [...ids]
  }

  return [...(ids ?? []), id].slice(-MAX_CALL_IDS)
}

const appendSource = (snapshot: AdvisorSnapshot): AdvisorSnapshot['source'] =>
  snapshot.source === 'none' ? 'append' : snapshot.source

/** The calls the advisor box lists with `call` added, the oldest dropped past MAX_RECENT_CALLS. */
function withRecent(calls: readonly AdvisorCall[] | undefined, call: AdvisorCall): AdvisorCall[] {
  return [...(calls ?? []), call].slice(-MAX_RECENT_CALLS)
}

/** A call starts: counted once, and in flight from `now` (C7c). */
function startCall(snapshot: AdvisorSnapshot, id: string | undefined, now: number): AdvisorSnapshot {
  if (id !== undefined && snapshot.callIds?.includes(id) === true) {
    return snapshot // The same block again.
  }

  return withFields(snapshot, {
    calls: snapshot.calls + 1,
    lastCallStartedAt: now,
    pendingCallId: id ?? '',
    callIds: remember(snapshot.callIds, id),
    source: appendSource(snapshot),
    inFlight: true,
    inFlightSince: now,
  })
}

/**
 * A result arrives: the call in flight ends, with its latency, and joins the
 * calls the box lists (C7c). A result whose start was not seen joins them
 * with no latency and leaves the flag as it was (another call may be out).
 */
function endCall(snapshot: AdvisorSnapshot, id: string | undefined, now: number): AdvisorSnapshot {
  const pending = snapshot.pendingCallId

  if (pending !== undefined && (pending === '' || id === undefined || pending === id)) {
    const startedAt = snapshot.lastCallStartedAt
    const latencyMs = isFiniteNumber(startedAt) ? Math.max(0, now - startedAt) : undefined

    return withFields(snapshot, {
      lastCallAt: now,
      lastLatencyMs: latencyMs,
      pendingCallId: undefined,
      callIds: remember(snapshot.callIds, id),
      inFlight: false,
      inFlightSince: undefined,
      recentCalls: withRecent(snapshot.recentCalls, latencyMs === undefined ? { at: now } : { at: now, latencyMs }),
    })
  }

  if (id === undefined || snapshot.callIds?.includes(id) === true) {
    return snapshot // The same result again, or one naming no call.
  }

  // A result whose start this plugin did not see (loaded mid-call): its call counts once, with no latency.
  return withFields(snapshot, {
    calls: snapshot.calls + 1,
    lastCallAt: now,
    lastLatencyMs: undefined,
    callIds: remember(snapshot.callIds, id),
    source: appendSource(snapshot),
    recentCalls: withRecent(snapshot.recentCalls, { at: now }),
  })
}

/**
 * A call left in flight by the environment before this activation (a reload
 * drops the result it was waiting for): the flag cleared at session.start
 * (C7c). The pending call id stays, so a result that still comes is counted
 * with its latency. The very snapshot when no flag is set.
 */
export function clearAdvisorInFlight(snapshot: AdvisorSnapshot): AdvisorSnapshot {
  return snapshot.inFlight === true || snapshot.inFlightSince !== undefined
    ? withFields(snapshot, { inFlight: false, inFlightSince: undefined })
    : snapshot
}

/**
 * Counts one appended row into the snapshot: each advisor call once, however
 * its response is split into rows (C0: one row per block) and if a block comes
 * again. Subagent rows are left out: the pane counts the main loop's advisor.
 * Returns the very snapshot it was given when nothing changed.
 */
export function applyAppend(snapshot: AdvisorSnapshot, row: AppendedRow, now: number): AdvisorSnapshot {
  if (!isMainLoop(row.agentId)) {
    return snapshot
  }

  let next = snapshot

  for (const block of advisorBlocksOf(row.content)) {
    next = block.kind === 'call' ? startCall(next, block.id, now) : endCall(next, block.id, now)
  }

  return next
}

/**
 * The advisor's model and token totals in a transcript (JSONL), main loop
 * only. Each API response counts once: the transcript keeps it as one row per
 * block, each row repeating the response's usage, so rows are taken by
 * `message.id`. Sums the `advisor_message` entries of `usage.iterations`;
 * blank and broken lines are skipped, and so are subagent (`isSidechain`)
 * rows. The row-level `advisorModel` is not read: it names the main model in a
 * session without an advisor.
 */
export function parseTranscript(text: string): TranscriptAdvisor {
  const found: TranscriptAdvisor = { iterations: 0, inputTokens: 0, outputTokens: 0, serverToolUses: 0, results: 0 }
  const responses = new Set<string>()
  const blocks = new Set<string>()

  for (const line of text.split('\n')) {
    // Every assistant row holds the word; this spares parsing tool results and attachments.
    if (!line.includes('"assistant"')) {
      continue
    }

    let row: unknown

    try {
      row = JSON.parse(line)
    } catch {
      continue
    }

    if (!isRecord(row) || row.type !== 'assistant' || row.isSidechain === true || !isRecord(row.message)) {
      continue
    }

    const message = row.message
    const rowId = String(row.uuid)

    advisorBlocksOf(message.content).forEach((block, index) => {
      const key = `${block.kind} ${block.id ?? `${rowId}#${index}`}`

      if (!blocks.has(key)) {
        blocks.add(key)
        found[block.kind === 'call' ? 'serverToolUses' : 'results'] += 1
      }
    })

    const responseId = textOf(message.id) ?? textOf(row.requestId) ?? textOf(row.uuid)

    if (responseId !== undefined) {
      if (responses.has(responseId)) {
        continue
      }

      responses.add(responseId)
    }

    const usage = isRecord(message.usage) ? message.usage : {}
    const iterations: unknown[] = Array.isArray(usage.iterations) ? usage.iterations : []

    for (const iteration of iterations) {
      if (!isRecord(iteration) || iteration.type !== 'advisor_message') {
        continue
      }

      found.iterations += 1
      found.inputTokens += isFiniteNumber(iteration.input_tokens) ? iteration.input_tokens : 0
      found.outputTokens += isFiniteNumber(iteration.output_tokens) ? iteration.output_tokens : 0
      found.model = textOf(iteration.model) ?? found.model
    }
  }

  if (found.model === undefined) {
    delete found.model
  }

  return found
}

/** Whether a stop should read the transcript: it has a path, and a call came after the last read. */
export function isTranscriptReadDue(snapshot: AdvisorSnapshot, path: unknown): boolean {
  return typeof path === 'string' && path !== '' && snapshot.calls > (snapshot.readCalls ?? 0)
}

/** Whether a file is past what one read should copy (`$.fs.read` refuses more than 4 MiB). */
export function isTooLargeToRead(size: number): boolean {
  return !Number.isFinite(size) || size > TRANSCRIPT_MAX_BYTES
}

/**
 * Whether a read came before the file caught up: it holds fewer advisor calls
 * than the append rows counted (the stop's last response not written yet).
 * After `/clear` the new file holds only the calls made since, so the one
 * more read finds the same and the figures are taken as they are.
 */
export function isTranscriptBehind(snapshot: AdvisorSnapshot, found: TranscriptAdvisor): boolean {
  return found.serverToolUses < snapshot.calls
}

/**
 * A transcript read: the advisor model and token totals once it has advisor
 * iterations; every call counted so far is then read, and the next read waits
 * for a new call.
 */
export function applyTranscript(snapshot: AdvisorSnapshot, found: TranscriptAdvisor): AdvisorSnapshot {
  const hasTokens = found.iterations > 0

  return withFields(snapshot, {
    model: found.model ?? snapshot.model,
    inputTokens: hasTokens ? found.inputTokens : snapshot.inputTokens,
    outputTokens: hasTokens ? found.outputTokens : snapshot.outputTokens,
    source: hasTokens ? 'append+transcript' : snapshot.source,
    tokensUnavailable: undefined,
    error: undefined,
    readCalls: snapshot.calls,
  })
}

/** A transcript too large to read: the tokens give way to the reason until a call comes after it. */
export function applyTooLarge(snapshot: AdvisorSnapshot): AdvisorSnapshot {
  return withFields(snapshot, {
    inputTokens: undefined,
    outputTokens: undefined,
    tokensUnavailable: TOO_LARGE,
    error: undefined,
    readCalls: snapshot.calls,
  })
}

/** A failed stat or read: the tokens give way to a short reason, and the next stop tries again. */
export function applyReadError(snapshot: AdvisorSnapshot, reason: string): AdvisorSnapshot {
  return withFields(snapshot, { inputTokens: undefined, outputTokens: undefined, error: reason })
}
