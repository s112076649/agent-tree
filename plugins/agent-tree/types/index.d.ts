// agent-tree state contract (PRD section 9). hooks/register.tsx alone writes
// these values; every other file of the plugin builds or reads them as plain
// data. Fields a reading may not have yet are optional and drawn as `--`,
// never as 0.

/** What the main loop is doing: between turns, waiting on the model, or running tools. */
export type MainStatus = 'idle' | 'thinking' | 'tooling'

/** The main conversation's row. */
export type MainNode = {
  /** The main loop's model id (`claude-opus-5-5`); absent until the first reading. */
  model?: string
  /** Effort of its latest model request (`low` ... `max`, or a number as text). */
  effort?: string
  /** Prompts the person has sent this session (`$.session.turns()`). */
  turns: number
  status: MainStatus
  /** Main-loop tool calls still running (parallel calls count each). */
  toolsRunning?: number
}

/** What a subagent does, as its box is titled (PRD M-L1a): reads and reports, or changes things. */
export type AgentRole = 'worker' | 'researcher'

/**
 * One subagent, from agent.spawn, turn.step, tool.call, turn.complete and
 * `$.agent.list()`; or an external worker, from the shell tool call that
 * started it (`kind: 'external'`, PRD M-L1b).
 */
export type AgentNode = {
  /** The agent id, as `$.agent.list()` and every event of its loop name it; `ext:<tool_use_id>` for an external worker. */
  id: string
  /**
   * `external`: an engine CLI (`kimi`, `codex`, ...) the shell tool started
   * (PRD M-L1b; hooks/external.ts reads the command, which is never kept).
   * Its type is the engine's name, its model the one the command named, its
   * description at most 40 characters of the task. Absent on a Claude
   * subagent.
   */
  kind?: 'external'
  /** The subagent whose loop spawned this one (or ran the shell tool, for an external worker); absent when the main loop did. */
  parentId?: string
  /** Its agent definition (`Explore`, `general-purpose`, `teammate`, ...); an external worker's engine (`kimi`). */
  type: string
  /** The Agent call's short description; an external worker's task, at most 40 characters. */
  description: string
  /**
   * `researcher` or `worker` (PRD M-L1a): roleOf (hooks/role.ts) reads the
   * type, the description and the prompt's head when the node opens (the
   * prompt itself is not kept); from its first Edit, Write or NotebookEdit
   * call it is `worker` for good.
   */
  role: AgentRole
  /** The model it runs on, a resolved id when known (`claude-sonnet-5-5`). */
  model?: string
  /** Effort of its latest model request. */
  effort?: string
  /** `running`, `completed`, `failed`, `killed`, or another engine task status. */
  status: string
  /** True when it runs in the background. */
  background?: boolean
  /**
   * An external worker that runs on in the background: the id of its
   * background task as the shell tool's result named it (`backgroundTaskId`),
   * by which `classic.Stop`'s `background_tasks` is read.
   */
  taskId?: string
  /** The last tool it called. */
  lastTool?: string
  /** How many tool calls it made. */
  toolCalls: number
  /** When this ledger opened it, in ms since the epoch. */
  startedAt?: number
  /** When it stopped running, in ms since the epoch. */
  endedAt?: number
  /** Its run's wall-clock length as its turn.complete reported it. */
  durationMs?: number
}

/** The agent tree: the main row and every subagent seen this session. */
export type TreeSnapshot = {
  main: MainNode
  agents: AgentNode[]
  /** When the tree last changed, in ms since the epoch; 0 before the first change. */
  updatedAt: number
}

/** One rate-limit window as `$.session.usage()` reports it. */
export type RateLimitReading = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** The stats line's figures, copied from `$.session.usage()`. */
export type StatsSnapshot = {
  contextTokens?: number
  /** The context window in tokens; absent before the first reading. */
  contextWindow?: number
  contextPercent?: number
  costUsd?: number
  /** Empty while no window has a reading. */
  rateLimits: RateLimitReading[]
  /** When the session began, in ms since the epoch; absent before the first reading. */
  startedAt?: number
  /** When the figures were read, in ms since the epoch; 0 before the first reading. */
  updatedAt: number
}

