# agent-tree

A Claude Code plugin for watching who is working: optional **bottom HUD lines under the prompt**, merged into your existing status line, and a detailed **Agent Tree pane on demand**. It shows the main conversation, Claude subagents and external engine workers, the Fable advisor, opt-in Jev advisory flags, and session usage.

agent-tree only watches. It never blocks, changes or starts a tool call or a prompt. Jev flags are advice for you to read.

Version **0.2.0** is a mod built from function hooks, with no npm dependencies or build step. The optional status line wrapper is a separate, zero-dependency Node script.

## Install

Requires Claude Code 2.1.287 or later; the current release gates were run on 2.1.293 on Windows 11. See [Compatibility](#compatibility).

From GitHub:

```shell
claude plugin marketplace add s112076649/agent-tree
claude plugin install agent-tree@agent-tree
```

The repository is a marketplace named `agent-tree`; the plugin is `agent-tree@agent-tree`. Start a new Claude Code session to load it. The pane opens with `/agent-tree`; the bottom HUD needs the optional setup below.

To download the source and install from a local clone instead:

```shell
git clone https://github.com/s112076649/agent-tree.git
claude plugin marketplace add ./agent-tree
claude plugin install agent-tree@agent-tree
```

To update a GitHub install:

```shell
claude plugin marketplace update agent-tree
claude plugin update agent-tree@agent-tree
```

Start a new session after updating. Existing sessions keep their loaded plugin code. For a local-path marketplace, update your clone before updating the plugin.

To remove it, first undo any bottom HUD setup as described below, then:

```shell
claude plugin uninstall agent-tree@agent-tree
claude plugin marketplace remove agent-tree
```

These command forms were checked against local Claude Code 2.1.293 `--help`. A local marketplace install was verified on 2.1.289; the public GitHub install is not yet end-to-end verified.

## Bottom HUD (optional)

1. Open `/plugin configure agent-tree@agent-tree` in Claude Code and turn on **Status line HUD** (`statusLineHud`). Keep **Open pane at start** (`autoOpen`) off if you want the pane only on demand.
2. Save your current `statusLine` value, then edit that property in `~/.claude/settings.json` (or the settings file in `$CLAUDE_CONFIG_DIR` when set). Use the wrapper as the command, followed by your current status line program and its arguments, and add `"refreshInterval": 2`.
3. Start a new session.

Replace `<config dir>` in these examples with your full config directory, using forward slashes. A GitHub marketplace is a full clone under `<config dir>/plugins/marketplaces/agent-tree/`; its wrapper has this stable path:

```text
<config dir>/plugins/marketplaces/agent-tree/plugins/agent-tree/statusline/agent-tree-statusline.mjs
```

`marketplace update` refreshes that clone. Installed plugin copies live in versioned folders under `<config dir>/plugins/cache/`; use the marketplace clone's wrapper path above so your settings do not point at an old version. With a marketplace added from a local clone, use `<your clone>/plugins/agent-tree/statusline/agent-tree-statusline.mjs` instead.

For claude-hud users whose existing command is `node "<config dir>/plugins/claude-hud/statusline.mjs"`, the settings property becomes:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<config dir>/plugins/marketplaces/agent-tree/plugins/agent-tree/statusline/agent-tree-statusline.mjs\" node \"<config dir>/plugins/claude-hud/statusline.mjs\"",
    "refreshInterval": 2
  }
}
```

Use your actual existing claude-hud command and location if they differ. The wrapper passes the same session JSON on stdin and the same environment to the inner program, prints its stdout unchanged, then appends the HUD lines. It runs the inner program **without a shell**, with a 2-second timeout. Put a pipeline, `&&`, shell expansion or other shell syntax in a script file and pass that script's program and arguments instead. Failures are quiet and the wrapper exits with code 0.

For HUD lines alone, omit the inner command:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<config dir>/plugins/marketplaces/agent-tree/plugins/agent-tree/statusline/agent-tree-statusline.mjs\"",
    "refreshInterval": 2
  }
}
```

