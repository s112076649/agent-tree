# agent-tree

Bottom HUD lines for Claude Code, merged into your status line, and the Agent Tree pane on demand: the main conversation, subagents and external engine workers, the Fable advisor, opt-in Jev flags and the session's figures. It only watches; it never blocks or changes a tool call or a prompt.

This folder is the plugin. The repository root is its marketplace, and the [root README](../../README.md) covers the bottom HUD setup, what it shows, privacy, compatibility, development and the known limits.

## Install

```shell
claude plugin marketplace add s112076649/agent-tree
claude plugin install agent-tree@agent-tree
```

Start a new session to load it. The bottom HUD also needs a status line setting: see [Bottom HUD](../../README.md#bottom-hud-optional) in the root README.

For development, load this folder for one session instead, from the repository root: `claude --plugin-dir ./plugins/agent-tree`.

## Use

- `/agent-tree` opens the pane, or closes it while it is drawn.
- `autoOpen` is off by default. With it on, the plugin asks Claude Code to open the pane when a session starts; Claude Code docks it where there is room for a sidebar.
- With `statusLineHud` on, the plugin writes the display snapshot the status line wrapper prints and pins no status entry.

## Options

Set them with `/plugin configure agent-tree@agent-tree` in Claude Code (see [Configuration](../../README.md#configuration) in the root README).

| Key | Default | Range | What it does |
|---|---|---|---|
| `refreshMs` | `2000` | 500 to 10000 | How often the pane re-reads the agent list and the session usage, in milliseconds. |
| `autoOpen` | `false` | | Ask for the pane when a session starts; otherwise use `/agent-tree`. |
| `statusLineHud` | `false` | | Write the local display snapshot for the status line wrapper and pin no status entry. |
| `paneColumns` | `92` | 60 to 160 | Body columns the pane asks for; a width you set on the dock wins. |
| `workerCommands` | `""` | | Extra command names, comma-separated, shown as external workers when the shell tool runs them. |
| `jevEnabled` | `false` | | Send a privacy-limited session summary to TypeSafe Jev for the flags. Needs `TYPESAFE_API_KEY`. |
| `jevIntervalSec` | `60` | 15 to 600 | Least time between two Jev calls, in seconds. |
| `jevMaxCallsPerHour` | `60` | 1 to 240 | Most Jev calls in any hour. |

Jev is off by default, and with it off the plugin makes no network request. Read [Privacy](../../README.md#privacy) before you turn it on: it lists every field that is sent, and what the local HUD snapshot holds.

## Development

See [Development](../../README.md#development) in the root README: the validation and test gates, and `claude --plugin-dir`.

## License

MIT. See [LICENSE](../../LICENSE).
