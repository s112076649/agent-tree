import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_ENGINES,
  SHELL_TOOLS,
  TASK_CHARS,
  backgroundTaskIdOf,
  enginesFrom,
  externalCallOf,
  externalWorkerOf,
  interruptedOf,
  isShellTool,
  programName,
  segmentsOf,
  taskText,
} from './external'

// C7a2: external engine workers (PRD M-L1b). The shell tool's command line
// is read here, on this machine, for the engine CLI it starts, its model and
// the head of its `-p` task.

const ENGINES = enginesFrom(undefined)

/** What externalWorkerOf finds in `command` with the built-in table. */
const workerOf = (command: string) => externalWorkerOf(command, ENGINES)

describe('the engine table and the shell tools', () => {
  test('the built-in engines; the workerCommands option adds its comma-separated names, trimmed, in lower case, each once', () => {
    expect(DEFAULT_ENGINES).toEqual(['kimi', 'grok', 'codex', 'opencode', 'gemini', 'chatgpt', 'mimo', 'claude', 'aider'])
    expect(enginesFrom(undefined)).toEqual([...DEFAULT_ENGINES])
    expect(enginesFrom('')).toEqual([...DEFAULT_ENGINES])
    expect(enginesFrom('qwen, My-Agent')).toEqual([...DEFAULT_ENGINES, 'qwen', 'my-agent'])
    // Empty entries are dropped and a name already there is not added again.
    expect(enginesFrom(' ,KIMI, qwen,,qwen , ')).toEqual([...DEFAULT_ENGINES, 'qwen'])
    // A name is read as a command's word is: no directory, no extension.
    expect(enginesFrom('C:\\tools\\Qwen.EXE, ./bin/my-agent.ps1')).toEqual([...DEFAULT_ENGINES, 'qwen', 'my-agent'])

    for (const value of [42, true, null, ['qwen'], { qwen: 1 }]) {
      expect(enginesFrom(value), String(value)).toEqual([...DEFAULT_ENGINES])
    }
  })

  test('programName: no directory, no .exe .cmd .bat .ps1 in any case, lower case', () => {
    expect(programName('C:\\Users\\x\\.mimocode\\bin\\mimo.exe')).toBe('mimo')
    expect(programName('/usr/local/bin/kimi')).toBe('kimi')
    expect(programName('.\\Kimi.PS1')).toBe('kimi')
    expect(programName('codex.cmd')).toBe('codex')
    expect(programName('grok.BAT')).toBe('grok')
    expect(programName('kimi.md')).toBe('kimi.md')
    expect(programName('C:\\Program Files\\Kimi\\kimi.exe')).toBe('kimi')
    expect(programName('')).toBe('')
  })

  test('the shell tools are Bash and PowerShell, by their exact names', () => {
    expect(SHELL_TOOLS).toEqual(['Bash', 'PowerShell'])
    expect(['Bash', 'PowerShell'].map(isShellTool)).toEqual([true, true])
    expect(['bash', 'powershell', 'Read', 'Agent', 'Monitor', '', undefined, 7].map(isShellTool)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })
})

describe('segmentsOf: segments and words', () => {
  const texts = (command: string): string[][] => segmentsOf(command).map(words => words.map(word => word.text))

  test('segments split on ; && || | and line breaks, words on blanks and commas; a lone & is a word', () => {
    expect(texts('a;b && c || d | e & f\ng\r\nh')).toEqual([['a'], ['b'], ['c'], ['d'], ['e', '&', 'f'], ['g'], ['h']])
    expect(texts("Start-Process kimi -ArgumentList '-m','kimi-code/k3'")).toEqual([
      ['Start-Process', 'kimi', '-ArgumentList', '-m', 'kimi-code/k3'],
    ])
    expect(texts('cmd 2>&1')).toEqual([['cmd', '2>', '&', '1']])
    expect(texts('   ')).toEqual([])
  })

  test('quotes hold blanks and separators; a word is quoted only when it is one quoted string', () => {
    expect(segmentsOf('echo "a; b && c | d" \'e f\'')).toEqual([
      [
        { text: 'echo', quoted: false },
        { text: 'a; b && c | d', quoted: true },
        { text: 'e f', quoted: true },
      ],
    ])
    expect(segmentsOf('--model="x y" a"b"c "" \'\'')).toEqual([
      [
        { text: '--model=x y', quoted: false },
        { text: 'abc', quoted: false },
        { text: '', quoted: true },
        { text: '', quoted: true },
      ],
    ])
    // Backslash and backtick are plain characters: a Windows path keeps its last backslash.
    expect(texts('Set-Location "D:\\proj\\"; kimi -m a')).toEqual([['Set-Location', 'D:\\proj\\'], ['kimi', '-m', 'a']])
    // A quote left open holds the rest.
    expect(texts('kimi -p "do X; and Y')).toEqual([['kimi', '-p', 'do X; and Y']])
  })
})

describe('externalWorkerOf: the engine, the model and the task (PRD M-L1b)', () => {
  test('the forms the owner runs: Kimi, Start-Process, Codex with chatgpt-6.1sol, pwsh -c, MiMo by its path, OpenCode, claude -p', () => {
    expect(workerOf('kimi -m kimi-code/k3 -p "do X"')).toEqual({ engine: 'kimi', model: 'kimi-code/k3', task: 'do X' })
    expect(workerOf("Start-Process -FilePath kimi -ArgumentList '-m','kimi-code/k3','-p','...'")).toEqual({
      engine: 'kimi',
      model: 'kimi-code/k3',
      task: '...',
    })
    expect(workerOf('codex exec -m chatgpt-6.1sol "fix tests"')).toEqual({ engine: 'codex', model: 'chatgpt-6.1sol' })
    expect(workerOf('codex -m chatgpt-6.1sol "fix tests"')).toEqual({ engine: 'codex', model: 'chatgpt-6.1sol' })
    expect(workerOf('codex --model=chatgpt-6.1sol "fix tests"')).toEqual({ engine: 'codex', model: 'chatgpt-6.1sol' })
    expect(workerOf('pwsh -c "codex exec -m chatgpt-6.1sol \'fix tests\'"')).toEqual({ engine: 'codex', model: 'chatgpt-6.1sol' })
    expect(workerOf('C:\\Users\\x\\.mimocode\\bin\\mimo.exe run --dir d -m xiaomi/mimo-v2.6-pro --yolo "msg"')).toEqual({
      engine: 'mimo',
      model: 'xiaomi/mimo-v2.6-pro',
    })
    expect(workerOf('opencode run -m zai-wallet/glm-4.6 "card C7"')).toEqual({ engine: 'opencode', model: 'zai-wallet/glm-4.6' })
    // `-p` is claude's print flag here, no quoted string follows it: no task.
    expect(workerOf('claude -p --model sonnet "summarize the diff"')).toEqual({ engine: 'claude', model: 'sonnet' })
    expect(workerOf('cd repo && kimi -m kimi-code/k3 -p "do X"')).toEqual({ engine: 'kimi', model: 'kimi-code/k3', task: 'do X' })
  })

  test('a name that is no program is no worker: an argument, a file, another command, a quoted string', () => {
    for (const command of [
      'grep kimi docs',
      'cat kimi.md',
      'git log',
      'Write-Output kimi',
      'Write-Output "kimi -m kimi-code/k3"',
      'git commit -m "run kimi with codex"',
      'echo codex | Out-Null',
      'Get-Content C:\\tools\\kimi\\notes.md',
      '.\\kimi.md',
      'Write-Output "&" kimi',
      '"kimi -p x"',
      'grep -c kimi docs',
      '',
    ]) {
      expect(workerOf(command), command).toBeUndefined()
    }

    expect(externalWorkerOf(undefined as unknown as string, ENGINES)).toBeUndefined()
    expect(externalWorkerOf('kimi -m a', [])).toBeUndefined()
  })

  test('every segment counts: after ; || | and a line break; the first worker found wins', () => {
    expect(workerOf('git status; kimi -p "go"')).toEqual({ engine: 'kimi', task: 'go' })
    expect(workerOf('make || grok --model grok-4')).toEqual({ engine: 'grok', model: 'grok-4' })
    expect(workerOf('Get-Content plan.md | kimi -p "go"')).toEqual({ engine: 'kimi', task: 'go' })
    expect(workerOf('git pull\nKIMI.EXE -m a')).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('kimi -m a; codex -m b')).toEqual({ engine: 'kimi', model: 'a' })
    // The model and the task come from the worker's own segment.
    expect(workerOf('codex exec "x"; echo -m b -p "c"')).toEqual({ engine: 'codex' })
  })

  test('runners name the program after them: Start-Process, -FilePath, the call operator &, nohup', () => {
    expect(workerOf('& kimi -m a')).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('& "C:\\Program Files\\Kimi\\kimi.exe" -m a -p "do X"')).toEqual({ engine: 'kimi', model: 'a', task: 'do X' })
    expect(workerOf('nohup kimi -m a &')).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('Start-Process kimi')).toEqual({ engine: 'kimi' })
    expect(workerOf("$p = Start-Process -FilePath grok -ArgumentList '--model','grok-4' -PassThru")).toEqual({
      engine: 'grok',
      model: 'grok-4',
    })
    // One string after -ArgumentList holds the program's words.
    expect(workerOf("Start-Process kimi -ArgumentList \"-m kimi-code/k3 -p 'do X'\" -NoNewWindow")).toEqual({
      engine: 'kimi',
      model: 'kimi-code/k3',
      task: 'do X',
    })
  })

  test('a shell names the program after its command flag; a quoted command line is read as a command of its own', () => {
    expect(workerOf('cmd /c kimi -m a -p "x"')).toEqual({ engine: 'kimi', model: 'a', task: 'x' })
    expect(workerOf('cmd.exe /S /C "kimi -m a"')).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('bash -c \'kimi -m a -p "x"\'')).toEqual({ engine: 'kimi', model: 'a', task: 'x' })
    expect(workerOf('sh -c "cd repo && grok --model grok-4"')).toEqual({ engine: 'grok', model: 'grok-4' })
    expect(workerOf('pwsh -NoProfile -ExecutionPolicy Bypass -Command "codex exec -m chatgpt-6.1sol \'x\'"')).toEqual({
      engine: 'codex',
      model: 'chatgpt-6.1sol',
    })
    expect(workerOf('powershell -command "kimi -m a"')).toEqual({ engine: 'kimi', model: 'a' })
    // bash's flags keep their case: -C is not -c.
    expect(workerOf('bash -C "kimi -m a"')).toBeUndefined()
    // A command line holding no engine is no worker.
    expect(workerOf('pwsh -c "Write-Output kimi"')).toBeUndefined()
  })

  test('the model: -m, --model or --model=, the first one; never the next flag or nothing', () => {
    expect(workerOf('kimi --model kimi-code/k3')).toEqual({ engine: 'kimi', model: 'kimi-code/k3' })
    expect(workerOf('kimi -m first -m second')).toEqual({ engine: 'kimi', model: 'first' })
    expect(workerOf('kimi -m -p "x"')).toEqual({ engine: 'kimi', task: 'x' })
    expect(workerOf('kimi --model=')).toEqual({ engine: 'kimi' })
    expect(workerOf('kimi -m')).toEqual({ engine: 'kimi' })
    expect(workerOf('kimi -M big')).toEqual({ engine: 'kimi' })
  })

  test(`the task: the quoted string after -p, its first ${TASK_CHARS} characters; an unquoted word is no task`, () => {
    const long = 'Fix the failing layout tests in hooks and report back in detail'
    const chinese = '修复'.repeat(30)

    expect(workerOf(`kimi -p "${long}"`)).toEqual({ engine: 'kimi', task: long.slice(0, 40).trim() })
    expect(workerOf(`kimi -p "${long}"`)?.task).toHaveLength(40)
    expect(workerOf(`kimi -p "${chinese}"`)?.task).toBe('修复'.repeat(20))
    expect(workerOf('kimi -p go')).toEqual({ engine: 'kimi' })
    expect(workerOf('kimi -p "   "')).toEqual({ engine: 'kimi' })
    expect(taskText('  do X  ')).toBe('do X')
    expect(taskText('')).toBeUndefined()
    expect(taskText(undefined)).toBeUndefined()
  })

  test('the workerCommands option extends the table, in any case', () => {
    const engines = enginesFrom('qwen, My-Agent')

    expect(externalWorkerOf('QWEN -m qwen3-coder -p "x"', engines)).toEqual({ engine: 'qwen', model: 'qwen3-coder', task: 'x' })
    expect(externalWorkerOf('C:\\bin\\My-Agent.CMD --model=m1', engines)).toEqual({ engine: 'my-agent', model: 'm1' })
    expect(externalWorkerOf('kimi -m a', engines)).toEqual({ engine: 'kimi', model: 'a' })
    // Without the option neither is known.
    expect(workerOf('qwen -m qwen3-coder')).toBeUndefined()
    expect(workerOf('my-agent --model=m1')).toBeUndefined()
  })
})

