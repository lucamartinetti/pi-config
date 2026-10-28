# pi-config

Personal configuration for the [pi coding agent](https://pi.dev): settings, model
definitions, subagents, and every third-party pi package it uses, vendored from
pinned npm tarballs with local changes kept as patches.

This is a working setup, not a framework. Clone it to get the same behaviour, or
read it for the forks and the wiring.

## What's in it

| Piece | What it provides |
|---|---|
| `agent/settings.json` | Provider/model defaults, theme, enabled models, the vendored packages to load |
| `agent/models.json` | Custom model definitions and per-model provider routing |
| `agent/agents/` | Four subagents: `planner`, `reviewer`, `scout`, `worker` |
| `agent/extensions/reload-runtime.ts` | `/reload-runtime` command + `reload_runtime` tool |
| `agent/vendor/` | Every third-party pi package, pinned, verified, and patched where needed |
| `agent/config/`, `agent/supi/`, `agent/recap.json` | Config for the permission gate, prompt suggestions, and recap |
| `scripts/deps.mjs` | Installs, verifies, re-vendors, and patches `agent/vendor/` |

Vendored packages:

| Package | Version | Local patches | Purpose |
|---|---|---|---|
| `@fradser/pi-recap` | 0.1.11 | 5 | `◐ Goal:` / `↳ Activity:` lines while a run is active, `✦ Recap:` when idle |
| `@tintinweb/pi-subagents` | 0.22.0 | 1 | Subagents, plus cancellation for scheduled jobs |
| `@mrclrchtr/supi-prompt-suggestions` | 11.0.1 | — | Ghost-text next-prompt suggestions |
| `@mrclrchtr/supi-settings` | 11.0.1 | — | `/supi-settings` UI (required by the above) |
| `pi-verdict` | 0.15.0 | — | Classifier-backed tool permission gate |
| `pi-web-access` | 0.45.0 | — | Web search and fetch |

`node scripts/deps.mjs status` prints the current table.

## Requirements

- pi 1.4.0 or newer (`pi --version`)
- Node.js 22 or newer, npm, and git
- Provider access, e.g. an OpenRouter key via `pi auth` or environment variables

## Install

```bash
git clone git@github.com:lucamartinetti/pi-config.git ~/.pi
cd ~/.pi
node scripts/deps.mjs install   # npm ci + signature audit for the vendored packages
pi auth                         # credentials are not tracked
```

Clone somewhere other than `~/.pi` if you prefer: point pi at the directory with
`PI_CODING_AGENT_DIR=/path/to/pi-config/agent`.

Do not use `pi install` or `pi update --extensions` for packages here. They
install unpinned specs as `@latest` into `agent/npm/`, outside the pins.
`deps check` fails if `settings.json` lists an `npm:` or `git:` source.

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
4. **Optionally turn on the pre-commit hook:** `git config core.hooksPath .githooks`.
   It runs `deps check` whenever `agent/vendor/` or `settings.json` is staged.

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
  vendor/
    package.json       # exact upstream pins (Dependabot edits this)
    package-lock.json  # resolved tree with sha512 integrity
    .npmrc             # ignore-scripts, save-exact, no peer installs
    vendored.json      # upstream version each committed tree was built from
    patches/<pkg>/     # local changes, as a git format-patch series
    <pkg>/             # committed tree = upstream tarball + patches
    node_modules/      # dependencies, from `deps install` (gitignored)
scripts/deps.mjs       # the tooling below
.githooks/pre-commit   # optional deps check before commit
.github/               # Dependabot, CI, and the Dependabot sync workflow
```

`settings.json` loads each package as a local path (`./vendor/<pkg>`), so pi
never installs anything itself. Their dependencies come from
`agent/vendor/node_modules/`; where npm nested a dependency under a package,
`deps install` links `agent/vendor/<pkg>/node_modules` to that nested directory
so resolution matches what npm laid out. The host packages
(`@earendil-works/pi-*`, `typebox`) are peers supplied by pi and are never
installed.

## Dependencies

### How they are trusted

- Each committed tree is rebuilt from the npm tarball named in the lockfile, and
  the tarball's sha512 is checked against the lockfile before it is unpacked.
- `deps check` rebuilds every tree from tarball + patches and fails on any
  difference, so the committed code is exactly upstream plus the visible
  patches.
- Dependencies install with `npm ci`: exactly the lockfile, integrity-checked.
- `agent/vendor/.npmrc` sets `ignore-scripts=true`; no dependency lifecycle
  script runs, including in Dependabot's and CI's installs.
- `deps install` runs `npm audit signatures` against the registry's signing keys.
- `settings.json` may not reference `npm:`, `git:`, or URL sources.

### How updates arrive

1. Dependabot checks `agent/vendor/` weekly and opens a PR once a release is at
   least 7 days old (minor and patch bumps grouped, majors separate). It only
   changes `package.json` and the lockfile.
2. `.github/workflows/dependabot-sync.yml` runs `deps sync` on that PR: it
   re-vendors each bumped package and replays its patches onto the new version
   with `git rebase`, then pushes the regenerated tree to the Dependabot branch
   and dispatches CI on it.
3. CI (`.github/workflows/ci.yml`) runs `deps install`, `deps check`, and
   gitleaks. Review the diff of the vendored code, then merge.

If the patches conflict, the sync job fails and its summary shows the conflict.
Resolve it locally (see below). Once a commit other than Dependabot's is on its
branch, Dependabot stops rebasing that PR; comment `@dependabot recreate` to
start it over.

Dependabot also keeps the GitHub Actions current; they are pinned by commit SHA.

### Changing a vendored package

Edit files in `agent/vendor/<pkg>/` directly, then record the change:

```bash
node scripts/deps.mjs patch @tintinweb/pi-subagents "Short description of the change"
```

That appends one patch to `agent/vendor/patches/<pkg>/`. Commit the patch and
the edited tree together. To drop a patch, delete its file and run
`node scripts/deps.mjs sync <pkg> --force`.

### Updating by hand or resolving a conflict

```bash
cd agent/vendor && npm install <pkg>@<version> && cd ../..
node scripts/deps.mjs sync          # re-vendor and rebase patches
```

On a conflict, `sync` leaves a temporary git repo with the rebase stopped and
prints its path. Resolve there with plain git (`git status`, edit, `git add`,
`git rebase --continue`), then:

```bash
node scripts/deps.mjs resume /tmp/pi-deps-repo-XXXXXX
node scripts/deps.mjs check
```

### Commands

| Command | Does |
|---|---|
| `deps install` | `npm ci` + `npm audit signatures`, then link nested `node_modules` |
| `deps sync [pkg] [--force]` | Re-vendor packages whose pin changed, rebasing their patches |
| `deps resume <repo>` | Finish a `sync` after resolving conflicts in `<repo>` |
| `deps patch <pkg> "<msg>"` | Record edits in `agent/vendor/<pkg>/` as a new patch |
| `deps check` | Verify pins, `settings.json`, and every vendored tree |
| `deps status` | List pins, vendored versions, and patch counts |

All are `node scripts/deps.mjs <command>`.

## The forks

Both are MIT-licensed upstream code. The patches carry the commit messages that
explain each change.

- **`pi-recap`** — infers a `◐ Goal:` and a `↳ Activity:` line from recent tool
  activity (two model calls when a run starts, then at most one pair every 30s),
  shows a `💭 Thinking:` excerpt, hides the previous `✦ Recap:` while a run is
  active, and raises the recap length limit from 120 to 200 characters. The
  upstream tool-trail line is gone.
- **`pi-subagents`** — adds `manage_schedule` (`list` / `cancel` / `pause` /
  `resume`), a `[schedule-complete]` marker that lets a recurring agent cancel
  itself, `maxRuns` / `cancelOn` auto-cancel, removal of settled one-shots, and
  `subagents:rpc:schedules:list` / `cancel` RPCs. See its `CHANGELOG.md`.

Neither fork is published.

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
dependencies, and runtime state are gitignored:

- `agent/auth.json` — credentials
- `agent/sessions/` — transcripts
- `agent/vendor/node_modules/`, `agent/bin/`, `agent/models-store.json` — installable
- `agent/npm/`, `agent/git/` — pi's own package roots, unused here
- `agent/pi-subagents/`, `agent/pi-web-access/`, `subagent-schedules/` — runtime state
- `agent/mcp.json` — machine-local MCP servers

## Licensing

Vendored packages are MIT, © their upstream authors; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Everything else in this
repository is configuration and glue. No warranty — the permission gate and
subagents are conveniences, not a sandbox.

## Caveats

- The vendored forks **replace** the npm packages of the same name. Do not also
  install `npm:@tintinweb/pi-subagents` or `npm:@fradser/pi-recap`; both copies
  would load and duplicate their tools.
- `reviewer` restricts itself to read-only `git diff` / `git log` / `git show`.
  That is a prompt-level discipline, not enforcement — the permission gate is
  what actually enforces anything.
