import { atom, read, update } from 'claude-code'
import type { Caught, EngineInterface, PluginOptions, Register, ToolCallResult } from 'claude-code'

import type { ActivitySnapshot, AdvisorSnapshot, JevEvent, JevSnapshot, LogEntry, TreeSnapshot } from '../types'
import { EMPTY_ACTIVITY, endTool, endTurn, isAnyActive, startStep, startTool, withJevCall } from './activity'
import {
  EMPTY_ADVISOR,
  READ_FAILED,
  TRANSCRIPT_DELAY_MS,
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
import { backgroundTaskIdOf, enginesFrom, externalCallOf, interruptedOf } from './external'
import { hudSnapshot } from './hud'
import {
  EMPTY_JEV,
  JEV_ENDPOINT,
  JEV_NO_KEY,
  answerLogLine,
  applyAnswers,
  applyError,
  buildRequestBody,
  buildSummary,
  callsWithinHour,
  clearJevInFlight,
  endCall,
  eventsSince,
  httpErrorText,
  jevIntervalSec,
  jevMaxPerHour,
  parseAnswers,
  pushEvent,
  shouldCall,
  shouldClearRing,
  startCall,
  withoutSecret,
} from './jev-core'
import {
  advisedEntry,
  advisingEntry,
  jevCallingEntry,
  jevErrorEntry,
  jevOkEntry,
  promptEntry,
  push,
  spawnEntry,
  toolEntry,
  turnEntry,
  workerEndEntries,
} from './log'
import { paneColumns } from './render/layout'
import { renderPane } from './render/pane'
import { clip, oneLine, paneWidth } from './render/text'
import { EMPTY_STATS, fromUsage, refreshPeriodMs, shouldWriteStats, statusText } from './stats'
import {
  EMPTY_TREE,
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
  externalId,
  upsertFromSpawn,
} from './tree'
import type { BackgroundTask } from './tree'

// The one file that registers hooks and calls `$` (the engine reads it
// statically). What the pane draws lives in `$.state` under the contract in
// types/index.d.ts and is written here alone, from events, the refresh timer
// and the command; every other file is pure functions over that data.
// The advisor (C3) is counted from session.append and read from the
// transcript after classic.Stop. Jev (C4): tool.call, turn.complete and
// prompt.submit fill the event ring; a tick on the jevIntervalSec timer and
// after each main-loop turn asks Jev when a call is due, only while the
// jevEnabled option is on and the stored flag, which session.start syncs
// from it, is on too (C4d). An activation that turns Jev on empties the ring
// before it syncs the flag (C4c, C4e), and a tick reads the ring only once it
// found the flag on. The live topology (C7-0): the pane asks for the
// paneColumns option's columns (92 by default, C7a), and a 250 ms timer
// moves the animation frame only while the pane is open and something is
// active. External workers (C7a2): a shell tool call that starts an engine
// CLI of the table (the built-in names and the workerCommands option) is a
// node from the call to its return, or, run in the background, until a
// classic.Stop no longer lists its task. Its close-out (C7a2b): a call whose
// `next(e)` rejects fails it, an interrupted command kills it, the end of its
// loop's turn kills a foreground one still open, and classic.SubagentStop
// reconciles the background ones as classic.Stop does. The activity (C7b):
// turn.step, tool.call and turn.complete keep what each loop does right now
// (activity.ts), written only when it changed; every start in tool.call ends
// in a finally, so a rejected call leaves no loop tooling; the refresh syncs
// `isOpen` with the engine's record of the pane, which a pane placed late
// (the terminal widened) changes with no event. The advisor's and Jev's
// calls in flight (C7c): session.append marks the advisor's from its
// server_tool_use block to its result, written only when it changed; tick
// marks Jev's in the write that claims the call and clears it in the write
// of its answer or failure; session.start clears a flag a reload left; the
// frame turns while one is in flight, and the status entry adds `jev …` while
// Jev's is (pinned by pinStatus: the refresh does, and tick after each of its
// two writes). Their close-out (C7c2): a main-loop turn that ends, aborted or
// not, clears the advisor's flag, as an aborted call leaves no result row; a
// tick that throws after its claim clears its own Jev flag. The session log
// (C7d, PRD M-L7): each event, after its own writes, adds the line log.ts
// builds for it to the `log` atom in one write, a ring of 200: a spawn, a tool
// call once it ended (a failed one is a fail line), a loop's turn end, an
// external worker's start and end (a shell call's return or rejection, the end
// of its loop's turn, the stop that closes a background one), a prompt (no
// text), an advisor call's start and result, a Jev call's claim and its answer
// or failure. A stop that closes a background worker (reconcileBackground)
// writes the tree, then one log write with `done <age>` for each worker it
// closed; a stop that closes none writes neither. The log is session memory
// alone: session.start leaves it, ui.render only reads it, and nothing of it
// reaches the Jev summary.

const PANE_ID = 'agent-tree'
const PANE_TITLE = 'Agent Tree'

/** The animation timer's period (PRD M-L4). */
const FRAME_MS = 250

/** Frames before the spinner comes round again: its four glyphs. */
const FRAME_COUNT = 4

const tree = atom({ plugin: 'agent-tree', key: 'tree' } as const, EMPTY_TREE)
const stats = atom({ plugin: 'agent-tree', key: 'stats' } as const, EMPTY_STATS)
const advisor = atom({ plugin: 'agent-tree', key: 'advisor' } as const, EMPTY_ADVISOR)
const jev = atom({ plugin: 'agent-tree', key: 'jev' } as const, EMPTY_JEV)
const jevEvents = atom({ plugin: 'agent-tree', key: 'jevEvents' } as const, [])
const isOpen = atom({ plugin: 'agent-tree', key: 'isOpen' } as const, false)
const frame = atom({ plugin: 'agent-tree', key: 'frame' } as const, 0)
const activity = atom({ plugin: 'agent-tree', key: 'activity' } as const, EMPTY_ACTIVITY)
const log = atom({ plugin: 'agent-tree', key: 'log' } as const, [])

// A logging memo, not drawing state: the pane geometry the debug log was last
// given, so a redraw writes the line only when the geometry changed (C7-0
// measures what the dock grants against the columns asked). The pane draws
// nothing from it.
let loggedGeometry: string | undefined

/** A failure off the session's path: one line in the debug log, and the session carries on. */
function note($: EngineInterface, what: string, error: unknown): void {
  try {
    $.ui.log(`agent-tree: ${what} failed: ${String(error)}`, { to: 'debug' })
  } catch {
    // The session is gone; there is nobody to tell.
  }
}

/** A gating failure: one debug line, without a downstream rejection's private message. */
function hookFailure($: EngineInterface, what: string, next: Caught): void {
  try {
    const after = next.called ? ', after next' : ''
    const message = !next.called && next.error.message !== undefined ? `: ${clip(oneLine(next.error.message), 80)}` : ''

    $.ui.log(`agent-tree: ${what} hook failed (${next.error.kind}${after})${message}`, { to: 'debug' })
  } catch {
    // Logging is optional; the event still passes through.
  }
}

/** Runs `work`, sending a failure to the debug log instead of the caller. */
async function quietly($: EngineInterface, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    note($, what, error)
  }
}