On Windows, Claude Code runs the status line through Git Bash when it finds it, otherwise PowerShell. Forward slashes work in both shells. Keep the first token, `node`, **unquoted** and available on PATH: a quoted first token is a string in PowerShell. Quote the script paths, replace placeholders with full paths, and do not rely on `~` expanding inside a quoted path. Claude Code passes the width through `COLUMNS`; the wrapper uses that width minus four columns.

`refreshInterval` is in seconds (at least 1); it refreshes besides event-driven runs so elapsed times keep moving while the main conversation waits. Measured on one Windows 11 machine with 28 threads: about 0.33 seconds of CPU per full run (PowerShell startup 0.23 s, wrapper 0.03 s, claude-hud 0.07 s). At an interval of 2 seconds this was about 0.6% of the whole machine per open session. This is a machine-specific measurement; users on smaller machines or with many sessions can raise the interval.

To undo: restore the saved `statusLine` value, turn `statusLineHud` off, then delete `<config dir>/agent-tree/hud/` to remove snapshots. The plugin does not edit your settings or claude-hud's configuration.

## What it shows

The samples below are produced from sample data by the plugin's own functions, with colors omitted. They are offline renderings, not terminal screenshots.

The bottom HUD at 120 columns, using the shared C9a fixture:

```text
agent-tree  main [opus-5-5 · high · tooling Read]  subagents [5/5]  fable [on call · 3]  jev [idle · 7]
◐ researcher sonnet-5-5 Explore Read/3 48s │ ◐ researcher haiku-4-5 Plan Grep/2 1m02s
◐ worker opus-5-5 general-purpose Edit/8 1m15s │ ◐ worker sonnet-4-5 general-purpose Bash/5 2m10s │ +1 more
jev  looping ████░ 0.85  stuck █░░░░ 0.10  fan-out wide ██░░░ 0.40  near done ████░ 0.70  health 0.9 needs attention
```

The first line shows the main model, effort and activity, running/total agents (including external workers), and the advisor and Jev states and call counts. Up to two lines pack running agents with their role, model, type or engine, tool/count for Claude subagents, and elapsed time; `+k more` names what does not fit. The final line shows Jev flags and health only when Jev is enabled and has flags or health. The HUD has at most four lines. As width shrinks it drops detail, flag bars and trailing flags; its narrowest status form also drops the `agent-tree` label. The HUD spinner is static; elapsed times are calculated when the wrapper prints.

The on-demand pane at 100 columns, with a main tool call, three subagents, advisor history, Jev flags, session log and usage:

```text
AGENT TREE   ▮ main   ▮ subagents   ▮ fable · advisor   ▮ jev · flags
┌───────────────────────────────────────────────────────────────────┐ ┌────────────────────────────┐
│ main session  opus-5-5 · high · turn 3                            │ │ FABLE ADVISOR fable-5-1    │
│ ◐ tooling Read 2s                                                 │ │ on call · idle             │
└───────────────────────────────────────────────────────────────────┘ │ calls 4 · read 454k tok    │
                                  │                                   │ out 2k tok                 │
┌───────────────────────────────────────────────────────────────────┐ │ last 17:01:31 (21.1s)      │
│ JEV · advisory  idle                                              │ │ ◇ 17:01:31  21.1s          │
│ calls 3 · last 17:00:40                                           │ │ ◇ 17:00:25  18.4s          │
│ looping      █░░░░░░░░ 0.11 sharp  stuck     █░░░░░░░░ 0.06 sharp │ │ ◇ 16:57:30  --             │
│ fan-out wide █░░░░░░░░ 0.09 sharp  near done ██░░░░░░░ 0.18 split │ │ ◇ 16:55:00  12.3s          │
│ health 0.9 needs attention                                        │ │ advice: encrypted by API   │
└───────────────────────────────────────────────────────────────────┘ └────────────────────────────┘
                        delegate to subagents
           ●──────────────────────┼──────────────────────┐
           ▼                      ▼                      ▼
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ worker             │ │ researcher         │ │ worker             │
│ sonnet-5-5 · gene~ │ │ sonnet-5-5 · Expl~ │ │ sonnet-5-5 · gene~ │
│ Draft the chapter~ │ │ List the changed ~ │ │ Edit the test sui~ │
│ ✓ 2m31s            │ │ ◐ Grep/3 2m30s     │ │ ◐ Bash/1 2m29s     │
└────────────────────┘ └────────────────────┘ └────────────────────┘
┌───────────────────────────────────────────────────────────────────┐ ┌────────────────────────────┐
│ 17:01:00  main     prompt                                         │ │ ctx ▓▓▓▓░░░░░░ 41% 410k/1M │
│ 17:01:02  Explore  spawn Explore List docs files                  │ │ 5h  ▓▓░░░░░░░░ 23%         │
│ 17:01:10  main     Read README.md                                 │ │ 7d  ▓▓▓▓░░░░░░ 41%         │
│ 17:01:19  Explore  Grep shouldClearRing                           │ │ $1.23 · agents 2/3         │
│ 17:01:20  jev      jev calling...                                 │ │ 00:42:10                   │
│ 17:01:28  fable    advising...                                    │ │                            │
│ 17:01:31  fable    advised 21.1s                                  │ │                            │
│ 17:01:32  jev      jev ok · calls 3                               │ │                            │
│ 17:01:33  main     fail Bash npm test -- --reporter=verbose       │ │                            │
│ 17:01:34  jev      jev error HTTP 401 key rejected                │ │                            │
│ 17:01:35  Explore  done 2m31s                                     │ │                            │
│ 17:01:38  main     turn done 41s                                  │ │                            │
└───────────────────────────────────────────────────────────────────┘ └────────────────────────────┘
main [opus-5-5 · high · tooling Read]  subagents [2/3]  fable [on call · 4]  jev [idle · 3]
```

