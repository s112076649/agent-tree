// The session log (PRD M-L7; C7d): one line per event of the session, newest
// last, in a ring of MAX_LOG. Pure, no `$`: register.tsx hands each event to
// an entry builder here and pushes what it returns to the `log` atom
// (types/index.d.ts). The hints (a file name, a command's first 40
// characters, a search pattern) are read off the tool call's input on this
// machine and only ever drawn on the pane: the log lives in session memory,
// is never written to a file, and no part of it reaches the Jev summary
// (jev-core.ts takes no log, and its request body is built from the
// whitelisted ring alone).

import type { AgentNode, LogEntry, LogKind, TreeSnapshot } from '../types'
import { isShellTool } from './external'
import { clockTime } from './render/sections/jev'
import { clip, durationOf, formatAge, oneLine, widthOf } from './render/text'
import { SEP } from './stats'
import type { TurnEnd } from './tree'

/** The most lines the log keeps; past it the oldest go (PRD M-L7). */
export const MAX_LOG = 200

/** The widest the who column is drawn: a long type is cut to it, its `#n` kept. */
export const WHO_COLUMNS = 10

/** The columns of the time, `HH:mm:ss`. */
export const TIME_COLUMNS = 8

/** The most characters of a hint kept in a line's text; the pane clips to its own width on top of that. */
export const TEXT_CHARS = 120

/** The most characters of a shell command, or of an Agent call's description, a hint holds (PRD M-L7). */
export const HINT_CHARS = 40

/** Whose lines the main loop, the advisor and Jev write (PRD M-L7). */
export const WHO_MAIN = 'main'
export const WHO_ADVISOR = 'fable'
export const WHO_JEV = 'jev'

/** Who a line of a subagent that is not in the tree (a spawn the plugin missed) is written as. */
const UNKNOWN_AGENT = 'agent'

/** The columns between the time, the who column and the text. */
export const GAP_COLUMNS = 2

const GAP = ' '.repeat(GAP_COLUMNS)

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const padEnd = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - widthOf(text)))

/** `text` as one line of at most `limit` characters (characters, not columns): a line break becomes a space, the ends are trimmed. */
function lineOf(text: string, limit: number): string {
  return Array.from(oneLine(text)).slice(0, limit).join('').trimEnd()
}

/** A path's last part, a file's name: what follows the last `/` or `\`; a separator at the end is ignored. */
function baseName(path: string): string {
  const text = path.trim().replace(/[\\/]+$/, '')

  return text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1)
}

/**
 * The short local hint a tool call's line carries (PRD M-L7), read off the
 * call's `input` (the `tool.call` event itself: the envelope spreads the
 * tool's arguments beside `tool`): `Read`, `Edit` and `Write` the file's name
 * (`file_path`), `NotebookEdit` its notebook's (`notebook_path`), `Bash` and
 * `PowerShell` the command's first 40 characters, `Grep` and `Glob` the
 * pattern, `Agent` the description's first 40 characters. Any other tool, or
 * an input that holds nothing to show: undefined. No other field is read.
 */
export function hintFor(tool: unknown, input: unknown): string | undefined {
  if (typeof tool !== 'string' || typeof input !== 'object' || input === null) {
    return undefined
  }

  const field = (name: string): string => textOf((input as Record<string, unknown>)[name])
  let hint: string

  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
      hint = lineOf(baseName(field('file_path')), TEXT_CHARS)
      break
    case 'NotebookEdit':
      hint = lineOf(baseName(field('notebook_path')), TEXT_CHARS)
      break
    case 'Grep':
    case 'Glob':
      hint = lineOf(field('pattern'), TEXT_CHARS)
      break
    case 'Agent':
      hint = lineOf(field('description'), HINT_CHARS)
      break
    default:
      hint = isShellTool(tool) ? lineOf(field('command'), HINT_CHARS) : ''
  }

  return hint === '' ? undefined : hint
}

const typeOf = (node: AgentNode): string => oneLine(node.type) || UNKNOWN_AGENT

/**
 * Who a subagent's or an external worker's lines are written as (PRD M-L7):
 * its type (an external worker's engine); the second node of one type in the
 * tree is `Explore#2`, the third `#3`, the first has no number. The type is
 * cut so that the number stays within WHO_COLUMNS.
 */
export function whoOf(tree: TreeSnapshot, node: AgentNode): string {
  const type = typeOf(node)
  const index = tree.agents.filter(other => typeOf(other) === type).findIndex(other => other.id === node.id)
  const suffix = index > 0 ? `#${index + 1}` : ''

  return clip(type, Math.max(1, WHO_COLUMNS - suffix.length)) + suffix
}

