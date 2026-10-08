// Session figures for the stats line and the status entry: pure functions
// over `$.session.usage()` as register.tsx reads it, no `$`. A figure the
// engine has not reported yet is drawn as `--` (or left out), never as 0.

import type { AdvisorSnapshot, RateLimitReading, StatsSnapshot, TreeSnapshot } from '../types'
import { countRunning } from './tree'

/** Between two segments of the stats line and of the status entry. */
export const SEP = ' · '

/** No reading yet: the `stats` atom's initial value. */
export const EMPTY_STATS: StatsSnapshot = { rateLimits: [], updatedAt: 0 }

/** The refresh option's bounds and default, as the manifest declares them. */
const REFRESH_MS = { min: 500, max: 10_000, fallback: 2000 } as const

/** What `$.session.usage()` answers, as far as the stats line reads it. */
export type UsageReading = {
  startedAt?: number
  context?: { tokens?: number; window?: number; percent?: number }
  rateLimits?: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** The figures of one `$.session.usage()` reading, read at `now`. */
export function fromUsage(usage: UsageReading, now: number): StatsSnapshot {
  const stats: StatsSnapshot = { rateLimits: [], updatedAt: now }
  const context = usage.context

  if (isFiniteNumber(context?.tokens)) {
    stats.contextTokens = context.tokens
  }

  if (isFiniteNumber(context?.window)) {
    stats.contextWindow = context.window
  }

  if (isFiniteNumber(context?.percent)) {
    stats.contextPercent = context.percent
  }

  if (isFiniteNumber(usage.cost?.usd)) {
    stats.costUsd = usage.cost.usd
  }

  for (const limit of usage.rateLimits ?? []) {
    if (typeof limit?.kind === 'string' && isFiniteNumber(limit.percentUsed)) {
      const reading: RateLimitReading = { kind: limit.kind, percentUsed: limit.percentUsed }

      if (typeof limit.resetsAt === 'string') {
        reading.resetsAt = limit.resetsAt
      }

      stats.rateLimits.push(reading)
    }
  }

  if (isFiniteNumber(usage.startedAt)) {
    stats.startedAt = usage.startedAt
  }

  return stats
}

/** The same figures, whenever they were read. */
export function sameStats(a: StatsSnapshot, b: StatsSnapshot): boolean {
  const { updatedAt: _a, ...left } = a
  const { updatedAt: _b, ...right } = b

  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Whether a new reading is worth a write: the figures changed, or the session
 * clock the stats line shows moved to another second (running durations and
 * the clock are drawn from the read time, so they tick with these writes).
 */
export function shouldWriteStats(previous: StatsSnapshot, next: StatsSnapshot): boolean {
  return !sameStats(previous, next) || Math.floor(previous.updatedAt / 1000) !== Math.floor(next.updatedAt / 1000)
}

/** `950`, `61k`, `200k`, `1M`, `1.5M`; `--` when unknown. */
export function formatTokens(tokens: number | undefined): string {
  if (!isFiniteNumber(tokens)) {
    return '--'
  }

  if (tokens >= 999_500) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`
  }

  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`
  }

  return String(Math.round(tokens))
}

/** `6% (61k/1M)`; `-- (--/1M)` before the first response; `--` with no reading at all. */
export function formatContext(stats: StatsSnapshot): string {
  if (!isFiniteNumber(stats.contextWindow)) {
    return '--'
  }

  const percent = isFiniteNumber(stats.contextPercent) ? `${stats.contextPercent}%` : '--'

  return `${percent} (${formatTokens(stats.contextTokens)}/${formatTokens(stats.contextWindow)})`
}

/** `$1.34`; `$0.00` is a reading; `$--` when the host keeps no cost. */
export function formatCost(usd: number | undefined): string {
  return isFiniteNumber(usd) ? `$${usd.toFixed(2)}` : '$--'
}

const LIMIT_LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

/** One segment per rate-limit window with a reading: `5h 57%`, `7d 53%`. */
export function limitSegments(rateLimits: readonly RateLimitReading[]): string[] {
  return rateLimits
    .filter(limit => isFiniteNumber(limit.percentUsed))
    .map(limit => `${LIMIT_LABELS[limit.kind] ?? limit.kind} ${limit.percentUsed}%`)
}

/** `5h 57% · 7d 53%`; empty when no window has a reading. */
export function formatLimits(rateLimits: readonly RateLimitReading[]): string {
  return limitSegments(rateLimits).join(SEP)
}

/** `00:42:10` (hours grow past 99); `--:--:--` when unknown. */
export function formatDuration(ms: number | undefined): string {
  if (!isFiniteNumber(ms)) {
    return '--:--:--'
  }

  const seconds = Math.floor(Math.max(0, ms) / 1000)
  const two = (value: number): string => String(value).padStart(2, '0')

  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`
}

/** The stats line's segments: ctx, cost, rate limits, agents running/total, session clock. */
export function statsSegments(tree: TreeSnapshot, stats: StatsSnapshot, now: number): string[] {
  const elapsed = isFiniteNumber(stats.startedAt) ? now - stats.startedAt : undefined

  return [
    `ctx ${formatContext(stats)}`,
    formatCost(stats.costUsd),
    ...limitSegments(stats.rateLimits),
    `agents ${countRunning(tree)}/${tree.agents.length}`,
    formatDuration(elapsed),
  ]
}

/** The status entry: `agent-tree <running>/<total> · ctx <p>% · $<usd> · fable <n>`, missing parts left out. */
export function statusText(tree: TreeSnapshot, stats: StatsSnapshot, advisor: AdvisorSnapshot): string {
  const parts = [`agent-tree ${countRunning(tree)}/${tree.agents.length}`]

  if (isFiniteNumber(stats.contextPercent)) {
    parts.push(`ctx ${stats.contextPercent}%`)
  }

  if (isFiniteNumber(stats.costUsd)) {
    parts.push(formatCost(stats.costUsd))
  }

  if (advisor.calls > 0) {
    parts.push(`fable ${advisor.calls}`)
  }

  return parts.join(SEP)
}

/** The `refreshMs` option as a timer period: within the manifest's 500 to 10000, 2000 when unreadable. */
export function refreshPeriodMs(value: unknown): number {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN

  if (!Number.isFinite(ms)) {
    return REFRESH_MS.fallback
  }

  return Math.min(REFRESH_MS.max, Math.max(REFRESH_MS.min, Math.round(ms)))
}