<!-- screenshot: docs/screenshots/pane-windows-terminal.png (to be added by the owner) -->

The pane uses two columns from 88 body columns, and stacks boxes in one column below that width. It fits the rows available, keeping the main box, agents and status row first. Worker/researcher boxes put the model before the type; at the default 92 columns a model often takes the whole line, so widen the pane to see the type. The main box shows model, effort, turn count and live activity. Active boxes have brighter borders, bold titles, spinners and elapsed time; active subagent connectors carry a moving dot, updated on a 250 ms frame timer. Animation stops when everything is idle.

The advisor column shows its model, in-flight state, calls, token counts, last latency and the latest five calls; its advice remains encrypted by the API. The Jev box shows in-flight state and successful answer count, compact flags and health in the wide pane, and a separate error row. The session log shows recent events and local tool hints. Usage shows Claude Code's context, cost and rate-limit readings; unknown readings are `--`, and absent rate-limit readings are omitted.

Color legend: main orange, subagents and external workers blue, advisor purple, Jev green, failures and high looping/stuck flags red. Finished agents and idle borders are dim. Advisor and Jev calls in flight use inverse text. The HUD label is dim; the palette uses text colors without fixed backgrounds. HUD readability on a light terminal background is not yet verified.

External workers are inferred locally from shell-tool commands, not from scanning system processes. Built-in names are `kimi`, `grok`, `codex`, `opencode`, `gemini`, `chatgpt`, `mimo`, `claude` and `aider`; `workerCommands` adds names. Foreground workers end with their tool call; background workers are reconciled with Claude Code's task list at stop hooks. Tool names, model requests, spawns and turn endings come from Claude Code hooks; the agent list and session usage are refreshed every `refreshMs`. Advisor calls come from response rows, and advisor model/token readings from the local session transcript.

## Usage

- `/agent-tree` toggles the pane. It reports that the pane opened, closed, or is open but not drawn, with Claude Code's reason.
- `autoOpen` is **off by default**. Turn it on to ask Claude Code to open the pane at activation; the engine decides whether there is room to dock it. Closing the pane leaves it closed until `/agent-tree` opens it again, or a new activation with `autoOpen` on requests it.
- With `statusLineHud` on, the plugin clears its status entry once at activation and pins no further entry. With it off, the usual compact entry remains.

## Configuration

