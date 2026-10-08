import { describe, expect, test } from 'claude-code/testing'

import type { AdvisorSnapshot, StatsSnapshot, TreeSnapshot } from '../types'
import {
  EMPTY_STATS,
  SEP,
  formatContext,
  formatCost,
  formatDuration,
  formatLimits,
  formatTokens,
  fromUsage,
  refreshPeriodMs,
  sameStats,
  shouldWriteStats,
  statsSegments,
  statusText,
} from './stats'
import { applyTurnComplete, emptyTree, upsertFromSpawn } from './tree'

const T0 = 1_790_928_064_244

/** `$.session.usage()` at session.start, before the first response (C0 run A). */
const AT_START = { startedAt: T0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } }

/** `$.session.usage()` after the main turn of C0 run A. */
const AFTER_TURN = {
  startedAt: T0,
  context: { tokens: 61_098, window: 1_000_000, percent: 6 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 57, resetsAt: '2026-10-02T11:30:00.000Z' },
    { kind: 'seven_day', percentUsed: 53, resetsAt: '2026-10-06T06:00:00.000Z' },
  ],
  cost: { usd: 1.335259 },
}

const NO_ADVISOR: AdvisorSnapshot = { calls: 0, source: 'none' }

/** Three subagents, one of them still running. */
function threeAgents(): TreeSnapshot {
  let tree = emptyTree(T0)

  for (const id of ['a1', 'a2', 'a3']) {
    tree = upsertFromSpawn(tree, { subagentType: 'Explore', description: id }, { agentId: id }, T0)
  }

  tree = applyTurnComplete(tree, { agentId: 'a1', reason: 'answer', now: T0 + 1 })

  return applyTurnComplete(tree, { agentId: 'a2', reason: 'error', now: T0 + 2 })
}

describe('fromUsage', () => {
  test('before the first response only the window, the start and the cost are known', () => {
    const stats = fromUsage(AT_START, T0 + 5)

    expect(stats).toEqual({ contextWindow: 1_000_000, costUsd: 0, rateLimits: [], startedAt: T0, updatedAt: T0 + 5 })
    expect('contextTokens' in stats).toBe(false)
    expect('contextPercent' in stats).toBe(false)
    expect(formatContext(stats)).toBe('-- (--/1M)')
    expect(formatLimits(stats.rateLimits)).toBe('')
  })

  test('after a response every figure is copied as the engine reported it', () => {
    expect(fromUsage(AFTER_TURN, T0 + 9)).toEqual({
      contextTokens: 61_098,
      contextWindow: 1_000_000,
      contextPercent: 6,
      costUsd: 1.335259,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 57, resetsAt: '2026-10-02T11:30:00.000Z' },
        { kind: 'seven_day', percentUsed: 53, resetsAt: '2026-10-06T06:00:00.000Z' },
      ],
      startedAt: T0,
      updatedAt: T0 + 9,
    })
  })

  test('a host without a cost ledger leaves the cost out', () => {
    expect('costUsd' in fromUsage({ startedAt: T0, context: { window: 200_000 }, rateLimits: [] }, T0)).toBe(false)
  })
})