/** `work`'s answer, or undefined when it throws (a call this mode lacks, a timer outliving its session). */
async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

/**
 * Reads the agent list and the session figures again, writes what changed,
 * and pins the status entry. Runs on the refreshMs timer and after each turn.
 * It also syncs `isOpen` with the engine's record of the pane (C7b): a pane
 * opened unasked on a narrow terminal waits undrawn, and no event says when
 * the person opens it or the terminal widens to its floor (the C7-0 gap).
 */
async function refresh($: EngineInterface, statusLineHud: boolean): Promise<void> {
  try {
    const now = Date.now()
    const [agents, usage, model, turns, panes] = await Promise.all([
      attempt(() => $.agent.list()),
      attempt(() => $.session.usage()),
      attempt(() => $.session.model()),
      attempt(() => $.session.turns()),
      attempt(() => $.ui.panes()),
    ])

    if (agents === undefined && usage === undefined && model === undefined && turns === undefined) {
      return // No session is bound (a -p run past its result): nothing to read.
    }

    if (panes !== undefined) {
      const isPlaced = panes.some(pane => pane.id === PANE_ID && pane.isPlaced)

      // Written only when it changed: `update` writes even an unchanged value.
      if ((await read($, isOpen)) !== isPlaced) {
        await update($, isOpen, () => isPlaced)
      }
    }

    const reconcile = (value: TreeSnapshot): TreeSnapshot =>
      applyMain(agents === undefined ? value : applyAgentList(value, agents, now), { model, turns, now })
    const treeNow = await read($, tree)

    if (reconcile(treeNow) !== treeNow) {
      await update($, tree, reconcile)
    }

    const statsNow = await read($, stats)

    if (usage !== undefined) {
      const reading = fromUsage(usage, now)

      if (shouldWriteStats(statsNow, reading)) {
        await update($, stats, value => (value.updatedAt > reading.updatedAt ? value : reading))
      }
    }

    await pinStatus($, statusLineHud)
  } catch (error) {
    note($, 'refresh', error)
  }
}

/**
 * Pins the status entry (C7c, PRD M-L8): `jev …` follows the stats line while
 * a Jev call is in flight. The one place that builds the entry (C7c2): the
 * refresh pins through it, and so does tick, after the write that claims a
 * call and after the write of its answer or failure. It reads the four atoms
 * afresh, so whoever calls it pins what stands now. HUD mode pins no text;
 * session.start alone clears the entry left by an earlier activation.
 */
async function pinStatus($: EngineInterface, statusLineHud: boolean, clear: boolean = false): Promise<void> {
  if (statusLineHud) {
    if (clear) $.ui.status(undefined)
    return
  }

  const [treeNow, statsNow, advisorNow, jevNow] = await Promise.all([
    read($, tree),
    read($, stats),
    read($, advisor),
    read($, jev),
  ])

  $.ui.status(withJevCall(statusText(treeNow, statsNow, advisorNow), jevNow, Date.now()))
}