/** Who a loop's lines are written as: `main` for the main loop (`agentId` undefined), else the subagent's whoOf; `agent` for an id the tree does not hold. */
export function whoFor(tree: TreeSnapshot, agentId: string | undefined): string {
  if (agentId === undefined) {
    return WHO_MAIN
  }

  const node = tree.agents.find(candidate => candidate.id === agentId)

  return node === undefined ? UNKNOWN_AGENT : whoOf(tree, node)
}

/** `log` with `entries` added at its end, at most MAX_LOG lines kept: the oldest go. A new array; `log` is not changed. */
export function push(log: readonly LogEntry[], ...entries: LogEntry[]): LogEntry[] {
  const next = [...log, ...entries]

  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next
}

function entryOf(at: number, who: string, kind: LogKind, text: string): LogEntry {
  return { at, who, kind, text: lineOf(text, TEXT_CHARS) }
}

/**
 * A subagent or an external worker started: `spawn Explore List docs files`
 * for a Claude subagent (type, description), `spawn kimi kimi-code/k3 Fix
 * the parser` for an external worker (engine, model, task; PRD M-L1b), as
 * its node in `tree` says. The line is the spawned node's own (its type, its
 * number).
 */
export function spawnEntry(tree: TreeSnapshot, node: AgentNode, now: number): LogEntry {
  const parts = ['spawn', typeOf(node), node.kind === 'external' ? oneLine(node.model) : '', oneLine(node.description)]

  return entryOf(now, whoOf(tree, node), 'spawn', parts.filter(part => part !== '').join(' '))
}

/**
 * A tool call ended (PRD M-L7): `Read README.md` by the loop that ran it
 * (`agentId` undefined: the main loop), the hint after the tool's name when
 * there is one. One that ended in an error result or a deny is a `fail` line:
 * `fail Read missing.txt`. A call whose `next` rejected never ended with a
 * result and gets no line from here; an external worker's call gets only its
 * worker's end line (`workerEndEntries`).
 */
export function toolEntry(
  tree: TreeSnapshot,
  call: { agentId?: string; tool: string; input: unknown; isError: boolean },
  now: number,
): LogEntry {
  const parts = [call.isError ? 'fail' : '', oneLine(call.tool), hintFor(call.tool, call.input) ?? '']

  return entryOf(now, whoFor(tree, call.agentId), call.isError ? 'fail' : 'tool', parts.filter(part => part !== '').join(' '))
}

/** How a run ended: finished, failed, or cut off. */
export type Outcome = 'done' | 'fail' | 'kill'

/** The outcome of a node's status: `completed` is done, `killed` is kill, anything else that ended is fail. */
export function outcomeOf(status: string): Outcome {
  return status === 'completed' ? 'done' : status === 'killed' ? 'kill' : 'fail'
}

/** A run ended (PRD M-L7): `done 2m31s`; `fail`; `kill`. Only the finished run carries its age. */
export function finishEntry(who: string, outcome: Outcome, ageMs: number | undefined, now: number): LogEntry {
  return outcome === 'done'
    ? entryOf(now, who, 'done', `done ${formatAge(ageMs)}`)
    : entryOf(now, who, 'fail', outcome)
}

/**
 * A loop's turn ended (`turn.complete`). A subagent's: `done 2m31s` after an
 * answer, `fail` after anything else (the tree's own reading of the reason),
 * the age from its node as the tree now holds it, else from the event. The
 * main loop's: `turn done 41s`, or `turn aborted 12s` (the reason as the
 * engine names it), no age when the event gave none.
 */
export function turnEntry(tree: TreeSnapshot, end: TurnEnd): LogEntry {
  const isAnswer = end.reason === 'answer'

  if (end.agentId === undefined) {
    const age = isFiniteNumber(end.durationMs) ? formatAge(end.durationMs) : ''

    return entryOf(
      end.now,
      WHO_MAIN,
      'turn',
      ['turn', isAnswer ? 'done' : oneLine(end.reason), age].filter(part => part !== '').join(' '),
    )
  }

  const node = tree.agents.find(candidate => candidate.id === end.agentId)
  const age = node === undefined ? end.durationMs : durationOf(node, end.now)

  return finishEntry(node === undefined ? UNKNOWN_AGENT : whoOf(tree, node), isAnswer ? 'done' : 'fail', age, end.now)
}