| Key | Title | Default | Range | What it does |
|---|---|---|---|---|
| `refreshMs` | Refresh interval (ms) | `2000` | 500–10000 | Re-read the agent list and session usage, in milliseconds. |
| `autoOpen` | Open pane at start | `false` | Boolean | Ask for the pane at activation; otherwise use `/agent-tree`. |
| `statusLineHud` | Status line HUD | `false` | Boolean | Write the display snapshot for the wrapper and suppress the plugin status entry. |
| `paneColumns` | Pane width (columns) | `92` | 60–160 | Requested body width; the dock or a user resize can override it. |
| `workerCommands` | External worker commands | `""` | String | Comma-separated extra executable names, added to the built-in list; parsed locally. |
| `jevEnabled` | Jev flags | `false` | Boolean | Send the limited summary to TypeSafe Jev; needs `TYPESAFE_API_KEY`. |
| `jevIntervalSec` | Jev interval (s) | `60` | 15–600 | Minimum seconds between calls; requires new events. |
| `jevMaxCallsPerHour` | Jev calls per hour | `60` | 1–240 | Maximum attempts in a rolling hour, including failures. |

Use `/plugin configure agent-tree@agent-tree` in Claude Code. From a shell, `claude plugin configure agent-tree@agent-tree` alone shows options without changing them; `claude plugin configure agent-tree@agent-tree --values-stdin` reads a JSON object of single-line strings and keeps options you omit. For example, the input object `{"statusLineHud":"true","autoOpen":"false"}` enables the snapshot and leaves the pane on demand. At install time, `--config KEY=VALUE` can set an option.

Claude Code stores marketplace options under `pluginConfigs["agent-tree@agent-tree"].options` in user settings. A `--plugin-dir` load uses `agent-tree@inline`; project settings are not read for these options. Numbers are kept within the declared bounds, with defaults for unreadable values. Options are read at activation; changing an option reloads the plugin in running sessions. Updating code does not reload those sessions: start a new one after an update.

## Privacy

agent-tree reads what Claude Code already shows you: the subagents, the session's figures and the advisor calls. Besides that, after a turn in which the main conversation called its advisor, it **reads that session's transcript file on disk, locally, for the advisor's model and token counts; nothing from it leaves your machine**. It makes **no network request of its own** unless you turn on **Jev flags**, which are **off by default**. With `statusLineHud` on it writes the display snapshot described below; with it off the plugin writes no file of its own.

### Local display snapshot

Only `statusLineHud: true` enables snapshot writes to `<config dir>/agent-tree/hud/<session id>.json`. `<config dir>` is `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude` (the plugin uses `USERPROFILE`, then `HOME`, to find the home folder). The snapshot contains the session id, update timestamp and display segments with widths, colors, styles and start times: model names, tool names, counts, activity states, Jev flag scores and health. It contains no prompt, subagent description, worker task text, command, path or session log line, and is not sent to Jev.

The plugin writes when the display content changes, checked every 250 ms while something is active and every `refreshMs`; unchanged content gets a heartbeat every 30 seconds. The wrapper ignores snapshots for another session or older than 120 seconds. When it runs, it removes `*.json` snapshots older than 24 hours, at most once an hour, using a local `.cleanup` marker. With no wrapper running there is no automatic cleanup; turning the option off stops writes but does not delete old snapshots. Local processes with access to the config folder can read them. Delete `<config dir>/agent-tree/hud/` after disabling the HUD to remove them immediately.

### Session log and plugin state

The pane's session log keeps the latest 200 events in plugin state, with local hints: file basenames, the first 40 characters of shell commands, search patterns and short subagent descriptions. Prompt entries contain only the word `prompt`. The log is not written to a file, included in the HUD snapshot or sent to Jev.

Claude Code allows other installed plugins to read plugin state. They can therefore read this log and the tree's subagent descriptions and external worker task text. Other plugins can also observe tool inputs through their own hooks; the session log is not a private store isolated from them.

### Jev flags (opt-in)

Jev is a judgment model run by TypeSafe. When you turn it on, agent-tree sends a small summary of the session to TypeSafe from time to time and draws four flags (looping, stuck, fan-out wide, near done) and a health score in the pane and, when enabled, the bottom HUD. The flags are for you to read: agent-tree never blocks, changes or starts anything because of them.

To turn it on:

