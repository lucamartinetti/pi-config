# pi-config

Personal configuration for the [pi coding agent](https://pi.dev): settings, model
definitions, subagents, and two locally forked extensions.

This is a working setup, not a framework. Clone it to get the same behaviour, or
read it for the forks and the wiring.

## What's in it

| Piece | What it provides |
|---|---|
| `agent/settings.json` | Provider/model defaults, theme, enabled models, installed packages |
| `agent/models.json` | Custom model definitions and per-model provider routing |
| `agent/agents/` | Four subagents: `planner`, `reviewer`, `scout`, `worker` |
| `agent/extensions/pi-recap/` | **Fork** of `@fradser/pi-recap@0.1.11` — live `◐ Goal:` / `↳ Activity:` lines while a run is active, `✦ Recap:` when idle |
| `agent/extensions/pi-subagents/` | **Fork** of `@tintinweb/pi-subagents@0.22.0` — adds cancellation for scheduled subagent jobs |
| `agent/extensions/reload-runtime.ts` | `/reload-runtime` command + `reload_runtime` tool |
| `agent/config/`, `agent/supi/`, `agent/recap.json` | Config for the permission gate, prompt suggestions, and recap |

Third-party packages, pinned by `agent/npm/package-lock.json`:

| Package | Version | Purpose |
|---|---|---|
| `@mrclrchtr/supi-prompt-suggestions` | 11.0.1 | Ghost-text next-prompt suggestions |
| `@mrclrchtr/supi-settings` | 11.0.1 | `/supi-settings` UI (required by the above) |
| `pi-verdict` | 0.15.0 | Classifier-backed tool permission gate |
| `@fradser/pi-kit` | 0.5.1 | Library used by the recap fork |
| `croner`, `nanoid` | ^10.0.1, ^5.1.16 | Libraries used by the subagents fork |

## Requirements

- pi 1.4.0 or newer (`pi --version`)
- Node.js and git
- Provider access, e.g. an OpenRouter key via `pi auth` or environment variables

## Install

```bash
git clone git@github.com:lucamartinetti/pi-config.git ~/.pi
cd ~/.pi
pi update --extensions   # installs the packages declared in agent/settings.json
pi auth                  # credentials are not tracked
```

`pi update --extensions` reads `agent/settings.json` and installs into
`agent/npm/` using the committed lockfile. If that step misbehaves, `npm ci` in
`agent/npm/` produces the same tree.

Clone somewhere other than `~/.pi` if you prefer: point pi at the directory with
`PI_CODING_AGENT_DIR=/path/to/pi-config/agent`.

### After cloning

1. **Pick your model.** `defaultModel` is pinned to
   `openrouter/deepseek/deepseek-v4.1-flash-1017`, and `agent/models.json` pins
   that model to specific OpenRouter providers (`together`, `baseten`, fallbacks
   off). Change both if you use a different model or provider.
2. **Review the permission gate.** `agent/config/pi-verdict.json` allow-lists
   `ls`, denies reads of shell/SSH/GPG config, and routes everything else through
   a classifier. Tighten or loosen before trusting it with your machine.
3. **Add your own MCP servers.** `agent/mcp.json` is gitignored (it tends to hold
   absolute paths); create it with `pi mcp add`.

## Layout

```
agent/
  settings.json        # provider/model, theme, enabled models, packages
  models.json          # custom model definitions + provider routing overrides
  recap.json           # recap display config
  supi/config.json     # prompt-suggestion model
  config/              # pi-verdict permission gate config
  agents/              # custom subagents
  prompts/             # prompt templates (empty)
  extensions/          # local extensions, loaded automatically
  npm/                 # dependency manifest + lockfile for the above
```

Pi loads everything in `agent/extensions/` without an install step. The two forks
reach their non-host dependencies through symlinked `node_modules` entries into
`agent/npm/node_modules/`:

```
agent/extensions/pi-recap/node_modules/@fradser/pi-kit
agent/extensions/pi-subagents/node_modules/{croner,nanoid}
```

`pi-kit`, `croner`, and `nanoid` are declared as direct dependencies in
`agent/npm/package.json` so `pi update --extensions` keeps them present. The host
packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `typebox`) are peer dependencies supplied by pi — do
not vendor them.

## The forks

Both are MIT-licensed upstream code, modified in place. Each keeps its upstream
`LICENSE` and its version string, so the base version is visible in
`package.json`. Local changes are described in each fork's `README.md` and
`CHANGELOG.md`.

- **`pi-recap`** — infers a `◐ Goal:` and a `↳ Activity:` line from recent tool
  activity (two model calls when a run starts, then at most one pair every 30s),
  shows a `💭 Thinking:` excerpt, hides the previous `✦ Recap:` while a run is
  active, and raises the recap length limit from 120 to 200 characters. The
  upstream tool-trail line is gone.
- **`pi-subagents`** — adds `manage_schedule` (`list` / `cancel` / `pause` /
  `resume`), a `[schedule-complete]` marker that lets a recurring agent cancel
  itself, `maxRuns` / `cancelOn` auto-cancel, removal of settled one-shots, and
  `subagents:rpc:schedules:list` / `cancel` RPCs. See its `CHANGELOG.md`.

Neither fork is published. They are updated by hand when upstream moves: diff
the new upstream tarball against the fork, re-apply the local changes, bump the
version string.

## Model notes

Recap, prompt suggestions, and the verdict classifier use the main model. All
three are pinned to `openrouter/deepseek/deepseek-v4.1-flash-1017`; keep them in
sync with `defaultModel` when you change it, otherwise they silently run a
different model than chat.

`settings.json` sets `enabledModels` explicitly, and that is load-bearing:
`supi-prompt-suggestions` resolves its model against pi's *scoped*
`enabledModels`, which is empty unless set. The first entry pins startup to the
main model (scoped models can override startup selection); `*/*` keeps every
model available for cycling.

`models.json` also defines `deepseek/deepseek-v4.1-flash:nitro` as a selectable
model (1M context, reasoning, text + image input), independent of the `-1017`
default.

## Maintenance

`agent/settings.json` is tracked, but pi rewrites parts of it at runtime — model
selection, theme, `lastChangelogVersion`. Expect diff noise there; commit the
parts you mean and ignore the rest. Sessions, credentials, installed
`node_modules`, and runtime state are gitignored:

- `agent/auth.json` — credentials
- `agent/sessions/` — transcripts
- `agent/npm/node_modules/`, `agent/bin/`, `agent/models-store.json` — installable
- `agent/pi-subagents/`, `subagent-schedules/` — scheduler state
- `agent/mcp.json` — machine-local MCP servers

## Licensing

The forked extensions are MIT, © their upstream authors (Frad LEE,
[tintinweb](https://github.com/tintinweb/pi-subagents)); their license files sit
alongside the code. Everything else in this repository is configuration and
glue. No warranty — the permission gate and subagents are conveniences, not a
sandbox.

## Caveats

- The vendored forks **replace** the npm packages of the same name. Do not also
  install `npm:@tintinweb/pi-subagents` or `npm:@fradser/pi-recap`; pi keys
  packages by path, so both copies would load and duplicate their tools.
- `reviewer` restricts itself to read-only `git diff` / `git log` / `git show`.
  That is a prompt-level discipline, not enforcement — the permission gate is
  what actually enforces anything.
