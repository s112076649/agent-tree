# Changelog

All notable changes to agent-tree are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The version lives only in `plugins/agent-tree/.claude-plugin/plugin.json` (its `version` field); the marketplace entry does not repeat it. Each release changes it there and adds an entry here, because an installed copy is not updated until the version changes.

## [0.2.0] - 2026-10-08

### Added

- A live topology pane with bordered main, agent, advisor, Jev, session-log and usage boxes; two columns from 88 body columns and a stacked layout below that width. Worker/researcher boxes and narrow agent lines put the model before the type.
- Live activity, tool names, elapsed times, active-border highlighting, spinners and a moving connector dot; the pane's 250 ms animation stops while idle.
- The advisor column's in-flight state and latest five calls, and the Jev box's in-flight state, compact flags, health and separate error row.
- A 200-entry session log with local tool hints and external-worker completion events; the log stays in plugin state and is excluded from Jev requests and HUD snapshots.
- External engine worker boxes inferred from shell-tool calls, background-task reconciliation and the `workerCommands` option for extra executable names. The `paneColumns` option requests a body width (default 92, range 60–160).
- Optional bottom HUD lines appended to an existing status line by a zero-dependency Node wrapper, or displayed alone. The `statusLineHud` option (default off) enables a session-specific display snapshot, change-based writes and a 30-second heartbeat; the wrapper ignores stale/mismatched snapshots, cleans old snapshots, packs agents into two lines and caps the HUD at four lines.

### Changed

- `autoOpen` is now off by default; `/agent-tree` opens the pane on demand and still toggles it closed. Existing explicit option values keep their effect.
- With `statusLineHud` on, the plugin clears its status entry at activation and pins no further entry, leaving the bottom HUD as the compact display.
- Jev-off text now names `/plugin configure agent-tree@agent-tree`. The pane legend title has an explicit orange color for visibility.
- Jev prompt version 2 includes separate, counts-only `externalWorkers.total` and `externalWorkers.running` fields and distinguishes engine workers from Claude subagents in the fan-out question.

### Fixed

- External-worker parsing recognizes command positions and valued `Start-Process` flags; aborted or interrupted foreground workers are closed, and background workers are reconciled at main and subagent stop hooks.
- Advisor and Jev in-flight flags are cleared on abort/reload or a failed Jev claim path; refresh preserves Jev's calling marker when the compact status entry is enabled.
- Seven gating hooks have fail-open catch handlers that log a bounded debug line and forward the original event, so plugin failures can pass through without blocking the session.
- The wrapper handles status-line stdin that remains open with bounded reads and a quiet exit, preserving the inner program's stdout.

## [0.1.0] - 2026-10-05

The first release.

### Added

- The Agent Tree pane, docked beside the chat. A title row with the main conversation's model, effort and turn, then the `main` row (`idle`, `thinking`, `tooling`) and one row per subagent, nested by the subagent that started it. A subagent row shows its status (`run`, `done`, `fail`, `kill`), type, model, effort, description, last tool and tool calls, and running time. When rows do not fit, the oldest give way to a `+k more` line. Under 60 columns, descriptions and then other columns are left out.
- The stats lines: context use, session cost, the 5-hour and 7-day rate-limit windows, running and total subagents, and the session clock. A figure not reported yet is drawn as `--`, never as 0.
- The status-line entry `agent-tree <running>/<total> · ctx <p>% · $<usd>`, with `fable <n>` once the advisor has been called.
- The `/agent-tree` command, which opens the pane or closes it while it is drawn. With the `autoOpen` option, the plugin asks Claude Code to open the pane at session start.
- The advisor line: the main conversation's advisor calls, counted from its response rows, with the time and latency of the last one. The advisor's model and token counts are read from the local session transcript after the turn. The advice itself is never shown (`advice: encrypted by API`). A transcript over 3.5 MiB is not read, and the line says `tok n/a (transcript too large)`.
- Jev flags, opt-in and off by default: `looping`, `stuck`, `fan-out wide` and `near done` as probability bars marked `sharp` or `split`, a health score, and an `advisory` label in the header. Privacy limits:
  - only a whitelisted summary is sent: counts, whole minutes, the context percent, and the latest tool calls by side (main or sub), tool name and error flag;
  - the key comes from the `TYPESAFE_API_KEY` environment variable alone and is never saved, shown or logged;
  - a call is made only after new events, at most once per `jevIntervalSec`, and at most `jevMaxCallsPerHour` times an hour;
  - the event list is cleared when Jev is switched on.

  A failed call keeps the last flags and adds a red `JEV error:` row.
- Five options in `/config`: `refreshMs`, `autoOpen`, `jevEnabled`, `jevIntervalSec`, `jevMaxCallsPerHour`.
- Packaging. A marketplace manifest at the repository root (`.claude-plugin/marketplace.json`), with the plugin in `plugins/agent-tree/`. Plugin metadata: author, homepage, repository, license and keywords. The MIT license, a README for the repository and one for the plugin, and this changelog.
- 119 tests in 6 files, run with `claude plugin test`.