/**
 * One period of the FRAME_MS timer: while the pane is placed or HUD is on, and something is
 * active (activity.ts isAnyActive: a loop, a running node, or a call of the
 * advisor or of Jev in flight, C7c), moves `frame` on in one compare-and-set
 * write, which redraws the pane (its render reads `frame`). Otherwise it
 * writes no frame while the pane is closed; the HUD has no animated spinner.
 * An idle session makes no `$.state.set` (PRD M-L4,
 * M-L9). A read that fails (no session bound) is left for the next period.
 */
async function frameTick($: EngineInterface, statusLineHud: boolean, memo: HudMemo): Promise<void> {
  const placed = (await attempt(() => read($, isOpen))) === true

  if (!placed && !statusLineHud) {
    return
  }

  const [treeNow, activityNow, advisorNow, jevNow] = await Promise.all([
    attempt(() => read($, tree)),
    attempt(() => read($, activity)),
    attempt(() => read($, advisor)),
    attempt(() => read($, jev)),
  ])

  if (
    treeNow === undefined ||
    activityNow === undefined ||
    advisorNow === undefined ||
    jevNow === undefined ||
    !isAnyActive(treeNow, activityNow, advisorNow, jevNow, Date.now())
  ) {
    return
  }

  if (placed) {
    await quietly($, 'frame', () =>
      update($, frame, value => (Number.isInteger(value) && value >= 0 ? value + 1 : 0) % FRAME_COUNT),
    )
  }

  if (statusLineHud) await publishHud($, statusLineHud, memo)
}

/** Activation-local I/O memo, never drawing state; serialize overlapping timer callbacks. */
type HudMemo = { content?: string; at?: number; busy: boolean; noted: boolean }

async function publishHud($: EngineInterface, enabled: boolean, memo: HudMemo): Promise<void> {
  if (!enabled || memo.busy) return
  memo.busy = true

  try {
    const sessionId = await $.session.id()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return
    const now = await $.clock.now()
    const [treeNow, activityNow, advisorNow, jevNow] = await Promise.all([
      read($, tree), read($, activity), read($, advisor), read($, jev),
    ])
    const snapshot = hudSnapshot({ tree: treeNow, activity: activityNow, advisor: advisorNow, jev: jevNow, now }, sessionId, now)
    const content = JSON.stringify({ ...snapshot, updatedAt: 0 })
    const changed = content !== memo.content

    if (!changed && memo.at !== undefined && now - memo.at < 30_000) return

    const config = await $.env.get('CLAUDE_CONFIG_DIR')
    const profile = config ? undefined : await $.env.get('USERPROFILE')
    const home = config || profile ? undefined : await $.env.get('HOME')
    const base = config || (profile || home ? `${profile || home}/.claude` : undefined)
    if (base === undefined) throw new Error('Claude config folder unavailable')

    const text = JSON.stringify(snapshot)
    await $.fs.write(`${base.replace(/[\\/]$/, '')}/agent-tree/hud/${sessionId}.json`, text)
    memo.content = content
    memo.at = now

    if (changed) {
      // UTF-8 bytes without Node/DOM APIs (the hook environment has neither).
      const bytes = [...text].reduce((sum, char) => {
        const code = char.codePointAt(0) ?? 0
        return sum + (code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4)
      }, 0)
      try { $.ui.log(`agent-tree: hud wrote ${sessionId} lines=${snapshot.lines.length} bytes=${bytes}`, { to: 'debug' }) } catch { /* Optional log. */ }
    }
  } catch (error) {
    if (!memo.noted) {
      memo.noted = true
      note($, 'hud', error)
    }
  } finally {
    memo.busy = false
  }
}

/**
 * Reads the advisor's model and tokens from the transcript (plan 03). A file
 * over 3.5 MiB is left unread: `$.fs.read` refuses 4 MiB and reads no range.
 * A read that fails, or finds fewer calls than counted, is made `retries`
 * more times, TRANSCRIPT_RETRY_MS apart; the last one writes what it got.
 * Runs on a timer, so every `$` call is caught.
 */
async function readTranscript($: EngineInterface, path: string, retries: number): Promise<void> {
  let change: ((value: AdvisorSnapshot) => AdvisorSnapshot) | undefined
  let isBehind = false

  try {
    const stat = await $.fs.stat(path)

    if (isTooLargeToRead(stat.size)) {
      change = applyTooLarge
    } else {
      const found = parseTranscript(await $.fs.read(path))
      isBehind = isTranscriptBehind(await read($, advisor), found)
      change = value => applyTranscript(value, found)
    }
  } catch (error) {
    note($, 'transcript read', error)
  }

  try {
    if (retries > 0 && (change === undefined || isBehind)) {
      $.clock.after(TRANSCRIPT_RETRY_MS, () => {
        void readTranscript($, path, retries - 1)
      })
    } else {
      await update($, advisor, change ?? (value => applyReadError(value, READ_FAILED)))
    }
  } catch (error) {
    note($, 'advisor', error)
  }
}

/**
 * Reconciles the external workers run in the background with a stop's list of
 * the work in flight (C7a2 at classic.Stop; C7a2b at classic.SubagentStop
 * too): written only when a worker finished, so a stop with nothing to
 * close, or with no list at all, writes nothing. Each worker the write closed
 * gets its end line (`done 2m10s`, C7d) in one log write after the tree's.
 */