// C7a2b: a runner or a shell word counts only at a command position (PRD
// M-L1b): a segment's first word, or the word after a chain of runners and
// shells and their flags; npx, uvx and bunx join the runners.
describe('externalWorkerOf: the command position (C7a2b, PRD M-L1b)', () => {
  test('a runner or a shell word past the command position is an argument: the former false positives are no workers', () => {
    for (const command of [
      'Write-Output -FilePath kimi',
      'echo bash -c kimi',
      'Write-Output "&" kimi',
      'echo nohup kimi -m a',
      'Write-Output Start-Process kimi',
      'echo npx kimi -m x',
      'Write-Output cmd /c kimi',
      "Write-Output pwsh -c 'kimi -m a'",
      // An environment prefix is no runner: a known miss (README).
      'FOO=1 kimi -m a',
    ]) {
      expect(workerOf(command), command).toBeUndefined()
    }
  })

  test('npx, uvx and bunx are runners: the program is the word after them and their flags', () => {
    expect(workerOf('npx kimi -m x')).toEqual({ engine: 'kimi', model: 'x' })
    expect(workerOf('npx kimi')).toEqual({ engine: 'kimi' })
    expect(workerOf('uvx kimi -p "do X"')).toEqual({ engine: 'kimi', task: 'do X' })
    expect(workerOf('BUNX grok --model grok-4')).toEqual({ engine: 'grok', model: 'grok-4' })
    // A scoped package is named by its last part, as a path is.
    expect(workerOf('npx -y @openai/codex exec -m chatgpt-6.1sol "fix tests"')).toEqual({ engine: 'codex', model: 'chatgpt-6.1sol' })
  })

  test('the command position runs through a chain of runners, shells and their flags', () => {
    expect(workerOf('nohup bash -c "kimi -m a -p \'x\'"')).toEqual({ engine: 'kimi', model: 'a', task: 'x' })
    expect(workerOf("& 'C:\\x\\kimi.exe' -m a")).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('cmd /c npx kimi -m a')).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf("Start-Process -NoNewWindow -FilePath kimi -ArgumentList '-m','a'")).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('& pwsh -NoProfile -c "codex exec -m chatgpt-6.1sol \'x\'"')).toEqual({ engine: 'codex', model: 'chatgpt-6.1sol' })
    expect(workerOf('$job = & kimi -m a')).toEqual({ engine: 'kimi', model: 'a' })
    // A shell with no command flag names no program.
    expect(workerOf('bash kimi.sh')).toBeUndefined()
  })

  test('a lone unquoted & past the command position ends the command, and the next one starts after it', () => {
    expect(workerOf('git status & kimi -m a')).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('Write-Output & kimi')).toEqual({ engine: 'kimi' })
    expect(workerOf('kimi -m a 2>&1')).toEqual({ engine: 'kimi', model: 'a' })
    expect(workerOf('echo x 2>&1')).toBeUndefined()
    // Quoted it is an argument.
    expect(workerOf('Write-Output "&" kimi')).toBeUndefined()
  })
})

