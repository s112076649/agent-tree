import { describe, expect, test } from 'claude-code/testing'
import type { CatchHandler, EngineInterface, HookFor, On } from 'claude-code'

import { register } from './register'
import { clip, oneLine } from './render/text'

type Pattern = 'tool.call' | 'agent.spawn' | 'prompt.submit'

/** Capture the actual module's callbacks; the kit installs the selected one beneath the plugin. */
function captured<P extends Pattern>(pattern: P) {
  let hook: HookFor<P> | undefined
  let handler: CatchHandler<HookFor<P>> | undefined
  const collect = ((name: string, ...args: unknown[]) => {
    if (name === pattern) {
      hook = args.at(-1) as HookFor<P>

      return { catch: (caught: CatchHandler<HookFor<P>>) => { handler = caught } }
    }

    return { catch: () => {} }
  }) as On

  register(collect, {})

  if (hook === undefined) {
    throw new Error(`missing ${pattern} hook`)
  }

  return { hook, handler }
}

function debugLines(on: On): { text: string; to: string }[] {
  const lines: { text: string; to: string }[] = []

  on('ui.log', ($, e) => {
    lines.push({ text: e.text, to: e.to })

    return { value: undefined }
  })

  return lines
}

/** Observe the callback's logger directly; imported callbacks are outside the kit's static call scan. */
function withLog($: EngineInterface, lines: { text: string; to: string }[]): EngineInterface {
  return { ...$, ui: { ...$.ui, log: (text, options) => { lines.push({ text, to: options?.to ?? 'transcript' }) } } }
}

/** Drive a registered callback with a fault and the replay contract of core d.ts 1007-1009. */
async function failedBody<P extends Pattern>(
  callbacks: ReturnType<typeof captured<P>>,
  $: EngineInterface,
  original: Parameters<HookFor<P>>[1],
  fault: Parameters<HookFor<P>>[1],
  beneath: (e: Parameters<HookFor<P>>[1]) => Awaited<ReturnType<HookFor<P>>>,
  poison?: (result: Awaited<ReturnType<HookFor<P>>>) => Awaited<ReturnType<HookFor<P>>>,
): Promise<Awaited<ReturnType<HookFor<P>>>> {
  let settled: Promise<Awaited<ReturnType<HookFor<P>>>> | undefined
  const replay = (e: Parameters<HookFor<P>>[1]) => {
    settled ??= Promise.resolve(beneath(e === fault ? original : e))

    return settled
  }

  try {
    const next = async (e: Parameters<HookFor<P>>[1]) => {
      const result = await replay(e)

      return poison === undefined ? result : poison(result)
    }

    return await callbacks.hook($, fault as never, next as never) as Awaited<ReturnType<HookFor<P>>>
  } catch (error) {
    if (callbacks.handler === undefined) throw error
    const caught = Object.assign(replay, {
      error: { kind: 'throw' as const, message: error instanceof Error ? error.message : String(error), budget: 1000 },
      called: settled !== undefined,
    })

    return await callbacks.handler($, original as never, caught as never) as Awaited<ReturnType<HookFor<P>>>
  }
}

const CALL = { tool: 'Read', tool_use_id: 'catch-tool', file_path: 'private-input.txt' } as const
const OUTPUT = { result: 'the tool output' as never, text: 'the tool output' }
const SPAWN = {
  tool_use_id: 'catch-spawn',
  prompt: 'private prompt',
  description: 'private description',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  model: 'sonnet',
  parentModel: 'claude-opus-5-5',
  permissionMode: 'default',
  background: false,
  fork: false,
} as const

