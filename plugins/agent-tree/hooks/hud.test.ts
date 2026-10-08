import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code'
import type { AgentNode, JevSnapshot } from '../types'
import { EMPTY_ACTIVITY } from './activity'
import { EMPTY_ADVISOR } from './advisor-core'
import { hudSnapshot } from './hud'
import type { HudSnapshot } from './hud'
import { EMPTY_JEV } from './jev-core'
import { agentLine, moreText } from './render/boxes/agents-row'
import { HUD_FIXTURE_NOW, HUD_FIXTURE_VIEW, HUD_PLAIN_120, HUD_PLAIN_80 } from './hud-fixture'
import { STATUS_GAP, statusForms } from './render/boxes/status-row'
import { widthOf } from './render/text'
import { COLORS } from './render/theme'
import { EMPTY_TREE } from './tree'
import { renderLines } from '../statusline/hud-print.mjs'

const T = 1_800_000_000_000
const node = (id = 'a1', extra: Partial<AgentNode> = {}): AgentNode => ({
  id, type: 'Explore', role: 'researcher', description: 'PRIVATE_DESCRIPTION',
  model: 'claude-sonnet-5-5', status: 'running', toolCalls: 3, lastTool: 'Grep', startedAt: T - 48000, ...extra,
})
const view = (agents: AgentNode[] = []) => ({
  tree: { ...EMPTY_TREE, main: { ...EMPTY_TREE.main, model: 'claude-opus-5-5', effort: 'max' }, agents },
  activity: EMPTY_ACTIVITY, advisor: EMPTY_ADVISOR, jev: EMPTY_JEV, now: T,
})