describe('formatting', () => {
  test('formatContext: percent, tokens and window, for 1M and 200K windows', () => {
    expect(formatContext(fromUsage(AFTER_TURN, T0))).toBe('6% (61k/1M)')
    expect(formatContext({ ...EMPTY_STATS, contextTokens: 82_000, contextWindow: 200_000, contextPercent: 41 })).toBe(
      '41% (82k/200k)',
    )
    expect(formatContext(EMPTY_STATS)).toBe('--')
  })

  test('formatTokens', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(61_098)).toBe('61k')
    expect(formatTokens(999_999)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(undefined)).toBe('--')
  })

  test('formatCost: two decimals, zero is a reading, a missing cost is --', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(1.335259)).toBe('$1.34')
    expect(formatCost(12.5)).toBe('$12.50')
    expect(formatCost(undefined)).toBe('$--')
  })

  test('formatLimits: 5h and 7d as given, missing windows left out, never 0', () => {
    expect(formatLimits(fromUsage(AFTER_TURN, T0).rateLimits)).toBe('5h 57% · 7d 53%')
    expect(formatLimits([{ kind: 'five_hour', percentUsed: 23.5 }])).toBe('5h 23.5%')
    expect(formatLimits([{ kind: 'seven_day', percentUsed: 41 }])).toBe('7d 41%')
    expect(formatLimits([{ kind: 'spend_limit', percentUsed: 104 }])).toBe('spend 104%')
    expect(formatLimits([])).toBe('')
  })

  test('formatDuration: hours, minutes and seconds; -- when unknown', () => {
    expect(formatDuration((42 * 60 + 10) * 1000)).toBe('00:42:10')
    expect(formatDuration(100 * 3600 * 1000)).toBe('100:00:00')
    expect(formatDuration(0)).toBe('00:00:00')
    expect(formatDuration(undefined)).toBe('--:--:--')
    expect(formatDuration(Number.NaN)).toBe('--:--:--')
  })
})

describe('the stats line', () => {
  test('reads ctx, cost, 5h, 7d, agents and the session clock', () => {
    const now = T0 + (12 * 60 + 34) * 1000
    const segments = statsSegments(threeAgents(), fromUsage(AFTER_TURN, now), now)

    expect(segments.join(SEP)).toBe('ctx 6% (61k/1M) · $1.34 · 5h 57% · 7d 53% · agents 1/3 · 00:12:34')
  })

  test('before any reading: dashes, no rate limits, no zeros', () => {
    expect(statsSegments(emptyTree(T0), EMPTY_STATS, T0).join(SEP)).toBe('ctx -- · $-- · agents 0/0 · --:--:--')
  })
})

describe('statusText', () => {
  test('agent-tree running/total, ctx and cost; the fable segment only once the advisor was called', () => {
    const stats = fromUsage(AFTER_TURN, T0)

    expect(statusText(threeAgents(), stats, NO_ADVISOR)).toBe('agent-tree 1/3 · ctx 6% · $1.34')
    expect(statusText(threeAgents(), stats, { calls: 2, source: 'append' })).toBe('agent-tree 1/3 · ctx 6% · $1.34 · fable 2')
  })

  test('segments whose value is missing are left out', () => {
    expect(statusText(emptyTree(T0), EMPTY_STATS, NO_ADVISOR)).toBe('agent-tree 0/0')
    expect(statusText(emptyTree(T0), fromUsage(AT_START, T0), NO_ADVISOR)).toBe('agent-tree 0/0 · $0.00')
  })
})

describe('writing and options', () => {
  test('sameStats ignores the read time; a write is due on a change or a new second of the clock', () => {
    const first: StatsSnapshot = fromUsage(AFTER_TURN, T0 + 100)
    const sameSecond = fromUsage(AFTER_TURN, T0 + 600)
    const nextSecond = fromUsage(AFTER_TURN, T0 + 1300)
    const costlier = fromUsage({ ...AFTER_TURN, cost: { usd: 1.5 } }, T0 + 700)

    expect(sameStats(first, nextSecond)).toBe(true)
    expect(sameStats(first, costlier)).toBe(false)
    expect(shouldWriteStats(first, sameSecond)).toBe(false)
    expect(shouldWriteStats(first, nextSecond)).toBe(true)
    expect(shouldWriteStats(first, costlier)).toBe(true)
    expect(shouldWriteStats(EMPTY_STATS, first)).toBe(true)
  })

  test('refreshPeriodMs keeps the option within 500 to 10000 ms, 2000 when unreadable', () => {
    expect(refreshPeriodMs(2000)).toBe(2000)
    expect(refreshPeriodMs('3000')).toBe(3000)
    expect(refreshPeriodMs(100)).toBe(500)
    expect(refreshPeriodMs(99_999)).toBe(10_000)
    expect(refreshPeriodMs(undefined)).toBe(2000)
    expect(refreshPeriodMs('soon')).toBe(2000)
  })
})
