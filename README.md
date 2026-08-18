# Ask Permission

A pi plugin that prompts for confirmation before the agent runs certain bash
commands, such as `git` and `rm`.

## Install

Install directly from this repository (public):

```bash
pi install git:github.com/digitalhurricane-io/pi-ask
```

Or clone it and install by local path:

```bash
git clone git@github.com:digitalhurricane-io/pi-ask.git
pi install ./pi-ask
```

Installing registers the plugin in `~/.pi/agent/settings.json`. Verify with
`pi list`. To uninstall: `pi remove git:github.com/digitalhurricane-io/pi-ask`.

> **Note for contributors:** if you installed from a local working copy, point
> pi at that directory instead (`pi install /path/to/pi-ask`) so edits are
> picked up directly.

## How it works

Every `bash` tool call is checked against the configuration. If it should be
confirmed, a dialog is shown asking for permission:

- **Confirm** → the command runs.
- **Decline** → the command is blocked.
- **No UI** (headless/automation) → fails closed and blocks by default.

## Configuration

Optional JSON file at `~/.pi/agent/ask-permission.json`:

```json
{
  "confirmCommands": ["git *", "rm"],
  "patterns": ["\\brm\\s+(-[a-z]*[rf])"],
  "skipPatterns": ["git\\s+(status|diff|log)\\b"],
  "blockWhenNoUI": true
}
```

| Key              | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `confirmCommands`| Ask when the command matches. Supports `*` globs and plain   |
|                  | leading words: `"git *"` asks for any command starting with |
|                  | `git `; `"rm"` asks for any command whose first word is `rm`.|
| `patterns`       | Regex patterns; ask if any matches the command.            |
| `skipPatterns`   | Regex patterns that override everything (never ask).       |
| `blockWhenNoUI`  | `true` blocks without a UI; `false` allows silently.        |

### Plain word vs `*` glob

There are two ways to list things in `confirmCommands`:

- **Plain word** (`"rm"`, `"git"`): matches the command's **first word** exactly.
  It cannot see what comes after, so it captures *all* subcommands under that
  tool. `"rm"` == `"rm *"` — both ask for every command that starts with `rm`.
- **Glob** (`"git push *"`): matches against the **start of the whole command**,
  so it can narrow to a specific subcommand. A trailing `*` also matches the
  bare word alone (e.g. `"git *"` matches a bare `git`).

| Entry                  | Matches                                            |
| ---------------------- | -------------------------------------------------- |
| `"git"`                | all git commands (first word is `git`)             |
| `"git *"`              | all git commands (same as `"git"`)                 |
| `"git push *"`         | only `git push ...`                                |
| `"git reset --hard *"` | only `git reset --hard ...`                        |
| `"rm"`                 | all commands whose first word is `rm` (== `"rm *"`)|

Defaults ask for `git`, `rm`, and `sudo`, matched against risky `rm -rf` /
`chmod 777` patterns, while skipping read-only git probes (`status`, `diff`,
`log`, etc.).

After editing the config, run `/ask-permission` inside pi (it refreshes the
config) or `/reload`.

## Commands

- `/ask-permission` — show current status, config path, and loaded rules.