// C7b slice 0: Start-Process's flags that take a value. In the runner chain
// the word after one, one word or one quoted string, is its value, never the
// program; its switches take none.
describe('externalWorkerOf: Start-Process valued flags (C7b, PRD M-L1b)', () => {
  test('a valued flag and its value are skipped in the runner chain: the program after them is read', () => {
    expect(workerOf('Start-Process -WorkingDirectory D:\\repo -FilePath kimi -m k -p "x"')).toEqual({ engine: 'kimi', model: 'k', task: 'x' })
    expect(workerOf('Start-Process -WindowStyle Hidden kimi -m k')).toEqual({ engine: 'kimi', model: 'k' })
    // One quoted string is one value.
    expect(workerOf('Start-Process -WorkingDirectory "D:\\my repo" kimi -m k')).toEqual({ engine: 'kimi', model: 'k' })
    // Every flag of the table, in any case.
    expect(workerOf('start-process -windowstyle hidden -VERB RunAs kimi')).toEqual({ engine: 'kimi' })
    expect(
      workerOf('Start-Process -RedirectStandardOutput out.txt -RedirectStandardError err.txt -RedirectStandardInput in.txt kimi -m k'),
    ).toEqual({ engine: 'kimi', model: 'k' })
    expect(workerOf('Start-Process -Credential $cred -FilePath grok --model grok-4')).toEqual({ engine: 'grok', model: 'grok-4' })
    expect(workerOf('Start-Process -ArgumentList "run x" -FilePath mimo')).toEqual({ engine: 'mimo' })
    expect(workerOf('Start-Process -Args x kimi')).toEqual({ engine: 'kimi' })
  })

  test('switches take no value: -PassThru, -NoNewWindow, -Wait', () => {
    expect(workerOf('Start-Process -PassThru -NoNewWindow -Wait kimi -m k')).toEqual({ engine: 'kimi', model: 'k' })
    expect(workerOf('$p = Start-Process -Wait -WindowStyle Hidden -PassThru -FilePath kimi -m k')).toEqual({ engine: 'kimi', model: 'k' })
  })

  test('the value is never the program; a flag with its value after a colon is one word', () => {
    expect(workerOf('Start-Process -WorkingDirectory C:\\tools\\kimi -FilePath notepad')).toBeUndefined()
    expect(workerOf('Start-Process -WindowStyle kimi')).toBeUndefined()
    expect(workerOf('Start-Process -WorkingDirectory:D:\\repo kimi -m k')).toEqual({ engine: 'kimi', model: 'k' })
  })
})