async function reconcileBackground(
  $: EngineInterface,
  tasks: readonly BackgroundTask[] | undefined,
  what: string,
): Promise<void> {
  if (!Array.isArray(tasks)) {
    return
  }

  const listed: readonly BackgroundTask[] = tasks
  const now = Date.now()
  const reconcile = (value: TreeSnapshot): TreeSnapshot => applyBackgroundTasks(value, listed, now)
  let closed: TreeChange | undefined

  // Written only when a worker finished: `update` writes even an unchanged value.
  try {
    const treeNow = await read($, tree)

    if (reconcile(treeNow) !== treeNow) {
      closed = await writeTree($, what, reconcile)
    }
  } catch (error) {
    note($, what, error)
  }

  if (closed !== undefined) {
    await addToLog($, what, workerEndEntries(closed.before, closed.after, now))
  }
}

/**
 * Applies `change` to the activity (C7b), written only when it changes it: a
 * subagent's model request, say, changes nothing, and every write redraws
 * the pane. A failure goes to the debug log.
 */
async function changeActivity(
  $: EngineInterface,
  what: string,
  change: (value: ActivitySnapshot) => ActivitySnapshot,
): Promise<void> {
  await quietly($, what, async () => {
    const activityNow = await read($, activity)

    if (change(activityNow) !== activityNow) {
      await update($, activity, change)
    }
  })
}

/** The tree as one write of it read it and left it: what an event's log lines are made from (C7d). */
type TreeChange = { before: TreeSnapshot; after: TreeSnapshot }

/**
 * Writes `change` to the tree, as `quietly($, what, () => update($, tree, change))`
 * does, and answers the tree the write was made from and the tree it wrote
 * (C7d: a worker that stopped is told from the two); undefined when the write
 * failed, which goes to the debug log.
 */
async function writeTree(
  $: EngineInterface,
  what: string,
  change: (value: TreeSnapshot) => TreeSnapshot,
): Promise<TreeChange | undefined> {
  let before = EMPTY_TREE

  try {
    const after = await update($, tree, value => {
      before = value

      return change(value)
    })

    return { before, after }
  } catch (error) {
    note($, what, error)

    return undefined
  }
}

/** The tree as it stands, for the `who` of a log line (C7d); the empty tree when it cannot be read, so the line is still written. */
async function treeForLog($: EngineInterface): Promise<TreeSnapshot> {
  return (await attempt(() => read($, tree))) ?? EMPTY_TREE
}

/**
 * Adds `entries` to the session log (C7d, PRD M-L7) in one write, which an
 * event makes after its own writes; no entries, no write. The ring keeps the
 * newest 200. The log is session memory: this is its only writer, and a
 * failure goes to the debug log like any other.
 */
async function addToLog($: EngineInterface, what: string, entries: readonly LogEntry[]): Promise<void> {
  if (entries.length === 0) {
    return
  }

  await quietly($, `${what} log`, () => update($, log, value => push(value, ...entries)))
}

/**
 * The time Jev's events and calls are measured on: the host clock (which
 * `mock.clock` drives in tests), or this worker's when the call fails.
 */
async function clockNow($: EngineInterface): Promise<number> {
  return (await attempt(() => $.clock.now())) ?? Date.now()
}

/** One event into the Jev ring: its kind, side, tool name, error flag and time, nothing else (PRD M-J3). */
async function recordEvent($: EngineInterface, event: Omit<JevEvent, 'at'>): Promise<void> {
  const at = await clockNow($)
  await quietly($, 'jev event', () => update($, jevEvents, ring => [...pushEvent(ring, { ...event, at })]))
}

/**
 * One Jev tick (plan 04, C4b), from the jevIntervalSec timer and after each
 * main-loop turn. Jev off, by the option or by the stored flag that
 * session.start syncs from it: returns before the ring, the key or the
 * network is touched. The stored flag counts too because a tick can reach a
 * module reloaded with Jev on before its session.start emptied the ring and
 * then synced the flag (C4d, C4e). Jev on: reads the ring, then the key; when
 * shouldCall says a call is due, records the attempt, posts the whitelisted
 * summary to Jev, and writes the flags (or the failure, never the response
 * body) to the `jev` atom and one line to the debug log. The key goes into
 * the Authorization header and nowhere else. The call is in flight from the
 * write that claims it to the write of its answer or failure (C7c), and the
 * status entry is pinned again after each of the two (`jev …` while it is
 * out). A throw after the claim (a read of the tree refused, say) ends the
 * call in the catch, which clears this call's own flag and no other (C7c2);
 * a throw before the claim has no flag to clear. The claim, the answer or
 * failure, and a call so ended in the catch are lines of the session log, one
 * write each (C7d). Runs on a timer or unawaited, so every `$` call is caught.
 */
