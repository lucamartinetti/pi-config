# pi-config

Personal configuration for the [pi coding agent](https://pi.dev): settings,
model config, custom subagents, and installed extensions.

## Layout

```
agent/
  settings.json        # provider/model, theme, enabled models, installed packages
  models.json          # custom model definitions
  recap.json           # vendored pi-recap config (✦ Recap / ◐ Goal lines)
  supi/config.json     # @mrclrchtr/supi-prompt-suggestions config (ghost text)
  agents/              # custom subagents (planner, reviewer, scout, worker)
  prompts/             # prompt templates (empty)
  extensions/          # local extensions
    reload-runtime.ts  # /reload-runtime + reload_runtime tool
    pi-recap/          # vendored @fradser/pi-recap + pi-kit symlink
    pi-subagents/      # vendored @tintinweb/pi-subagents + croner/nanoid symlinks
  npm/                 # extension dependency manifest + lockfile
```

## Installed extensions

Declared in `agent/settings.json` (`packages`) and pinned in
`agent/npm/package-lock.json`:

| Package | Purpose |
|---|---|
| `@mrclrchtr/supi-prompt-suggestions` | Ghost-text next-prompt suggestions |
| `@mrclrchtr/supi-settings` | `/supi-settings` UI (required by the above) |

### Vendored extensions

Loaded automatically from `agent/extensions/`:

| Extension | Purpose |
|---|---|
| `pi-recap/` | Fork of `@fradser/pi-recap`: shows the `✦ Recap:` of the previous step when idle and swaps to an inferred `◐ Goal:`, a `💭 Thinking:` excerpt, and a `↳ Trail:` action sequence while a run is active (one goal inference at start, then at most one per 30s) |
| `pi-subagents/` | Fork of `@tintinweb/pi-subagents` (v0.22.0). Adds scheduled-job cancellation: a `manage_schedule` tool (`list`/`cancel`/`pause`/`resume`), a self-cancel marker (`[schedule-complete]`) injected into recurring fires, `maxRuns`/`cancelOn` auto-cancel, one-shots removed once settled, and `subagents:rpc:schedules:list`/`cancel` RPCs. See its `CHANGELOG.md` (Unreleased). |
| `reload-runtime.ts` | `/reload-runtime` + `reload_runtime` tool |

The vendored recap imports `@fradser/pi-kit` through
`agent/extensions/pi-recap/node_modules/@fradser/pi-kit`, a symlink to
`agent/npm/node_modules/@fradser/pi-kit`. `@fradser/pi-kit` is a direct
dependency in `agent/npm/package.json`, so `pi update --extensions` keeps it
installed.

The vendored `pi-subagents` imports `croner` and `nanoid` through
`agent/extensions/pi-subagents/node_modules/{croner,nanoid}`, symlinks to
`agent/npm/node_modules/`. Both are direct dependencies in
`agent/npm/package.json` (previously transitive via `@tintinweb/pi-subagents`),
so `pi update --extensions` keeps them installed. The host-provided
`@earendil-works/pi-*` and `typebox` packages are declared as peer dependencies
and resolved by pi, per the pi package contract — do not vendor them.

### Model notes

Recap and prompt suggestions use the main model
(`openrouter/deepseek/deepseek-v4.1-flash:nitro`).

`settings.json` sets `enabledModels` explicitly. This is required: the
prompt-suggestions extension resolves its model against Pi's *scoped*
`enabledModels`, which is empty unless set. The first entry pins startup to the
main model (scoped models can override startup selection); `*/*` keeps every
model available for cycling.

## Restore

```bash
git clone git@github.com:lucamartinetti/pi-config.git ~/.pi
cd ~/.pi
pi update --extensions   # installs the packages declared in settings.json (incl. @fradser/pi-kit)
```

Local extensions under `agent/extensions/` load without an install step; the
vendored `pi-recap` and `pi-subagents` only need their non-host dependencies
present via the symlinks described above.

Authentication (`agent/auth.json`) is intentionally not tracked — sign in again
with `pi auth` / provider env vars.

## Not included

- `agent/auth.json` — credentials
- `agent/sessions/` — private transcripts
- `agent/npm/node_modules/`, `agent/bin/`, `agent/models-store.json` — regenerable
