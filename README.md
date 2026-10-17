# pi-config

Personal configuration for the [pi coding agent](https://pi.dev): settings,
model config, custom subagents, and installed extensions.

## Layout

```
agent/
  settings.json        # provider/model, theme, enabled models, installed packages
  models.json          # custom model definitions
  recap.json           # @fradser/pi-recap config (✦ Recap line)
  supi/config.json     # @mrclrchtr/supi-prompt-suggestions config (ghost text)
  agents/              # custom subagents (planner, reviewer, scout, worker)
  prompts/             # prompt templates (empty)
  extensions/          # local extensions
    reload-runtime.ts  # /reload-runtime + reload_runtime tool
  npm/                 # extension dependency manifest + lockfile
```

## Installed extensions

Declared in `agent/settings.json` (`packages`) and pinned in
`agent/npm/package-lock.json`:

| Package | Purpose |
|---|---|
| `@tintinweb/pi-subagents` | Delegate tasks to subagents |
| `@fradser/pi-recap` | `✦ Recap:` summary line after each turn |
| `@mrclrchtr/supi-prompt-suggestions` | Ghost-text next-prompt suggestions |
| `@mrclrchtr/supi-settings` | `/supi-settings` UI (required by the above) |

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
pi update --extensions   # installs the packages declared in settings.json
```

Authentication (`agent/auth.json`) is intentionally not tracked — sign in again
with `pi auth` / provider env vars.

## Not included

- `agent/auth.json` — credentials
- `agent/sessions/` — private transcripts
- `agent/npm/node_modules/`, `agent/bin/`, `agent/models-store.json` — regenerable