describe('fail-open gating catch handlers (C7e)', () => {
  test('all seven gating registrations have a catch handler', () => {
    const caught: string[] = []
    const collect = ((name: string, ...args: unknown[]) => {
      const matcher = args.length === 2 ? args[0] as Record<string, string> : undefined
      const pattern = matcher === undefined ? name : `${name}{${Object.entries(matcher).map(([key, value]) => `${key}=${value}`).join(',')}}`

      return { catch: () => { caught.push(pattern) } }
    }) as On

    register(collect, {})
    expect(caught).toEqual([
      'ui.close{id=agent-tree}',
      'agent.spawn',
      'tool.call',
      'prompt.submit',
      'session.append{door=response}',
      'classic.Stop',
      'classic.SubagentStop',
    ])
  })

  test('tool.call body throws before next: its own output, unchanged input, one debug line with an 80-column message', async ($, on) => {
    const lines = debugLines(on)
    const callbacks = captured('tool.call')
    const message = `forced body failure\n${'界'.repeat(50)}`
    let calls = 0
    on('tool.call', ($, e) => failedBody(callbacks, withLog($, lines), e, {
      ...e,
      get agentId(): undefined { throw new Error(message) },
    }, passed => {
      calls++
      expect(passed).toEqual(e)

      return OUTPUT
    }))

    expect(await $.tool.call(CALL as never)).toEqual(OUTPUT)
    expect(calls).toBe(1)
    expect(lines).toEqual([{ text: `agent-tree: tool.call hook failed (throw): ${clip(oneLine(message), 80)}`, to: 'debug' }])
  })

  test('agent.spawn body throws after next: its own result is replayed once, one debug line without a message', async ($, on) => {
    const lines = debugLines(on)
    const callbacks = captured('agent.spawn')
    const output = { agentId: 'catch-agent', model: 'claude-sonnet-5-5' }
    let calls = 0
    on('agent.spawn', ($, e) => failedBody(callbacks, withLog($, lines), e, {
      ...e,
      get subagentType(): string { throw new Error('private command and path') },
    }, passed => {
      calls++
      expect(passed).toEqual(e)

      return output
    }))

    expect(await $.agent.spawn(SPAWN)).toEqual(output)
    expect(calls).toBe(1)
    expect(lines).toEqual([{ text: 'agent-tree: agent.spawn hook failed (throw, after next)', to: 'debug' }])
  })

  test('prompt.submit body throws after next: the prompt result passes unchanged, one debug line without its contents', async ($, on) => {
    const lines = debugLines(on)
    const callbacks = captured('prompt.submit')
    const output = { text: 'the prompt result' }
    let calls = 0
    on('prompt.submit', ($, e) => failedBody(callbacks, withLog($, lines), e, e, passed => {
      calls++
      expect(passed.text).toBe('private prompt')

      return output
    }, result => ({ ...result, get drop(): undefined { throw new Error('private prompt contents') } })))

    expect(await $.prompt.submit({ text: 'private prompt', origin: { kind: 'composer' }, wait: false })).toEqual(output)
    expect(calls).toBe(1)
    expect(lines).toEqual([{ text: 'agent-tree: prompt.submit hook failed (throw, after next)', to: 'debug' }])
  })

  test('a rejected tool next still rejects as it came, runs beneath once and logs no rejection message or input', async ($, on) => {
    const lines = debugLines(on)
    let calls = 0

    on('tool.call', () => {
      calls++
      throw new Error('private command and path')
    })

    await expect($.tool.call(CALL as never)).rejects.toThrow('no implementation for tool.call')
    expect(calls).toBe(1)
    expect(lines).toEqual([{ text: 'agent-tree: tool.call hook failed (throw, after next)', to: 'debug' }])
  })

  test('a synchronous debug-log refusal cannot stop the handler or change the tool result', async ($, on) => {
    const { handler } = captured('tool.call')
    expect(handler).toBeDefined()
    let calls = 0
    let logs = 0

    on('tool.call', ($, e) => {
      const replay = () => { calls++; return Promise.resolve(OUTPUT) }
      const caught = Object.assign(replay, {
        error: { kind: 'throw' as const, message: 'body failed', budget: 1000 },
        called: false,
      }) as Parameters<NonNullable<typeof handler>>[2]
      const refused = { ...$, ui: { ...$.ui, log: () => { logs++; throw new Error('log refused') } } } as EngineInterface

      return handler!(refused, e, caught)
    })

    expect(await $.tool.call(CALL as never)).toEqual(OUTPUT)
    expect(calls).toBe(1)
    expect(logs).toBe(1)
  })

  test('a timeout with no message logs its kind alone and passes the event through', async ($, on) => {
    const lines = debugLines(on)
    const { handler } = captured('tool.call')
    expect(handler).toBeDefined()

    on('tool.call', ($, e) => handler!(withLog($, lines), e, Object.assign(() => Promise.resolve(OUTPUT), {
      error: { kind: 'timeout' as const, budget: 1000 },
      called: false,
    }) as Parameters<NonNullable<typeof handler>>[2]))

    expect(await $.tool.call(CALL as never)).toEqual(OUTPUT)
    expect(lines).toEqual([{ text: 'agent-tree: tool.call hook failed (timeout)', to: 'debug' }])
  })
})