/** Where the advisor figures come from: the append rows alone, or with the transcript's model and tokens. */
export type AdvisorSource = 'append' | 'append+transcript' | 'none'

/** One advisor call whose result came (C7c, PRD M-L5): the advisor box lists the latest five. */
export type AdvisorCall = {
  /** When its `advisor_tool_result` block arrived, in ms since the epoch. */
  at: number
  /** Its start to its result; absent when its start was not seen (a call made before the plugin loaded). */
  latencyMs?: number
}

/**
 * The advisor area: calls and their timing from the main loop's response rows
 * (`session.append`), the advisor's model and tokens from the transcript. The
 * advice itself is encrypted by the API and never kept.
 */
export type AdvisorSnapshot = {
  /** The advisor's model id (`claude-fable-5-1`), from the transcript; absent until read. */
  model?: string
  /** Advisor calls of the main loop seen this session. */
  calls: number
  /** When the latest call started (its `server_tool_use` block), in ms since the epoch. */
  lastCallStartedAt?: number
  /** When the latest call's result arrived (its `advisor_tool_result` block), in ms since the epoch. */
  lastCallAt?: number
  /** The latest call's start to its result. */
  lastLatencyMs?: number
  /** Input tokens of every advisor call in the transcript (`usage.iterations[]` of type `advisor_message`). */
  inputTokens?: number
  /** Output tokens of the same. */
  outputTokens?: number
  source: AdvisorSource
  /** Why the tokens are not shown (`transcript too large`). */
  tokensUnavailable?: string
  /** The last failure reading the transcript, short (no stack); the next stop tries again. */
  error?: string
  /** The call in flight: its block id (`''` when the block had none); absent between calls. */
  pendingCallId?: string
  /** Ids of the latest calls counted (at most 20): a block seen again is not counted again. */
  callIds?: string[]
  /** `calls` as of the last transcript read: a read is due while `calls` is past it. */
  readCalls?: number
  /**
   * True from a call's `server_tool_use` block until its `advisor_tool_result`
   * block (C7c): the advisor box is lit and the frame turns. A transcript
   * read never sets it; session.start clears one a reload left, and a flag
   * set IN_FLIGHT_STALE_MS ago or more (hooks/activity.ts, 10 minutes) is
   * drawn and counted as idle.
   */
  inFlight: boolean
  /** When the call in flight started, in ms since the epoch (`Date.now()`, the clock the pane is drawn on); absent while none is. */
  inFlightSince?: number
  /** The latest calls whose result came, at most 5, oldest first and newest last (C7c). */
  recentCalls: AdvisorCall[]
}

/** One Jev flag as the pane draws it. */
export type JevFlag = {
  key: string
  label: string
  p: number
  sharp: boolean
}

/** The Jev area: on or off, the latest answer or failure, and the call times the hourly cap counts. */
export type JevSnapshot = {
  enabled: boolean
  calls: number
  lastAt?: number
  flags: JevFlag[]
  health?: number
  healthLowConfidence?: boolean
  error?: string
  /** When each call of the last hour was made, answered or not, oldest first (PRD M-J5). */
  callTimes?: number[]
  /**
   * True from a tick's claim of a call (its compare-and-set write before
   * `$.http.fetch`) until the write of that call's answer or failure (C7c):
   * the Jev box is lit and the frame turns. No other write sets it;
   * session.start clears one a reload left, and a flag set
   * IN_FLIGHT_STALE_MS ago or more (hooks/activity.ts) is drawn and counted
   * as idle.
   */
  inFlight: boolean
  /** When the call in flight was claimed, in ms since the epoch (`Date.now()`, the clock the pane is drawn on); absent while none is. */
  inFlightSince?: number
}

/** What happened: a tool call ended, a turn ended, a prompt was sent. */
export type JevEventKind = 'tool' | 'turn' | 'prompt'

/** Whose loop it happened in: the main loop or a subagent, never which one. */
export type JevSide = 'main' | 'sub'

/** One event as the Jev ring keeps it: no input, no result, no text (PRD M-J3). */
export type JevEvent = {
  kind: JevEventKind
  agent: JevSide
  /** The tool's name, on a tool event. */
  tool?: string
  /** Whether the tool call or the turn ended in an error; absent on a prompt. */
  isError?: boolean
  /** When it happened, in ms since the epoch. */
  at: number
}

