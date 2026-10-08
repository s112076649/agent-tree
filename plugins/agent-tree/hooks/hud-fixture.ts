import type { StatusView } from './render/boxes/status-row'

/** Shared offline C9a session: the kit renders it; evidence captures that same snapshot. */
export const HUD_FIXTURE_NOW = 1_800_000_000_000

export const HUD_FIXTURE_VIEW: StatusView = {
  tree: {
    main: { model: 'claude-opus-5-5', effort: 'high', turns: 8, status: 'tooling', toolsRunning: 1 },
    agents: [
      { id: 'a1', type: 'Explore', role: 'researcher', description: 'PRIVATE_DESCRIPTION', model: 'claude-sonnet-5-5', status: 'running', toolCalls: 3, lastTool: 'Glob', startedAt: HUD_FIXTURE_NOW - 48000 },
      { id: 'a2', type: 'Plan', role: 'researcher', description: 'PRIVATE_DESCRIPTION', model: 'claude-haiku-4-5', status: 'running', toolCalls: 2, lastTool: 'Read', startedAt: HUD_FIXTURE_NOW - 62000 },
      { id: 'a3', type: 'general-purpose', role: 'worker', description: 'PRIVATE_DESCRIPTION', model: 'claude-opus-5-5', status: 'running', toolCalls: 8, lastTool: 'Grep', startedAt: HUD_FIXTURE_NOW - 75000 },
      { id: 'a4', type: 'general-purpose', role: 'worker', description: 'PRIVATE_DESCRIPTION', model: 'claude-sonnet-4-5', status: 'running', toolCalls: 5, lastTool: 'Read', startedAt: HUD_FIXTURE_NOW - 130000 },
      { id: 'ext:codex', kind: 'external', type: 'codex', role: 'worker', description: 'PRIVATE_WORKER_TASK', model: 'gpt-6.1-sol', status: 'running', toolCalls: 0, startedAt: HUD_FIXTURE_NOW - 185000 },
    ],
    updatedAt: HUD_FIXTURE_NOW,
  },
  activity: {
    main: { phase: 'tooling', tool: 'Read', since: HUD_FIXTURE_NOW - 2000 },
    calls: [
      { id: 'c1', agentId: 'a1', tool: 'Read', since: HUD_FIXTURE_NOW - 1000 },
      { id: 'c2', agentId: 'a2', tool: 'Grep', since: HUD_FIXTURE_NOW - 1000 },
      { id: 'c3', agentId: 'a3', tool: 'Edit', since: HUD_FIXTURE_NOW - 1000 },
      { id: 'c4', agentId: 'a4', tool: 'Bash', since: HUD_FIXTURE_NOW - 1000 },
    ],
    updatedAt: HUD_FIXTURE_NOW,
  },
  advisor: { calls: 3, source: 'append', inFlight: false, recentCalls: [] },
  jev: {
    enabled: true, calls: 7, inFlight: false, health: 0.91,
    flags: [
      { key: 'looping', label: 'looping', p: 0.85, sharp: true },
      { key: 'stuck', label: 'stuck', p: 0.10, sharp: true },
      { key: 'fanout_wide', label: 'fan-out wide', p: 0.40, sharp: false },
      { key: 'near_done', label: 'near done', p: 0.70, sharp: false },
    ],
  },
  now: HUD_FIXTURE_NOW,
}

export const HUD_PLAIN_120 = [
  'agent-tree  main [opus-5-5 · high · tooling Read]  subagents [5/5]  fable [on call · 3]  jev [idle · 7]',
  '◐ researcher sonnet-5-5 Explore Read/3 48s │ ◐ researcher haiku-4-5 Plan Grep/2 1m02s',
  '◐ worker opus-5-5 general-purpose Edit/8 1m15s │ ◐ worker sonnet-4-5 general-purpose Bash/5 2m10s │ +1 more',
  'jev  looping ████░ 0.85  stuck █░░░░ 0.10  fan-out wide ██░░░ 0.40  near done ████░ 0.70  health 0.9 needs attention',
]

export const HUD_PLAIN_80 = [
  'agent-tree  main [opus-5-5]  sub [5/5]  fable [3]  jev [7]',
  '◐ researcher sonnet-5-5 Explore Read/3 48s',
  '◐ researcher haiku-4-5 Plan Grep/2 1m02s │ +3 more',
  'jev  looping 0.85  stuck 0.10  fan-out wide 0.40  health 0.9 needs attention',
]