/**
 * The external workers that stopped running between `before` and `after`
 * (a shell call's return, the end of their loop's turn, a `classic.Stop`
 * reconcile): `done 2m10s`, `fail` or `kill` by the status each ended with,
 * its who the engine. A worker that runs on, or one `before` did not hold
 * running, has no line.
 */
export function workerEndEntries(before: TreeSnapshot, after: TreeSnapshot, now: number): LogEntry[] {
  const entries: LogEntry[] = []

  for (const node of after.agents) {
    const was = before.agents.find(other => other.id === node.id)

    if (node.kind === 'external' && node.status !== 'running' && was?.status === 'running') {
      entries.push(finishEntry(whoOf(after, node), outcomeOf(node.status), durationOf(node, now), now))
    }
  }

  return entries
}

/** The person sent a prompt: `prompt`, no text (PRD M-L7). */
export function promptEntry(now: number): LogEntry {
  return entryOf(now, WHO_MAIN, 'prompt', 'prompt')
}

/** An advisor call started (`server_tool_use`, PRD M-L7): `advising...`. */
export function advisingEntry(now: number): LogEntry {
  return entryOf(now, WHO_ADVISOR, 'advisor', 'advising...')
}

/**
 * An advisor call's result came: `advised 21.1s`, the latency from its start
 * to its result, left out when the start was not seen. The tokens it read
 * are not in the result row (the transcript gives only totals, later), so
 * the line carries none.
 */
export function advisedEntry(latencyMs: number | undefined, now: number): LogEntry {
  const latency = isFiniteNumber(latencyMs) ? `${(latencyMs / 1000).toFixed(1)}s` : ''

  return entryOf(now, WHO_ADVISOR, 'advisor', ['advised', latency].filter(part => part !== '').join(' '))
}

/** A Jev call was claimed, its request is on the way (PRD M-L7): `jev calling...`. */
export function jevCallingEntry(now: number): LogEntry {
  return entryOf(now, WHO_JEV, 'jev', 'jev calling...')
}

/** A Jev call was answered: `jev ok · calls 3`, the count of its snapshot. */
export function jevOkEntry(calls: number, now: number): LogEntry {
  return entryOf(now, WHO_JEV, 'jev', `jev ok${SEP}calls ${isFiniteNumber(calls) ? calls : '--'}`)
}

/** A Jev call failed: `jev error HTTP 401 key rejected` (a `fail` line, drawn in the fail red), the error as the Jev snapshot holds it. */
export function jevErrorEntry(error: string | undefined, now: number): LogEntry {
  return entryOf(now, WHO_JEV, 'fail', ['jev error', oneLine(error)].filter(part => part !== '').join(' '))
}

/** One entry as the log box draws it: its time, and the who column and the text as one string already fitted. */
export type LogLine = {
  entry: LogEntry
  /** `HH:mm:ss`, local. */
  time: string
  /** `who  text`, who padded to the column, the whole clipped to the room the time leaves. */
  body: string
}

/** The who column as drawn: the entry's who as one line, cut to WHO_COLUMNS. */
const whoText = (entry: LogEntry): string => clip(oneLine(entry.who) || '?', WHO_COLUMNS)

/**
 * The entries as lines for a box `width` columns wide (PRD M-L7): `HH:mm:ss`,
 * two blanks, the who column (padded to the widest who of these entries, at
 * most WHO_COLUMNS), two blanks, the text; each body cut with `~` where the
 * width ends. `column` fixes the who column's width instead of the widest's.
 */
export function logLines(entries: readonly LogEntry[], width: number, column?: number): LogLine[] {
  const whoWidth = column ?? entries.reduce((widest, entry) => Math.max(widest, widthOf(whoText(entry))), 0)
  const room = Math.max(1, Math.floor(width) - TIME_COLUMNS - GAP.length)

  return entries.map(entry => ({
    entry,
    time: clockTime(entry.at),
    body: clip(`${padEnd(whoText(entry), whoWidth)}${GAP}${oneLine(entry.text)}`.trimEnd(), room),
  }))
}

/** One line of the log as text: `14:41:54  main  Read README.md`, clipped to `width` columns; `column` as logLines reads it. */
export function formatLine(entry: LogEntry, width: number, column?: number): string {
  const [line] = logLines([entry], width, column)

  return line === undefined ? '' : clip(`${line.time}${GAP}${line.body}`, width)
}

/** The entries as text lines, the who column common to all (logLines). */
export function formatLines(entries: readonly LogEntry[], width: number): string[] {
  return logLines(entries, width).map(line => clip(`${line.time}${GAP}${line.body}`, width))
}
