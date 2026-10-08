// External engine workers (PRD M-L1b): an engine CLI (Kimi, grok, Codex,
// OpenCode, ...) that the shell tool starts is drawn as a worker box. Pure,
// no `$`: register.tsx hands each shell tool call to externalCallOf, and
// tree.ts keeps what it found. The command is read here, on this machine,
// and never kept: a node holds the engine, the model and at most TASK_CHARS
// characters of the task. The engine raises `process.spawn` only for a
// plugin's own `$.process.spawn`, so the shell tool's command line is all
// there is to go by.

/** The engine CLIs known without the workerCommands option (PRD M-L1b). */
export const DEFAULT_ENGINES: readonly string[] = [
  'kimi',
  'grok',
  'codex',
  'opencode',
  'gemini',
  'chatgpt',
  'mimo',
  'claude',
  'aider',
]

/** The tools that run shell commands: Bash, and PowerShell on Windows. */
export const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']

/** The most characters of a task a node keeps (PRD M-L1b, privacy). */
export const TASK_CHARS = 40

/** What a command says about the engine it starts: the engine's name in the table, the model, the task. */
export type ExternalWorker = {
  engine: string
  /** The value of `-m`, `--model` or `--model=`. */
  model?: string
  /** The first TASK_CHARS characters of the quoted string after `-p`. */
  task?: string
}

/** One word of a command: its text with the quotes taken off, and whether it was one quoted string and nothing else. */
export type Word = { text: string; quoted: boolean }

/** A program's name as the engine table holds it: no directory, no `.exe` / `.cmd` / `.bat` / `.ps1`, lower case. */
export function programName(text: string): string {
  const path = text.trim()
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

/**
 * The engine table: DEFAULT_ENGINES, then the `workerCommands` option's
 * names (comma-separated), each read as programName reads a command's word
 * (trimmed, lower case, no directory or extension), empty ones dropped, each
 * once.
 */
export function enginesFrom(option: unknown): string[] {
  const extra = typeof option === 'string' ? option.split(',') : []
  const names = [...DEFAULT_ENGINES, ...extra].map(programName).filter(name => name !== '')

  return [...new Set(names)]
}

/** Whether `tool` runs shell commands: Bash or PowerShell, by the exact name. */
export function isShellTool(tool: unknown): boolean {
  return typeof tool === 'string' && SHELL_TOOLS.includes(tool)
}

/** Within a word: a blank or a comma ends it (`'-m','kimi-code/k3'` is two words). */
const BLANKS = new Set([' ', '\t', ','])

/** A line break or `;` ends a segment. */
const BREAKS = new Set(['\n', '\r', ';'])

/**
 * The command's segments, split on `;`, `&&`, `||`, `|` and line breaks
 * outside quotes, each a list of words split on blanks and commas outside
 * quotes. A lone `&` (PowerShell's call operator, a shell's background mark)
 * is a word of its own. Quotes are plain: `'...'` and `"..."` hold everything
 * up to the next same quote, a backslash or a backtick included.
 */
export function segmentsOf(command: string): Word[][] {
  const chars = Array.from(command)
  const segments: Word[][] = []
  let words: Word[] = []
  let text = ''
  let isOpen = false
  let isQuoted = false
  let quote: string | undefined

  const endWord = (): void => {
    if (isOpen) {
      words.push({ text, quoted: isQuoted })
    }

    text = ''
    isOpen = false
    isQuoted = false
  }

  const endSegment = (): void => {
    endWord()

    if (words.length > 0) {
      segments.push(words)
    }

    words = []
  }

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? ''

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else {
        text += char
      }
    } else if (char === '"' || char === "'") {
      // A quote that opens the word: one quoted string so far; inside a word (`--model="x"`): mixed.
      isQuoted = !isOpen
      isOpen = true
      quote = char
    } else if (BLANKS.has(char)) {
      endWord()
    } else if (BREAKS.has(char)) {
      endSegment()
    } else if (char === '|') {
      endSegment()
      index += chars[index + 1] === '|' ? 1 : 0
    } else if (char === '&' && chars[index + 1] === '&') {
      endSegment()
      index += 1
    } else if (char === '&') {
      endWord()
      words.push({ text: '&', quoted: false })
    } else {
      text += char
      isOpen = true
      isQuoted = false
    }
  }

  endSegment()

  return segments
}