async function tick($: EngineInterface, options: PluginOptions, reason: string): Promise<void> {
  if (options.jevEnabled !== true) {
    return
  }

  let claimedSince: number | undefined

  try {
    const now = await clockNow($)
    const jevNow = await read($, jev)

    if (jevNow.enabled !== true) {
      return
    }

    // The ring is read only after the flag was found on: session.start
    // empties it before it syncs the flag (C4e), so this read comes after
    // that clear, whatever order a host answers two reads made at once in.
    const ring = await read($, jevEvents)
    const key = ((await $.env.get('TYPESAFE_API_KEY')) ?? '').trim()
    const isDue = (value: JevSnapshot): boolean =>
      shouldCall({
        enabled: true,
        hasKey: key !== '',
        newEventsSinceLast: eventsSince(ring, value.lastAt),
        callsThisHour: callsWithinHour(value.callTimes ?? [], now).length,
        maxPerHour: jevMaxPerHour(options.jevMaxCallsPerHour),
        lastAt: value.lastAt,
        intervalSec: jevIntervalSec(options.jevIntervalSec),
        now,
      })

    if (!isDue(jevNow)) {
      if (key === '' && jevNow.error !== JEV_NO_KEY) {
        await update($, jev, value => applyError(value, JEV_NO_KEY, now))
        $.ui.log(`agent-tree: jev ${reason} failed: ${JEV_NO_KEY}`, { to: 'debug' })
      }

      return
    }

    // Claimed in one compare-and-set write before the call: a tick that
    // comes while it runs finds lastAt moved and leaves it alone. The same
    // write marks the call in flight (C7c), timed on the clock the pane is
    // drawn on; the write of its answer or failure clears that mark.
    const since = Date.now()
    claimedSince = since
    let isClaimed = false
    await update($, jev, value => {
      isClaimed = isDue(value)

      return isClaimed ? startCall(value, now, since) : value
    })

    if (!isClaimed) {
      return
    }

    await addToLog($, 'jev', [jevCallingEntry(Date.now())])
    await quietly($, 'status', () => pinStatus($, options.statusLineHud === true))

    const [treeNow, statsNow] = await Promise.all([read($, tree), read($, stats)])
    const body = buildRequestBody(buildSummary(treeNow, statsNow, ring, now))
    let change: (value: JevSnapshot) => JevSnapshot
    let line: string

    try {
      const res = await $.http.fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json; charset=utf-8' },
        body,
      })
      const parsed = res.ok ? parseAnswers(res.text) : undefined

      if (parsed !== undefined) {
        change = value => applyAnswers(value, parsed, now)
        line = answerLogLine(parsed, now, ring.length)
      } else {
        const failure = res.ok ? 'unreadable answer' : httpErrorText(res.status)
        change = value => applyError(value, failure, now)
        line = `agent-tree: jev ${reason} failed: ${failure}`
      }
    } catch (error) {
      change = value => applyError(value, 'network error', now)
      line = `agent-tree: jev ${reason} failed: network error (${withoutSecret(String(error), key)})`
    }

    const written = await update($, jev, value => endCall(change(value), since))

    // An answer leaves no error on the snapshot, a failure leaves its own (C7d).
    await addToLog($, 'jev', [
      written.error === undefined ? jevOkEntry(written.calls, Date.now()) : jevErrorEntry(written.error, Date.now()),
    ])
    await quietly($, 'status', () => pinStatus($, options.statusLineHud === true))
    $.ui.log(line, { to: 'debug' })
  } catch (error) {
    note($, `jev ${reason}`, error)

    // Past the claim and short of the write of an answer: the call is over, so
    // its flag goes (C7c2). `endCall` clears the claim made at `claimedSince`
    // only, so a flag another claim set, or none, stays, and nothing is
    // written then: `update` writes even an unchanged value.
    if (claimedSince !== undefined) {
      const since = claimedSince

      await quietly($, 'jev in flight', async () => {
        const jevNow = await read($, jev)

        if (endCall(jevNow, since) !== jevNow) {
          await update($, jev, value => endCall(value, since))
          await addToLog($, 'jev', [jevErrorEntry('call failed', Date.now())])
        }
      })
    }
  }
}