/**
 * One tool call in flight (PRD M-L3, C7b): from its `tool.call` until it
 * returned, rejected, or its loop's turn ended.
 */
export type ActivityCall = {
  /** The call's `tool_use_id`; `''` when the event carried none. */
  id: string
  /** The subagent whose loop runs it; absent for the main loop. */
  agentId?: string
  /** The tool's name (`Read`, `Bash`). */
  tool: string
  /** When it started, in ms since the epoch. */
  since: number
}

/** What the main loop is doing now (PRD M-L3): its phase, the tool it runs, since when. */
export type MainActivity = {
  phase: MainStatus
  /** While tooling: the tool of its latest call in flight. */
  tool?: string
  /** When the phase began (tooling: when that call started), in ms since the epoch; absent while idle. */
  since?: number
}

/**
 * The live activity (PRD M-L3, section 9; C7b): the main loop's phase and
 * the tool calls in flight in every loop, written from turn.step, tool.call
 * and turn.complete and read by the pane and the frame timer, never by the
 * Jev summary. A loop's current tool is its latest call in `calls`; an
 * external worker's activity is its node's start, as its tools are not seen.
 * The advisor's and Jev's calls in flight are kept in their own atoms
 * (C7c: `advisor.inFlight`, `jev.inFlight`), not here.
 */
export type ActivitySnapshot = {
  main: MainActivity
  /** The tool calls in flight, oldest first, at most 64. */
  calls: ActivityCall[]
  /** When it last changed, in ms since the epoch; 0 before the first change. */
  updatedAt: number
}

/**
 * What a session log line is about (PRD M-L7, C7d). The log box draws `fail`
 * in the fail red, `advisor` in the advisor's color, `jev` in Jev's, and the
 * rest plain.
 */
export type LogKind =
  /** A subagent or an external worker started. */
  | 'spawn'
  /** A tool call ended without an error. */
  | 'tool'
  /** A subagent or an external worker finished. */
  | 'done'
  /** A tool call that failed or was denied, a subagent that failed, a worker that was killed, a Jev call that failed. */
  | 'fail'
  /** An advisor call started or its result came. */
  | 'advisor'
  /** A Jev call started or was answered. */
  | 'jev'
  /** The person sent a prompt. */
  | 'prompt'
  /** The main loop's turn ended. */
  | 'turn'

/**
 * One line of the session log (PRD M-L7, section 9; C7d): when, who, what.
 * The text is a short hint read off the event on this machine (a file name,
 * a command's first 40 characters, a search pattern) and is only ever drawn
 * on the pane: the log lives in session memory, is never written to a file,
 * and no part of it reaches the Jev summary.
 */
export type LogEntry = {
  /** When it happened, in ms since the epoch (the clock the pane is drawn on). */
  at: number
  /**
   * Whose event it is, at most 10 columns: `main`, a subagent's type or an
   * external worker's engine (`Explore`, `kimi`; a second one of the same
   * type is `Explore#2`), `fable` for the advisor, `jev`.
   */
  who: string
  kind: LogKind
  /** The event as one short line: `Read README.md`, `done 2m31s`, `advising...`; at most 120 characters, no line break. */
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-tree': {
      tree: TreeSnapshot
      stats: StatsSnapshot
      advisor: AdvisorSnapshot
      jev: JevSnapshot
      /** The latest events (at most 50) the Jev summary is built from. */
      jevEvents: JevEvent[]
      /** True while the pane is placed (drawn) for the person. */
      isOpen: boolean
      /**
       * The pane's animation frame, 0 to 3 (PRD M-L4): the 250 ms timer moves
       * it on only while the pane is open and something is active, so an idle
       * session writes nothing.
       */
      frame: number
      /** What each loop is doing right now (PRD M-L3, C7b): written only when it changed. */
      activity: ActivitySnapshot
      /**
       * The session log (PRD M-L7, C7d): a line per event, at most 200, the
       * newest last. Session memory alone: never written to a file, never in
       * the Jev summary, and `session.start` leaves it as it is.
       */
      log: LogEntry[]
    }
  }
}