/**
 * Words after which the next word is a program to run: `Start-Process kimi`,
 * `-FilePath kimi`, `& kimi`, `nohup kimi`, and the package runners `npx kimi`,
 * `uvx kimi`, `bunx kimi`. Unquoted, in any case, and only at a command
 * position (C7a2b): `Write-Output -FilePath kimi` names no program.
 */
const RUNNERS = new Set(['start-process', '-filepath', '&', 'nohup', 'npx', 'uvx', 'bunx'])

/**
 * Shells, and the flag after which their command line follows: `cmd /c`,
 * `pwsh -c` or `-Command` (PowerShell's and cmd's in any case), `bash -c`,
 * `sh -c`. Only at a command position (C7a2b): `echo bash -c kimi` names no
 * program.
 */
const SHELLS: ReadonlyMap<string, { flags: readonly string[]; isCaseless: boolean }> = new Map([
  ['cmd', { flags: ['/c'], isCaseless: true }],
  ['pwsh', { flags: ['-c', '-command'], isCaseless: true }],
  ['powershell', { flags: ['-c', '-command'], isCaseless: true }],
  ['bash', { flags: ['-c'], isCaseless: false }],
  ['sh', { flags: ['-c'], isCaseless: false }],
])

/** Where a program is named: `run` (a command position) or `shell` (a shell's quoted command line). */
type Place = { index: number; kind: 'run' | 'shell' }

/** A runner word: unquoted, in any case. */
const isRunner = (word: Word | undefined): boolean => word !== undefined && !word.quoted && RUNNERS.has(word.text.toLowerCase())

/** A runner's own flag (`npx -y`, `Start-Process -NoNewWindow`): a word starting with `-` that is no runner word. */
const isRunnerFlag = (word: Word | undefined): boolean => word !== undefined && word.text.startsWith('-') && !isRunner(word)

/**
 * Start-Process's flags that take a value (C7b): the word after one, one
 * word or one quoted string, is its value and no program
 * (`Start-Process -WorkingDirectory D:\repo -FilePath kimi`, `Start-Process
 * -WindowStyle Hidden kimi`). Its switches (`-PassThru`, `-NoNewWindow`,
 * `-Wait`) take none. Unquoted, in any case, as runner words are.
 */
const VALUED_FLAGS = new Set([
  '-workingdirectory',
  '-windowstyle',
  '-verb',
  '-redirectstandardoutput',
  '-redirectstandarderror',
  '-redirectstandardinput',
  '-credential',
  '-argumentlist',
  '-args',
])

/** A runner flag that takes a value: its value is the next word. */
const isValuedFlag = (word: Word | undefined): boolean => word !== undefined && !word.quoted && VALUED_FLAGS.has(word.text.toLowerCase())

/** Where a PowerShell assignment (`$p = Start-Process ...`) leaves the command: the word after `=`; `at` when there is none. */
function afterAssignment(words: readonly Word[], at: number): number {
  const name = words[at]
  const equals = words[at + 1]
  const isName = name !== undefined && !name.quoted && /^\$[\w:]+$/.test(name.text)
  const isEquals = equals !== undefined && !equals.quoted && equals.text === '='

  return isName && isEquals ? at + 2 : at
}