1. Put your TypeSafe API key in the environment variable `TYPESAFE_API_KEY` before you start Claude Code. The name is fixed: Claude Code lets a plugin read only the environment variables its code names literally, so it cannot be an option.
2. Turn on **Jev flags** (`jevEnabled`) with `/plugin configure agent-tree@agent-tree` in Claude Code (see [Configuration](#configuration)).

The first flags come after the next activity in the session (a tool call, the end of a turn or a prompt), because a call is made only when something happened since the last one.

To turn it off, turn `jevEnabled` off again. A plugin that started with Jev off makes no request, and its pane shows `Jev off — enable in /plugin configure agent-tree@agent-tree`. You can check this: start Claude Code with `--debug-file <path>` and search that file for `http.fetch (agent-tree)`; with Jev off it holds no such line. To force Jev off for one run of a `--plugin-dir` load, whatever your settings say, add `--settings '{"pluginConfigs":{"agent-tree@inline":{"options":{"jevEnabled":false}}}}'`. Both were checked in a real headless run.

### When you switch Jev on

agent-tree keeps the latest events of the session in the session's memory, at most 50: the kind of event, main conversation or subagent, the tool's name, whether it failed, and the time. It keeps them while Jev is off too. Nothing of it is saved, and nothing is sent while Jev is off.

On an activation that switches Jev from off to on, that list is cleared first, including when the switch reloads the plugin. Reloading while Jev is already on does not clear it. So the first summary covers only what happens after you switched Jev on, and `recentTools` never names a tool you used before. If the clearing fails, that activation sends nothing: the pane shows `Jev off — enable in /plugin configure agent-tree@agent-tree` and the debug log gets one line with the reason. In a real headless run with Jev on, the first answer counted only the events after the plugin started.

### The key

- It is read from `TYPESAFE_API_KEY` and sent only in the `Authorization: Bearer` header of the request to `https://api.typesafe.ai/v1/systemone`.
- While Jev is on, it is read at every tick of the Jev timer and after every turn of the main conversation, whether or not a call follows. "On" means the option is on and the plugin's start-up has already stored that switch; right after a reload, until then, nothing reads the key.
- It is never saved, shown in the pane or written to a log.
- If an error message contains a bearer token, the token is replaced by `Bearer ***` before the pane shows the message. The debug log masks the key itself and any bearer token as well.

### How often

- At most one call every `jevIntervalSec` seconds (default 60; you can set 15 to 600).
- A call is made only if something happened since the last one: a tool call ended, a turn ended (main conversation or subagent), or a prompt entered the session.
- At most `jevMaxCallsPerHour` calls in any hour (default 60; you can set 1 to 240). Failed calls count too.
- A failed call waits out the same interval. There is no retry loop. The pane shows `JEV error:` with the HTTP status and a short reason, never the response body.
- A failed call also writes one line to Claude Code's debug log, with the key and any bearer token masked. The line for a missing key is written only once.

Earlier development calls used 862 to 1,030 input tokens and 87 output tokens each. At 60 calls an hour, a workload of that size would use about 51,720–61,800 input and 5,220 output tokens on your TypeSafe key. Current usage varies with the summary and Jev build; these historical measurements are not a token limit or a price quote.

### What is sent

Each call sends one JSON body:

```json
{ "model": "jev-latest", "state": { ...the summary below... }, "questions": { ...fixed questions... } }
```

`questions` is fixed text written in `hooks/jev-core.ts` (prompt version 2): four yes-or-no questions (`looping`, `stuck`, `fanout_wide`, `near_done`) and one score (`health`: healthy, needs attention, intervene now). It holds nothing from your session.

`state`, the session summary, holds exactly these fields and nothing else:

| Field | What it is | Example |
|---|---|---|
| `minutesActive` | Whole minutes since the session started; `null` until known. | `14` |
| `turns` | How many prompts you sent this session (a count, not the text). | `6` |
| `contextPercent` | How full the context window is, in whole percent; `null` before the first response. | `41` |
| `agents.total` | Claude subagents and external engine workers seen this session, together. | `3` |
| `agents.running` | Claude subagents and external engine workers running now, together. | `2` |
| `agents.failed` | Agents or external engine workers that failed or were stopped. | `0` |
| `agents.maxDepth` | How deep subagents are nested: 1 when only the main conversation started them, 0 when there are none. | `1` |
| `externalWorkers.total` | External engine workers among `agents.total`; a count only. | `1` |
| `externalWorkers.running` | External engine workers among `agents.running`; a count only. | `1` |
| `recentTools` | The latest 20 tool calls, oldest first. Each one has the four fields below. | |
| `recentTools[].agent` | `main` or `sub`. It never says which subagent. | `"sub"` |
| `recentTools[].tool` | The tool's name, such as `Read`, `Bash` or `mcp__server__tool`, cut to 64 characters. A name with anything other than letters, digits and `_ . : -` is sent as `?`. | `"Grep"` |
| `recentTools[].isError` | Whether that call ended in an error; a refused call counts as one. | `false` |
| `recentTools[].repeatsPrevious` | Whether the previous call on the same side (main or sub) used the same tool. | `true` |
| `consecutiveErrors` | How many of the latest tool calls in a row ended in an error. | `0` |
| `consecutiveSameTool` | How many of the latest calls in a row used the same tool, on the side of the latest call. | `1` |
| `minutesSinceLastTool` | Whole minutes since the latest tool call; `null` if there was none. | `0` |
| `minutesSinceLastUserPrompt` | Whole minutes since the latest prompt; `null` if there was none. | `9` |

The `fanout_wide` question distinguishes Claude subagents (`agents` minus `externalWorkers`) from external engine workers. Engine names, models, commands and tasks are not sent.

### What is never sent

- code or file contents;
- file or folder paths, and the working directory;
- your prompts and the model's replies;
- tool inputs and outputs, such as commands, search patterns and URLs;
- subagent descriptions, ids, types and model names;
- the session id, the transcript, cost and rate-limit figures.

A unit test (`hooks/jev-core.test.ts`) checks this. It builds the summary from a session whose subagent descriptions, tool names and events carry file paths, a command, a prompt and reply text. The test fails if the summary has a key named `path`, `content`, `prompt`, `text`, `file`, `command` or `input`, or if any of those paths, or a subagent's type, model or id, appears in it.

### What comes back

Jev answers with a probability for each flag and a health score from 0 to 2 with its confidence. A flag is `sharp` when its probability is 0.8 or more, or 0.2 or less, and `split` otherwise. A `looping` or `stuck` flag from 0.8 is drawn in red. A health score whose confidence is under 0.3 is drawn dim with `low confidence`.

- The pane shows `JEV · advisory` beside `idle` or `calling now…`, then `calls <n> · last <HH:mm:ss>`. The flags are advice from a model whose calibration is not known. `last` is the time of the last attempt, a failed one included; `calls` counts answers only. The HUD puts the call state and count in its status line, and flags and health on a separate line; it omits error text.
- After a failed call the flags and the health score of the last answer stay in the pane, and the error is drawn on its own row below them, in red (for example `JEV error: HTTP 401 key rejected`). The next answer replaces both. Before the first answer the pane shows the header and the error.
- The answer is kept in session state and drawn in the pane; with the HUD enabled its display text also appears in the local snapshot.
- One line per answer goes to Claude Code's debug log, which exists only when you run `claude --debug` or `--debug-file`. The line holds the time, `events <n>` (how many events the summary was built from: a count, no names), the Jev build, the input and output tokens, and each figure. It holds no part of the summary.

### Organization policies

Claude Code's plugin API declarations say that an administrator's policy can refuse a plugin's network requests. A refused Jev call shows as a `JEV error:` row in the pane and is not tried again before the next interval. This path is covered by a test with a simulated refusal only.

## Compatibility

- Claude Code **2.1.287+** is the function-hook baseline. Earlier development used 2.1.287; packaging and the local marketplace install were verified on 2.1.289; the live-topology work was checked on 2.1.289–2.1.292; the 0.2.0 release gates run on **2.1.293**. Newer versions have not been verified here.
- The wrapper is written for **Node 18+**, with no dependencies, and tested on **Node 24.16.0**. Node 18 is not yet verified. Node is needed only for the wrapper.
- Use a terminal with box-drawing/block glyphs and **24-bit color** support for the intended palette. The pane has terminal and desktop test mounts; those are not proof of a particular terminal's paint.

| Surface | Evidence |
|---|---|
| Windows Terminal | A live wide pane was observed during the topology spike; a dark-background HUD was observed with preserved claude-hud output and advancing agent times. The complete 0.2.0 pane/HUD screenshot matrix remains open. |
| PowerShell console (conhost), desktop Code tab | Terminal/desktop test mounts; final real-surface checks remain open. |
| VS Code extension | Pane not drawn; hooks can run. Not verified here. |
| Headless `claude -p`, Agent SDK | No pane. Windows headless hook behavior was checked in earlier development; the Agent SDK was not checked. |
| macOS, Linux | Wrapper and real rendering not verified. |

## Known limits

- HUD behavior after `/clear` or resuming a session is **unverified**. Claude Code can change the session id without `session.start`; the publisher reads the id at each write, but the live transition has not been tested.
- HUD readability on a **light terminal background**, the wrapper on **macOS/Linux**, and **Node 18** remain unverified.
- Updates require a **new session**; running sessions keep their old code. A new wrapper with an old snapshot works, but an old wrapper cannot print the new packed-agent snapshot format and quietly omits that HUD.
- With the HUD off, Claude Code draws the plugin's compact status entry with a warning sign and the `agent-tree:` prefix. Both belong to Claude Code and cannot be changed by the plugin.
- With claude-hud's `display.showAgents` on, its own subagent rows (including task descriptions) duplicate agent-tree's running-agents lines. Turn those rows off in claude-hud's own settings if you prefer one display.
- Pane width is a request. At 92 columns, simultaneous advisor/Jev activity can force the status row to omit effort; agent boxes often show only the model. Limited height hides lower-priority details.
- External-worker parsing does not resolve environment prefixes such as `FOO=1 kimi`, PowerShell variables such as `-ArgumentList $args`, abbreviated flags such as `-Wi Hidden`, or a comma-separated `-ArgumentList '-m','a'` before the executable.
- A subagent whose end never arrives can remain running. Background worker durations end when a stop hook discovers completion. The tree keeps at most 200 nodes; after pruning, duplicate-type `#n` labels in the log can change.
- The session log keeps 200 entries. Reloading does not clear it; `/clear` is intended to keep it and the tree/call bookkeeping, but the live behavior is not verified. Advisor token readings after a transcript change describe that transcript. Log entries such as `advised` carry latency, not token counts.
- Advisor transcripts over 3.5 MiB are left unread; token figures become `tok n/a (transcript too large)`. The file API has a 4 MiB read bound and no range read.
- Jev's `last` is the latest attempt, including failures; `calls` counts answers. After a failed call the pane retains the previous flags and health until the next answer. The HUD does not show error text. Real hourly-cap, policy-refusal and failure cases are covered by mocks, not a complete live test matrix.
- The GitHub installation path is documented from CLI help and the marketplace-clone behavior; an actual public-repository install has not been verified before publication.

## Development

From the repository root:

```shell
claude plugin validate ./plugins/agent-tree --strict
claude plugin validate .
claude plugin test ./plugins/agent-tree
node --test ./plugins/agent-tree/statusline/entry.test.mjs
```

The three release gates are plugin/marketplace validation, plugin-kit tests, and Node wrapper-entry tests: 0 errors/warnings, **450 pass / 0 fail**, and **25 pass / 0 fail** for 0.2.0. Validation lists hooks, API calls, state reads/writes and environment reads. The permitted environment names are `CLAUDE_CONFIG_DIR`, `HOME`, `TYPESAFE_API_KEY` and `USERPROFILE`; only `publishHud` writes snapshots.

Load the plugin for one development session without installing it:

```shell
claude --plugin-dir ./plugins/agent-tree
```

Claude Code writes generated API types under `plugins/agent-tree/.claude-plugin/types/` (git-ignored). Hook registrations and engine calls live in `hooks/register.tsx`; the other hook modules format and update plain data, and drawing only reads state. The wrapper's independent `.mjs` modules use Node's standard library. No build is needed.

The version is declared in `plugins/agent-tree/.claude-plugin/plugin.json`; each release updates it and [CHANGELOG.md](CHANGELOG.md). Release gates do not verify the public GitHub download or the remaining live-screen checks.

## License

MIT. See [LICENSE](LICENSE).