export const register: Register = (on, options) => {
  // The engine CLIs a shell tool call is read for (PRD M-L1b): the built-in
  // names and the workerCommands option's, fixed for this activation.
  const engines = enginesFrom(options.workerCommands)
  const statusLineHud = options.statusLineHud === true
  const hudMemo: HudMemo = { busy: false, noted: false }

  on('session.start', async ($, e, next) => {
    await quietly($, 'command.register', () =>
      $.command.register({ name: 'agent-tree', description: 'Toggle the Agent Tree pane', immediate: true }),
    )

    if (statusLineHud) {
      await quietly($, 'status', () => pinStatus($, statusLineHud, true))
    }

    // Jev turned on (it was off before this activation, or the state is
    // fresh): the ring is emptied before the flag is synced (C4e), so a tick
    // that finds the flag on never reads a ring holding a tool used while Jev
    // was off. A clear that fails leaves the flag unsynced, and tick leaves
    // Jev alone (C4d). lastAt and callTimes stay: toggling Jev restarts
    // neither the interval nor the hourly cap.
    const jevEnabled = options.jevEnabled === true
    await quietly($, 'jev.enabled', async () => {
      if (shouldClearRing(await read($, jev), jevEnabled)) {
        await update($, jevEvents, () => [])
      }

      await update($, jev, value => (value.enabled === jevEnabled ? value : { ...value, enabled: jevEnabled }))
    })

    // A call of the advisor or of Jev that the environment before this
    // activation left in flight (a reload cancels its timers and can drop the
    // answer it waited for) would keep its box lit until the stale bound:
    // each flag is cleared, written only when one is set (C7c). The advisor's
    // pending call stays, so a result that still comes keeps its latency.
    await quietly($, 'in flight', async () => {
      const [advisorNow, jevNow] = await Promise.all([read($, advisor), read($, jev)])

      if (clearAdvisorInFlight(advisorNow) !== advisorNow) {
        await update($, advisor, clearAdvisorInFlight)
      }

      if (clearJevInFlight(jevNow) !== jevNow) {
        await update($, jev, clearJevInFlight)
      }
    })

    if (options.autoOpen === true) {
      // Not awaited: session.start is awaited before the first prompt. The
      // engine places an unasked pane only on a wide terminal (PRD M-U1).
      void $.ui
        .open({ id: PANE_ID, title: PANE_TITLE, columns: paneColumns(options.paneColumns) })
        .then(opened => update($, isOpen, () => opened.isPlaced))
        .catch(error => note($, 'ui.open', error))
    }

    try {
      $.clock.every(refreshPeriodMs(options.refreshMs), () => {
        void refresh($, statusLineHud).then(() => publishHud($, statusLineHud, hudMemo))
      })
    } catch (error) {
      note($, 'clock.every', error)
    }

    // The animation frame (PRD M-L4): each period only reads while nothing
    // is active or the pane is closed.
    try {
      $.clock.every(FRAME_MS, () => {
        void frameTick($, statusLineHud, hudMemo)
      })
    } catch (error) {
      note($, 'clock.every', error)
    }

    // Jev's timer runs only while Jev is on: the options are fixed for this
    // activation, and turning Jev on in /config reloads the plugin.
    if (jevEnabled) {
      try {
        $.clock.every(jevIntervalSec(options.jevIntervalSec) * 1000, () => {
          void tick($, options, 'timer')
        })
      } catch (error) {
        note($, 'clock.every', error)
      }
    }

    void refresh($, statusLineHud).then(() => publishHud($, statusLineHud, hudMemo))

    return next(e)
  })

  // `/agent-tree`: closes the pane while it is drawn, opens it otherwise.
  on('command.run', { command: 'agent-tree' }, async $ => {
    const panes = await attempt(() => $.ui.panes())
    const isDrawn =
      panes === undefined ? await read($, isOpen) : panes.some(pane => pane.id === PANE_ID && pane.isPlaced)

    if (isDrawn) {
      try {
        await $.ui.close({ id: PANE_ID })
      } catch (error) {
        return { text: `agent-tree: the pane did not close: ${String(error)}` }
      }

      await quietly($, 'isOpen', () => update($, isOpen, () => false))

      return { text: 'Agent Tree pane closed. /agent-tree opens it again.' }
    }

    try {
      const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: paneColumns(options.paneColumns) })
      await quietly($, 'isOpen', () => update($, isOpen, () => opened.isPlaced))

      return { text: opened.isPlaced ? 'Agent Tree pane opened.' : `Agent Tree pane is open but not drawn: ${opened.reason}` }
    } catch (error) {
      return { text: `agent-tree: the pane did not open: ${String(error)}` }
    }
  })

  // The person's close mark (or this plugin's own close) leaves the pane closed.
  on('ui.close', { id: 'agent-tree' }, async ($, e, next) => {
    const closed = await next(e)

    if (closed.deny === undefined) {
      await quietly($, 'isOpen', () => update($, isOpen, () => false))
    }

    return closed
  }).catch(($, e, next) => {
    hookFailure($, 'ui.close{id=agent-tree}', next)

    return next(e)
  })

  // A subagent started: open its node with what the Agent call decided, and
  // log its spawn line once the node is in the tree (C7d).
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    if (started.agentId !== undefined) {
      const input = {
        subagentType: e.subagentType,
        description: e.description,
        prompt: e.prompt,
        model: e.model,
        background: e.background,
        parentAgentId: e.parentAgentId,
      }
      const result = { agentId: started.agentId, model: started.model }
      const id = started.agentId
      const opened = await writeTree($, 'agent.spawn', value => upsertFromSpawn(value, input, result, Date.now()))
      const node = opened?.after.agents.find(found => found.id === id)

      if (opened !== undefined && node !== undefined) {
        await addToLog($, 'agent.spawn', [spawnEntry(opened.after, node, Date.now())])
      }
    }

    return started
  }).catch(($, e, next) => {
    hookFailure($, 'agent.spawn', next)

    return next(e)
  })

  // Each model request: the main loop is thinking; a subagent's model and effort.
  on('turn.step', async function* ($, e, next) {
    const step = { agentId: e.agentId, model: e.model, effort: e.effort, now: Date.now() }
    await quietly($, 'turn.step', () => update($, tree, value => applyStep(value, step)))
    await changeActivity($, 'turn.step', value => startStep(value, step))

    return yield* next(e)
  })

  // Each tool call: a subagent's last tool and count; the main loop is tooling
  // until its tools finish; the call is in flight in the activity (C7b). A
  // shell call that starts an engine CLI opens an external worker before it
  // runs and closes it once it returned (C7a2): failed on an error result or
  // a deny, killed when the result says the command was interrupted (C7a2b).
  // A `next(e)` that rejects (or throws) fails the worker and is passed up as
  // it came (C7a2b); the main loop's count and the call in flight end in the
  // finally, whatever next(e) did (C7b). Once it ended, the Jev ring gets its
  // name and whether it failed (an error result or a deny), never its
  // command; a rejected call records nothing, as before. The session log
  // (C7d) gets the call's line once it returned (a rejected call has no line,
  // as it has no ring entry), with a hint of what it touched that stays on the
  // pane, and a worker's lines: its spawn when its node opens, its end when the
  // call returns or rejects.
  on('tool.call', async ($, e, next) => {
    const call = { agentId: e.agentId, tool: e.tool, now: Date.now() }
    await quietly($, 'tool.call', () => update($, tree, value => applyToolCall(value, call)))

    // State holds no `undefined`: the main loop's call carries no agentId.
    const live = {
      id: typeof e.tool_use_id === 'string' ? e.tool_use_id : '',
      ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      tool: e.tool,
      since: call.now,
    }
    await changeActivity($, 'tool.call', value => startTool(value, live))

    const worker = externalCallOf(e, engines)

    if (worker !== undefined) {
      const start = { ...worker, toolUseId: e.tool_use_id, agentId: e.agentId, now: Date.now() }
      const opened = await writeTree($, 'tool.call', value => applyExternalStart(value, start))
      const node = opened?.after.agents.find(found => found.id === externalId(start.toolUseId))

      // The worker's spawn line, once its node is open (C7d).
      if (opened !== undefined && node !== undefined) {
        await addToLog($, 'tool.call', [spawnEntry(opened.after, node, start.now)])
      }
    }

    let ran: ToolCallResult

    try {
      ran = await next(e)
    } catch (error) {
      if (worker !== undefined) {
        const end = { toolUseId: e.tool_use_id, isError: true, now: Date.now() }
        const failed = await writeTree($, 'tool.call', value => applyExternalEnd(value, end))

        if (failed !== undefined) {
          await addToLog($, 'tool.call', workerEndEntries(failed.before, failed.after, end.now))
        }
      }

      throw error
    } finally {
      // Neither write throws (quietly): the error above goes up as it came.
      if (e.agentId === undefined) {
        await quietly($, 'tool.call', () => update($, tree, value => applyToolDone(value, { now: Date.now() })))
      }

      await changeActivity($, 'tool.call', value => endTool(value, live, Date.now()))
    }

    const isError = ran.isError === true || ran.deny !== undefined
    let ended: TreeChange | undefined

    if (worker !== undefined) {
      const end = {
        toolUseId: e.tool_use_id,
        isError,
        interrupted: interruptedOf(ran.result),
        taskId: backgroundTaskIdOf(ran.result),
        now: Date.now(),
      }
      ended = await writeTree($, 'tool.call', value => applyExternalEnd(value, end))
    }

    await recordEvent($, { kind: 'tool', agent: e.agentId === undefined ? 'main' : 'sub', tool: e.tool, isError })

    // The call's line (a fail line when it ended in an error or a deny) and,
    // for an engine call, its worker's end: one write after the others (C7d).
    const treeNow = ended?.after ?? (await treeForLog($))
    const at = Date.now()

    await addToLog($, 'tool.call', [
      toolEntry(treeNow, { agentId: e.agentId, tool: e.tool, input: e, isError }, at),
      ...(ended === undefined ? [] : workerEndEntries(ended.before, ended.after, at)),
    ])

    return ran
  }).catch(($, e, next) => {
    hookFailure($, 'tool.call', next)

    return next(e)
  })

  // A turn ended: the main loop goes idle; a subagent completes or fails; an
  // external worker its loop started in the foreground and that still runs
  // is killed with it, in the same write (C7a2b: the safety net for a call
  // whose `next(e)` never came back). The loop's calls leave the activity
  // (C7b). A main-loop turn that ended, aborted or not, ends the advisor's
  // call too (C7c2): an aborted call leaves no result row, and its flag would
  // light the box until the stale bound; the pending call stays, so a result
  // that still comes keeps its latency. The Jev ring gets the turn; the session
  // log (C7d) gets the loop's end line, and a line for each worker the turn
  // killed; after a main-loop turn Jev is asked when a call is due (not
  // awaited: the answer is not held up; a -p run gets its chance).
  on('turn.complete', async ($, e, next) => {
    const end = { agentId: e.agentId, reason: e.reason, durationMs: e.durationMs, now: Date.now() }
    const close = (value: TreeSnapshot): TreeSnapshot =>
      closeForegroundExternals(applyTurnComplete(value, end), end.agentId, end.now)
    const closed = await writeTree($, 'turn.complete', close)
    await changeActivity($, 'turn.complete', value => endTurn(value, end))

    if (e.agentId === undefined) {
      // Written only when a flag is set: `update` writes even an unchanged value.
      await quietly($, 'turn.complete', async () => {
        const advisorNow = await read($, advisor)

        if (clearAdvisorInFlight(advisorNow) !== advisorNow) {
          await update($, advisor, clearAdvisorInFlight)
        }
      })
    }

    void refresh($, statusLineHud)

    await recordEvent($, { kind: 'turn', agent: e.agentId === undefined ? 'main' : 'sub', isError: e.reason === 'error' })

    if (closed !== undefined) {
      await addToLog($, 'turn.complete', [
        turnEntry(closed.after, end),
        ...workerEndEntries(closed.before, closed.after, end.now),
      ])
    }

    if (e.agentId === undefined) {
      void tick($, options, 'turn')
    }

    return next(e)
  })

  // A prompt entered the session: the Jev ring gets the time, never the text,
  // and the session log (C7d) a line that says `prompt` and nothing else.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)

    if (entered.drop === undefined) {
      await recordEvent($, { kind: 'prompt', agent: 'main' })
      await addToLog($, 'prompt.submit', [promptEntry(Date.now())])
    }

    return entered
  }).catch(($, e, next) => {
    hookFailure($, 'prompt.submit', next)

    return next(e)
  })

  // The main loop's response rows (C0, path A): an advisor call starts at its
  // server_tool_use block, in flight from then (C7c), and ends at its
  // advisor_tool_result block. Written only when it changed: a block seen
  // again changes nothing, and every write redraws the pane. A start and a
  // result are lines of the session log (C7d, who `fable`) in the one write
  // after the advisor's; the result's carries the latency, and no token count,
  // as the row has none.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const row = { agentId: e.agentId, content: e.message.content }

    if (isAdvisorRow(row)) {
      const now = Date.now()
      const change = (value: AdvisorSnapshot): AdvisorSnapshot => applyAppend(value, row, now)

      await quietly($, 'session.append', async () => {
        const advisorNow = await read($, advisor)

        if (change(advisorNow) !== advisorNow) {
          const written = await update($, advisor, change)
          const { serverToolUses, results } = countAdvisorBlocks(row.content)

          await addToLog($, 'session.append', [
            ...(serverToolUses > 0 && written.lastCallStartedAt === now ? [advisingEntry(now)] : []),
            ...(results > 0 && written.lastCallAt === now ? [advisedEntry(written.lastLatencyMs, now)] : []),
          ])
        }
      })
    }

    return next(e)
  }).catch(($, e, next) => {
    hookFailure($, 'session.append{door=response}', next)

    return next(e)
  })

  // A stop after a new advisor call: the transcript holds the advisor's model
  // and tokens a moment later (C0: the last response is written within 250 ms).
  // Each stop also lists the background work in flight: an external worker
  // run in the background whose task it no longer lists has finished (C7a2).
  on('classic.Stop', async ($, e, next) => {
    const path = e.transcript_path

    try {
      if (isTranscriptReadDue(await read($, advisor), path)) {
        $.clock.after(TRANSCRIPT_DELAY_MS, () => {
          void readTranscript($, path, 1)
        })
      }
    } catch (error) {
      note($, 'classic.Stop', error)
    }

    await reconcileBackground($, e.background_tasks, 'classic.Stop')

    return next(e)
  }).catch(($, e, next) => {
    hookFailure($, 'classic.Stop', next)

    return next(e)
  })

  // A subagent's stop lists the session's background work in flight too
  // (C7a2b): a background worker that finished during a turn is closed at
  // the next subagent's stop, not only at the main loop's.
  on('classic.SubagentStop', async ($, e, next) => {
    await reconcileBackground($, e.background_tasks, 'classic.SubagentStop')

    return next(e)
  }).catch(($, e, next) => {
    hookFailure($, 'classic.SubagentStop', next)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'agent-tree' }, async ($, e) => {
    // What the surface granted, logged once per change (C7-0: does the dock
    // give the columns asked for, and where is the pane seated).
    const geometry = `bodyColumns=${e.props.bodyColumns} placement=${e.props.placement} rows=${e.props.scroll?.bodyRows}`

    if (geometry !== loggedGeometry) {
      try {
        $.ui.log(`agent-tree: pane ${geometry}`, { to: 'debug' })
        loggedGeometry = geometry
      } catch {
        // Refused while drawing: the next draw tries again.
      }
    }

    const els = $.ui.resolve(e)
    const [treeNow, statsNow, advisorNow, jevNow, frameNow, activityNow, logNow] = await Promise.all([
      read($, tree),
      read($, stats),
      read($, advisor),
      read($, jev),
      read($, frame),
      read($, activity),
      read($, log),
    ])

    return renderPane(
      els,
      {
        tree: treeNow,
        stats: statsNow,
        advisor: advisorNow,
        jev: jevNow,
        activity: activityNow,
        log: logNow,
        now: Date.now(),
        frame: frameNow,
        bodyRows: e.props.scroll?.bodyRows,
      },
      paneWidth(e.props.bodyColumns, e.viewport?.columns),
    )
  })
}