/**
 * Where the command that starts at word `start` names its program (C7a2b,
 * PRD M-L1b), and the word after that place. The command position is its
 * first word (past a PowerShell assignment `$p =`). A runner word there moves
 * it past the runner and the runner's flags (`Start-Process -NoNewWindow
 * -FilePath kimi`, `npx -y kimi`, `& 'C:\x\kimi.exe'`), a valued flag with its
 * value (`Start-Process -WindowStyle Hidden kimi`). A shell there names
 * the word after its command flag, wherever that flag stands (`pwsh
 * -NoProfile -Command "..."`): a command line, read as a command of its own,
 * when the word holds a blank; else a command position again (`cmd /c
 * kimi`). A shell with no command flag names nothing.
 */
function commandAt(words: readonly Word[], start: number): { place?: Place; next: number } {
  let at = afterAssignment(words, start)

  for (let word = words[at]; word !== undefined; word = words[at]) {
    if (isRunner(word)) {
      at += 1

      while (isRunnerFlag(words[at])) {
        at += isValuedFlag(words[at]) ? 2 : 1
      }

      continue
    }

    const shell = SHELLS.get(programName(word.text))

    if (shell === undefined) {
      return { place: { index: at, kind: 'run' }, next: at + 1 }
    }

    const from = at
    const flag = words.findIndex(
      (other, index) => index > from && shell.flags.includes(shell.isCaseless ? other.text.toLowerCase() : other.text),
    )

    if (flag < 0) {
      return { next: at + 1 }
    }

    if (/\s/.test(words[flag + 1]?.text ?? '')) {
      return { place: { index: flag + 1, kind: 'shell' }, next: flag + 2 }
    }

    at = flag + 1
  }

  return { next: at }
}

/**
 * The places in a segment where a program is named: one per command, at its
 * command position (commandAt). The first command starts at the first word;
 * a lone unquoted `&` past a command's place ends that command (the
 * background operator of bash and PowerShell 7, cmd's separator), and the
 * next one starts after it. A runner or shell word anywhere else is an
 * argument like any other.
 */
function placesOf(words: readonly Word[]): Place[] {
  const places: Place[] = []
  let start = 0

  while (start < words.length) {
    const { place, next } = commandAt(words, start)

    if (place !== undefined) {
      places.push(place)
    }

    const separator = words.findIndex((word, index) => index >= next && !word.quoted && word.text === '&')

    if (separator < 0) {
      break
    }

    start = separator + 1
  }

  return places
}

/** A model value: trimmed, not empty, not the next flag. */
function modelOf(value: string | undefined): string | undefined {
  const model = (value ?? '').trim()

  return model === '' || model.startsWith('-') ? undefined : model
}

/** At most TASK_CHARS characters of `text`, trimmed; undefined when nothing is left. */
export function taskText(text: string | undefined): string | undefined {
  const task = Array.from((text ?? '').trim()).slice(0, TASK_CHARS).join('').trim()

  return task === '' ? undefined : task
}

/**
 * The program's arguments from word `from` on, where a string after
 * `-ArgumentList` (`Start-Process kimi -ArgumentList "-m kimi-code/k3"`)
 * counts as the words it holds.
 */
function argumentsFrom(words: readonly Word[], from: number): Word[] {
  const found: Word[] = []

  for (let index = from; index < words.length; index += 1) {
    const word = words[index]
    const before = words[index - 1]

    if (word === undefined) {
      continue
    }

    const isList = before !== undefined && !before.quoted && /^-(?:argumentlist|args)$/i.test(before.text)

    found.push(...(isList && /\s/.test(word.text) ? segmentsOf(word.text).flat() : [word]))
  }

  return found
}

/** The model (`-m <v>`, `--model <v>`, `--model=<v>`, the first one) and the task (`-p "<text>"`) among `args`. */
function modelAndTask(args: readonly Word[]): { model?: string; task?: string } {
  let model: string | undefined
  let task: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? ''
    const next = args[index + 1]

    if (model === undefined && (text === '-m' || text === '--model')) {
      model = modelOf(next?.text)
    } else if (model === undefined && text.startsWith('--model=')) {
      model = modelOf(text.slice('--model='.length))
    }

    if (task === undefined && text === '-p' && next?.quoted === true) {
      task = taskText(next.text)
    }
  }

  return { ...(model === undefined ? {} : { model }), ...(task === undefined ? {} : { task }) }
}