describe('externalCallOf and backgroundTaskIdOf: a shell tool call and its result', () => {
  test('a shell call that starts an engine: the worker, the call description, whether it runs in the background', () => {
    expect(
      externalCallOf(
        { tool: 'Bash', command: 'kimi -m kimi-code/k3 -p "do X"', description: 'Run kimi on card C7', run_in_background: true },
        ENGINES,
      ),
    ).toEqual({ engine: 'kimi', model: 'kimi-code/k3', task: 'do X', description: 'Run kimi on card C7', background: true })
    expect(externalCallOf({ tool: 'PowerShell', command: 'codex exec -m chatgpt-6.1sol "fix"' }, ENGINES)).toEqual({
      engine: 'codex',
      model: 'chatgpt-6.1sol',
      background: false,
    })
    // A blank description is none.
    expect(externalCallOf({ tool: 'Bash', command: 'kimi', description: '  ', run_in_background: 'yes' }, ENGINES)).toEqual({
      engine: 'kimi',
      background: false,
    })
  })

  test('another tool, no command, or no engine in it: no worker', () => {
    expect(externalCallOf({ tool: 'Monitor', command: 'kimi -m a' }, ENGINES)).toBeUndefined()
    expect(externalCallOf({ tool: 'bash', command: 'kimi -m a' }, ENGINES)).toBeUndefined()
    expect(externalCallOf({ tool: 'Bash', command: 'git log' }, ENGINES)).toBeUndefined()
    expect(externalCallOf({ tool: 'Bash' }, ENGINES)).toBeUndefined()
    expect(externalCallOf({ tool: 'PowerShell', command: 42 }, ENGINES)).toBeUndefined()
  })

  test('backgroundTaskIdOf: the result names the background task the command runs on as', () => {
    expect(backgroundTaskIdOf({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b7k2' })).toBe('b7k2')

    for (const result of [undefined, null, 'b7k2', {}, { backgroundTaskId: '' }, { backgroundTaskId: 7 }]) {
      expect(backgroundTaskIdOf(result), JSON.stringify(result)).toBeUndefined()
    }
  })

  test('interruptedOf: the result says the command was interrupted (C7a2b)', () => {
    expect(interruptedOf({ stdout: '', stderr: '', interrupted: true })).toBe(true)

    for (const result of [undefined, null, 'interrupted', {}, { interrupted: false }, { interrupted: 'true' }, { interrupted: 1 }]) {
      expect(interruptedOf(result), JSON.stringify(result)).toBe(false)
    }
  })
})