describe('HUD snapshot display contract', () => {
  test('all status forms keep the pane words, colors, widths and two-space gaps', () => {
    const input = view()
    const snapshot = hudSnapshot(input, 'fixture', T)
    expect(snapshot.v).toBe(1)
    expect(snapshot.sessionId).toBe('fixture')
    expect(snapshot.updatedAt).toBe(T)
    expect(snapshot.lines).toHaveLength(1)
    const paneForms = statusForms(input).map(form => form.flatMap((part, index) => [
      ...(index === 0 ? [] : [{ t: ' '.repeat(STATUS_GAP), w: STATUS_GAP }]),
      { t: part.text, w: widthOf(part.text), fg: part.color, ...(part.dim ? { d: true } : {}) },
    ]))
    const status = snapshot.lines[0]
    expect('forms' in status).toBe(true)
    if (!('forms' in status)) throw new Error('missing status forms')
    const label = { t: 'agent-tree', w: 10, d: true }
    const gap = { t: ' '.repeat(STATUS_GAP), w: STATUS_GAP }
    expect(status.forms).toEqual([...paneForms.map(form => [label, gap, ...form]), paneForms[2]])
    expect(status.forms).toHaveLength(4)
    expect(status.forms[0][0]).not.toHaveProperty('fg')
    expect(status.forms[3].some(run => 't' in run && run.t === 'agent-tree')).toBe(false)
  })

  test('running narrow words are reused, tool in flight wins, elapsed is a since run', () => {
    const input = view([node()])
    input.activity = { ...EMPTY_ACTIVITY, calls: [{ id: 'call', agentId: 'a1', tool: 'Read', since: T - 2000 }] }
    const snapshot = hudSnapshot(input, 'fixture', T)
    expect(snapshot.lines).toHaveLength(2)
    const agents = snapshot.lines[1]
    if (!('pack' in agents)) throw new Error('missing agent pack')
    expect(agents.pack.items[0]).toEqual([
      { t: '◐ researcher sonnet-5-5 Explore Read/3 ', w: 39, fg: COLORS.sub },
      { since: T - 48000, fg: COLORS.sub },
    ])
    expect(renderLines(snapshot, 'fixture', 120, T)[1].replace(/\u001b\[[0-9;]*m/g, '')).toBe(
      agentLine(node(), 0, T, 116, { tool: 'Read' }).text,
    )
  })

  test('external worker has model then engine and no tool; unknown start is --; stopped nodes are omitted', () => {
    const snapshot = hudSnapshot(view([node('ext:x', { kind: 'external', type: 'codex', role: 'worker', model: 'gpt-6.1-sol', startedAt: undefined }), node('done', { status: 'completed' })]), 'fixture', T)
    const agents = snapshot.lines[1]
    if (!('pack' in agents)) throw new Error('missing agent pack')
    expect(agents.pack.items[0]).toEqual([
      { t: '◐ worker gpt-6.1-sol codex ', w: 27, fg: COLORS.sub }, { t: '--', w: 2, fg: COLORS.sub },
    ])
    expect(hudSnapshot(view([node('done', { status: 'failed' })]), 'fixture', T).lines).toHaveLength(1)
  })

  test('agent pack keeps every segment, dim separator and every plugin-authored hidden count', () => {
    const snapshot = hudSnapshot(view([node('a'), node('b'), node('c'), node('d')]), 'fixture', T)
    const agents = snapshot.lines[1]
    if (!('pack' in agents)) throw new Error('missing agent pack')
    expect(agents).not.toHaveProperty('forms')
    expect(agents.pack.items).toHaveLength(4)
    expect(agents.pack.items.map(item => item.filter(run => 'since' in run).length)).toEqual([1, 1, 1, 1])
    expect(agents.pack.sep).toEqual([{ t: ' │ ', w: 3, d: true }])
    expect(agents.pack.maxLines).toBe(2)
    expect(agents.pack.more).toEqual([1, 2, 3, 4].map(k => [{ t: moreText(k), w: 7, fg: COLORS.sub, d: true }]))
    expect(JSON.stringify(snapshot).includes('PRIVATE_DESCRIPTION')).toBe(false)
  })

  test('Jev off never adds a flags line, even with an earlier answer', () => {
    const input = { ...view(), jev: { ...HUD_FIXTURE_VIEW.jev, enabled: false } }
    expect(hudSnapshot(input, 'fixture', T).lines).toHaveLength(1)
  })

  test('Jev on without flags or finite health adds no line; finite health alone does', () => {
    for (const health of [undefined, NaN, Infinity, -Infinity]) {
      expect(hudSnapshot({ ...view(), jev: { ...EMPTY_JEV, enabled: true, health } }, 'fixture', T).lines).toHaveLength(1)
    }
    const snapshot = hudSnapshot({ ...view(), jev: { ...EMPTY_JEV, enabled: true, health: 0.91 } }, 'fixture', T)
    expect(snapshot.lines[1]).toEqual({ forms: [[
      { t: 'jev', w: 3, fg: COLORS.jev }, { t: '  ', w: 2 },
      { t: 'health 0.9 needs attention', w: 26, fg: COLORS.jev },
    ]] })
  })

  test('Jev forms keep flag order, five-cell bars, alert color and trailing drops before health', () => {
    const snapshot = hudSnapshot(HUD_FIXTURE_VIEW, 'fixture', HUD_FIXTURE_NOW)
    const line = snapshot.lines[2]
    if (!('forms' in line)) throw new Error('missing Jev forms')
    const plain = (form: typeof line.forms[number]) => form.map(run => 't' in run ? run.t : '').join('')
    expect(line.forms.map(plain)).toEqual([
      'jev  looping ████░ 0.85  stuck █░░░░ 0.10  fan-out wide ██░░░ 0.40  near done ████░ 0.70  health 0.9 needs attention',
      'jev  looping 0.85  stuck 0.10  fan-out wide 0.40  near done 0.70  health 0.9 needs attention',
      'jev  looping 0.85  stuck 0.10  fan-out wide 0.40  health 0.9 needs attention',
      'jev  looping 0.85  stuck 0.10  health 0.9 needs attention',
      'jev  looping 0.85  health 0.9 needs attention',
      'jev  health 0.9 needs attention',
    ])
    expect(line.forms[0][2]).toEqual({ t: 'looping ████░ 0.85', w: 18, fg: COLORS.fail })
    expect(line.forms[0][4]).toEqual({ t: 'stuck █░░░░ 0.10', w: 16, fg: COLORS.jev })
  })

  test('Jev shares pane clamping and labels; low-confidence health stays whole and dim', () => {
    const jev: JevSnapshot = {
      ...EMPTY_JEV, enabled: true, health: 0.91, healthLowConfidence: true,
      flags: [
        { key: 'stuck', label: '', p: 2, sharp: true },
        { key: 'near_done', label: 'near\ndone', p: -1, sharp: false },
        { key: '', label: '', p: NaN, sharp: false },
      ], error: 'PRIVATE_ERROR',
    }
    const snapshot = hudSnapshot({ ...view(), jev }, 'fixture', T)
    const line = snapshot.lines[1]
    if (!('forms' in line)) throw new Error('missing Jev forms')
    expect(line.forms[0][2]).toEqual({ t: 'stuck █████ 1.00', w: 16, fg: COLORS.fail })
    expect(line.forms[0][4]).toEqual({ t: 'near done ░░░░░ 0.00', w: 20, fg: COLORS.jev })
    expect(line.forms[0][6]).toEqual({ t: '? ░░░░░ 0.00', w: 12, fg: COLORS.jev })
    expect(line.forms[0].at(-1)).toEqual({ t: 'health 0.9 needs attention low confidence', w: 41, fg: COLORS.jev, d: true })
    expect(JSON.stringify(line).includes('PRIVATE_ERROR')).toBe(false)
  })

  test('Jev flags omit nonfinite health from every form', () => {
    for (const health of [undefined, NaN, Infinity, -Infinity]) {
      const snapshot = hudSnapshot({ ...view(), jev: { ...HUD_FIXTURE_VIEW.jev, health } }, 'fixture', T)
      const line = snapshot.lines[1]
      if (!('forms' in line)) throw new Error('missing Jev forms')
      expect(line.forms.at(-1)).toEqual([{ t: 'jev', w: 3, fg: COLORS.jev }])
      expect(JSON.stringify(line).includes('health')).toBe(false)
    }
  })

  test('C9a fixture prints exact plain lines at 120 and 80 columns, at most four', () => {
    const snapshot = hudSnapshot(HUD_FIXTURE_VIEW, 'fixture', HUD_FIXTURE_NOW)
    expect(snapshot.lines).toHaveLength(3)
    const plain = (columns: number) => renderLines(snapshot, 'fixture', columns, HUD_FIXTURE_NOW).map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))
    expect(plain(120)).toEqual(HUD_PLAIN_120)
    expect(plain(80)).toEqual(HUD_PLAIN_80)
    for (const columns of [1, 20, 40, 80, 120, 200, 1000]) {
      expect(renderLines(snapshot, 'fixture', columns, HUD_FIXTURE_NOW).length).toBeLessThanOrEqual(4)
    }
  })
})