/** How deep quoted command lines are read (`pwsh -c "bash -c '...'"`). */
const MAX_DEPTH = 3

/** The worker a place names: a shell's quoted command line is read as a command of its own. */
function workerAt(words: readonly Word[], place: Place, engines: readonly string[], depth: number): ExternalWorker | undefined {
  const word = words[place.index]

  if (word === undefined) {
    return undefined
  }

  if (place.kind === 'shell' && /\s/.test(word.text)) {
    return workerIn(word.text, engines, depth + 1)
  }

  const engine = programName(word.text)

  return engine !== '' && engines.includes(engine) ? { engine, ...modelAndTask(argumentsFrom(words, place.index + 1)) } : undefined
}

function workerIn(command: string, engines: readonly string[], depth: number): ExternalWorker | undefined {
  if (depth > MAX_DEPTH) {
    return undefined
  }

  for (const words of segmentsOf(command)) {
    for (const place of placesOf(words)) {
      const found = workerAt(words, place, engines, depth)

      if (found !== undefined) {
        return found
      }
    }
  }

  return undefined
}

/**
 * The engine a shell command starts, if any (PRD M-L1b): in each segment,
 * the program each command names at its command position (C7a2b): first,
 * after a chain of runners (`Start-Process`, `-FilePath`, `&`, `nohup`,
 * `npx`, `uvx`, `bunx`) and their flags (a valued flag such as
 * `-WorkingDirectory` with its value, C7b), or as a shell's command line (`cmd
 * /c`, `pwsh -c` / `-Command`, `bash -c`, `sh -c`; a quoted line is read as a
 * command of its own), its directory and extension left off, compared with
 * `engines` in any case. A name anywhere else (`Write-Output kimi`, `grep kimi
 * docs`, `Write-Output -FilePath kimi`, `echo bash -c kimi`) is no program,
 * nor is a name after an environment prefix (`FOO=1 kimi`). The first match
 * wins; its model and task come from the words after it in its segment.
 */
export function externalWorkerOf(command: string, engines: readonly string[]): ExternalWorker | undefined {
  return typeof command === 'string' ? workerIn(command, engines, 0) : undefined
}

/** What a shell tool call's input carries: the envelope spreads the tool's own arguments beside `tool`. */
export type ShellCallInput = {
  tool: string
  command?: unknown
  description?: unknown
  run_in_background?: unknown
}

/** An external worker as one shell tool call starts it. */
export type ExternalCall = ExternalWorker & {
  /** The tool call's own `description`, when it has one. */
  description?: string
  /** `run_in_background`: the tool returns while the engine runs on. */
  background: boolean
}

/** The worker a shell tool call starts, or undefined: another tool, no command, no engine in it. */
export function externalCallOf(input: ShellCallInput, engines: readonly string[]): ExternalCall | undefined {
  if (!isShellTool(input.tool) || typeof input.command !== 'string') {
    return undefined
  }

  const worker = externalWorkerOf(input.command, engines)

  if (worker === undefined) {
    return undefined
  }

  const description = typeof input.description === 'string' && input.description.trim() !== '' ? input.description : undefined

  return { ...worker, ...(description === undefined ? {} : { description }), background: input.run_in_background === true }
}

/**
 * The background task id a shell tool's result names (`backgroundTaskId`:
 * the command runs on in the background), or undefined.
 */
export function backgroundTaskIdOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined
  }

  const id = (result as { backgroundTaskId?: unknown }).backgroundTaskId

  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Whether a shell tool's result says its command was interrupted
 * (`interrupted: true`, as the PowerShell tool's output reports it; C7a2b).
 */
export function interruptedOf(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { interrupted?: unknown }).interrupted === true
}