const SPAWN = {
  tool_use_id: 'spawn', prompt: 'PRIVATE_PROMPT', description: 'PRIVATE_DESCRIPTION', subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' }, model: 'sonnet', parentModel: 'claude-opus-5-5',
  permissionMode: 'default', background: false, fork: false,
} as const
const start = ($: Engine) => $.session.start({ cwd: 'D:/repo', surface: 'terminal', isInteractive: true })

/** A complete offline world. fs.write is answered in memory, never on disk. */
function world(on: On, variables: Record<string, string> = { CLAUDE_CONFIG_DIR: 'C:/scratch/config' }) {
  const writes: { path: string; text: string }[] = []
  const debug: string[] = []
  const envReads: string[] = []
  const opens: string[] = []
  const frames: number[] = []
  const statuses: (string | undefined)[] = []
  let id = 'session-one'
  let reject = false
  let rejectStatus = false
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: id }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    if (rejectStatus) throw new Error('status refused')
    return { value: undefined }
  })
  on('ui.log', ($, e) => { debug.push(e.text); return { value: undefined } })
  on('ui.open', ($, e) => { opens.push(e.id); return { value: { isPlaced: true } } })
  on('agent.spawn', ($, e) => ({ agentId: e.tool_use_id, model: 'claude-sonnet-5-5' }))
  on('tool.call', () => ({ result: { backgroundTaskId: 'task' } as never, text: 'ok' }))
  on('fs.write', ($, e) => {
    if (reject) throw new Error('write refused')
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('env.get', ($, e) => { envReads.push(e.name); return { value: variables[e.name] } })
  on('state.set', { plugin: 'agent-tree', key: 'frame' }, async ($, e, next) => {
    frames.push(e.value)
    return next(e)
  })
  return { writes, debug, envReads, opens, frames, statuses, setId: (value: string) => { id = value }, refuse: () => { reject = true }, refuseStatus: () => { rejectStatus = true } }
}

describe('HUD publisher through the plugin', () => {
  test('option off: no snapshot writes and no path env reads, even with active nodes and a shell worker', async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'shell', command: 'codex -m gpt-6.1-sol PRIVATE_COMMAND', run_in_background: true } as never)
    await clock.advance(32000)
    expect(seen.writes).toEqual([])
    expect(seen.envReads).toEqual([])
  })

  test('first refresh writes the config path and complete v1 shape', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on)
    await start($); await clock.settle()
    expect(seen.writes).toHaveLength(1)
    expect(seen.writes[0].path.replace(/\\/g, '/')).toBe('C:/scratch/config/agent-tree/hud/session-one.json')
    const snapshot = JSON.parse(seen.writes[0].text) as HudSnapshot
    expect(snapshot).toEqual(hudSnapshot({ ...view(), tree: { ...EMPTY_TREE, main: { ...EMPTY_TREE.main, model: 'claude-opus-5-5' } } }, 'session-one', T))
    expect(seen.envReads).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(seen.debug.filter(text => text.startsWith('agent-tree: hud wrote '))).toHaveLength(1)
  })

  test('unchanged content: no write until the 30 s heartbeat, no heartbeat debug line', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on)
    await start($); await clock.settle()
    await clock.advance(29999)
    expect(seen.writes).toHaveLength(1)
    await clock.advance(1)
    expect(seen.writes).toHaveLength(2)
    expect(JSON.parse(seen.writes[1].text).updatedAt).toBe(T + 30000)
    expect(seen.debug.filter(text => text.startsWith('agent-tree: hud wrote '))).toHaveLength(1)
  })

  test('HUD active with pane closed: frame tick writes a since run, never the frame atom', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on)
    await start($); await clock.settle()
    await $.agent.spawn(SPAWN)
    await clock.advance(250)
    expect(seen.writes).toHaveLength(2)
    const snapshot = JSON.parse(seen.writes[1].text) as HudSnapshot
    expect(snapshot.lines).toHaveLength(2)
    const agents = snapshot.lines[1]
    if (!('pack' in agents)) throw new Error('missing agent pack')
    expect(agents.pack.items[0].some(run => 'since' in run)).toBe(true)
    await clock.advance(1000)
    expect(seen.writes).toHaveLength(2)
    expect(seen.frames).toEqual([])
  })

  test('clear-like session id change writes a new file on the next refresh', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on)
    await start($); await clock.settle()
    seen.setId('session-two')
    await clock.advance(2000)
    expect(seen.writes).toHaveLength(2)
    expect(seen.writes[1].path.replace(/\\/g, '/')).toBe('C:/scratch/config/agent-tree/hud/session-two.json')
    expect(JSON.parse(seen.writes[1].text).sessionId).toBe('session-two')
  })

  test('privacy: spawn description, prompt, shell command, worker task and log never reach written text', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on)
    await start($); await clock.settle()
    await $.agent.spawn(SPAWN)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'shell', command: 'codex -m gpt-6.1-sol PRIVATE_COMMAND', description: 'PRIVATE_WORKER_TASK', run_in_background: true } as never)
    await clock.advance(250)
    expect(seen.writes).toHaveLength(2)
    expect(JSON.parse(seen.writes[1].text).lines).toHaveLength(2)
    for (const write of seen.writes) {
      for (const marker of ['PRIVATE_DESCRIPTION', 'PRIVATE_PROMPT', 'PRIVATE_COMMAND', 'PRIVATE_WORKER_TASK']) {
        expect(write.text.includes(marker)).toBe(false)
      }
      expect(write.text.includes('log')).toBe(false)
    }
  })

  test('empty config falls back to USERPROFILE before HOME', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on, { CLAUDE_CONFIG_DIR: '', USERPROFILE: 'C:/profile', HOME: 'C:/home' })
    await start($); await clock.settle()
    expect(seen.writes[0].path.replace(/\\/g, '/')).toBe('C:/profile/.claude/agent-tree/hud/session-one.json')
    expect(seen.envReads).toEqual(['CLAUDE_CONFIG_DIR', 'USERPROFILE'])
  })

  test('HOME fallback is used after config and USERPROFILE are unset', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on, { HOME: 'C:/home' })
    await start($); await clock.settle()
    expect(seen.writes[0].path.replace(/\\/g, '/')).toBe('C:/home/.claude/agent-tree/hud/session-one.json')
    expect(seen.envReads).toEqual(['CLAUDE_CONFIG_DIR', 'USERPROFILE', 'HOME'])
  })

  test('missing config values are silent after one debug failure', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on, {})
    await start($); await clock.advance(6000)
    expect(seen.writes).toEqual([])
    expect(seen.debug.filter(text => text.startsWith('agent-tree: hud failed:'))).toHaveLength(1)
  })

  test('invalid session id is ignored before env reads', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on); seen.setId('../escape')
    await start($); await clock.advance(4000)
    expect(seen.writes).toEqual([])
    expect(seen.envReads).toEqual([])
  })

  test('a rejected write is noted once and never escapes a timer', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    const seen = world(on); seen.refuse()
    await start($); await clock.advance(6000)
    expect(seen.writes).toEqual([])
    expect(seen.debug.filter(text => text.startsWith('agent-tree: hud failed:'))).toHaveLength(1)
  })

  test('autoOpen unset: session start never opens a pane', async ($, on) => {
    const clock = mock.clock(on, { now: T }); const seen = world(on)
    await start($); await clock.settle()
    expect(seen.opens).toEqual([])
  })

  test('autoOpen true: session start opens the pane as before', { options: { autoOpen: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T }); const seen = world(on)
    await start($); await clock.settle()
    expect(seen.opens).toEqual(['agent-tree'])
    expect(seen.writes).toEqual([])
    expect(seen.envReads).toEqual([])
  })

  test('HUD on clears the status once at start, then refresh never pins text', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T }); const seen = world(on)
    await start($); await clock.settle()
    expect(seen.statuses).toEqual([undefined])
    await clock.advance(4000)
    expect(seen.statuses).toEqual([undefined])
  })

  test('HUD on: a refused status clear does not stop snapshot publication', { options: { statusLineHud: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T }); const seen = world(on)
    seen.refuseStatus()
    await start($); await clock.settle(); await clock.advance(2000)
    expect(seen.statuses).toEqual([undefined])
    expect(seen.writes).toHaveLength(1)
  })

  test('HUD on never pins text while a mocked Jev call is claimed and answered', { options: { statusLineHud: true, jevEnabled: true } }, async ($, on) => {
    const clock = mock.clock(on, { now: T })
    // Synthetic environment answers in memory; no process environment is read.
    const seen = world(on, { CLAUDE_CONFIG_DIR: 'C:/scratch/config', TYPESAFE_API_KEY: 'offline-test-value' })
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const jevWrites: JevSnapshot[] = []
    on('http.fetch', async () => {
      calls += 1
      await gate
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { looping: { type: 'noul', noul: 0.85 } } }) } }
    })
    on('state.set', { plugin: 'agent-tree', key: 'jev' }, async ($, e, next) => {
      const result = await next(e)
      if (result.value?.isSet === true) jevWrites.push(e.value)
      return result
    })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await start($); await clock.settle()
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'hud-jev', reason: 'answer' })
    await clock.settle()
    expect(calls).toBe(1)
    expect(jevWrites.at(-1)?.inFlight).toBe(true)
    expect(seen.statuses).toEqual([undefined])
    release(); await clock.settle()
    expect(jevWrites.at(-1)?.inFlight).toBe(false)
    expect(jevWrites.at(-1)?.flags[0]?.p).toBe(0.85)
    await clock.advance(2000)
    expect(seen.statuses).toEqual([undefined])
  })

  test('HUD off still pins the existing text on startup refresh and timer refresh', async ($, on) => {
    const clock = mock.clock(on, { now: T }); const seen = world(on)
    await start($); await clock.settle()
    expect(seen.statuses).toEqual(['agent-tree 0/0'])
    await clock.advance(2000)
    expect(seen.statuses).toEqual(['agent-tree 0/0', 'agent-tree 0/0'])
  })
})
