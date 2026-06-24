# aimux

[![npm version](https://img.shields.io/npm/v/@digital-threads/aimux?color=cb3837&logo=npm)](https://www.npmjs.com/package/@digital-threads/aimux)
[![npm downloads](https://img.shields.io/npm/dw/@digital-threads/aimux?color=cb3837&logo=npm)](https://www.npmjs.com/package/@digital-threads/aimux)
[![license](https://img.shields.io/npm/l/@digital-threads/aimux?color=blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@digital-threads/aimux?color=339933&logo=node.js)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/Digital-Threads/aimux?style=social)](https://github.com/Digital-Threads/aimux)

Local AI workspace orchestrator — manage multiple AI CLI subscriptions with shared knowledge and isolated authentication.

## Problem

You have multiple Claude Code subscriptions (personal, work, client) each in separate `~/.claude-*` directories. You maintain symlinks manually, duplicate settings, and juggle bash functions to switch between them.

## Solution

**aimux** treats your AI CLI configs like tmux treats terminals: one shared brain, multiple isolated sessions.

- **Shared layer**: agents, skills, commands, rules, memory, plugins, settings — symlinked from a single source of truth
- **Private layer**: credentials, rate limits, session state — isolated per profile
- **Zero duplication**: add a skill once, available everywhere

## Install

```bash
npm install -g @digital-threads/aimux
```

## Getting Started

### You have `~/.claude` + extra directories (`~/.claude-work`, etc.)

```bash
npm install -g aimux
aimux init              # auto-detects all ~/.claude* dirs
aimux status            # verify profiles, auth, symlinks
aimux run w             # launch work profile (prefix matching)
```

### You have only `~/.claude` (one subscription)

```bash
npm install -g aimux
aimux init              # creates config with main profile
aimux profile add work  # add a new profile
aimux auth login work   # OAuth for the new account
aimux profile update w -m claude-opus-4-6
aimux run w
```

### You want to connect a 3rd-party / self-hosted API endpoint

```bash
aimux profile add myapi --api
# Configure API endpoint (leave blank to use default):
#   Base URL:                          https://api.your-provider.com/v1
#   Auth token:                        [hidden]
#   Default model [claude-sonnet-4-6]:
#   Opus model    [claude-opus-4-6]:
#   Sonnet model  [claude-sonnet-4-6]:
#   Haiku model   [claude-haiku-4-5]:
# ✓ Credentials saved to ~/.aimux/profiles/myapi/.env (chmod 600)
aimux run myapi
```

See [Per-profile environment variables](#per-profile-environment-variables) for the declarative alternative (`.env` file / `env:` block) used by power users and CI.

### Fresh machine (nothing installed)

```bash
# Install Claude CLI first, then:
claude auth login       # creates ~/.claude
npm install -g @digital-threads/aimux
aimux init
aimux profile add work
aimux auth login work
```

### Day-to-day usage

```bash
aimux run               # interactive picker (↑↓ + Enter)
aimux run w             # prefix match → work
aimux run o -m claude-sonnet-4-6  # one-time model override
aimux run w --resume    # flags pass through to Claude CLI
aimux status            # dashboard
aimux usage             # token usage by profile for the last 7 days
aimux usage --all       # all known transcript usage

# Set default model per profile (quote model names with special chars)
aimux profile update w -m claude-opus-4-6
aimux profile update o -m "claude-opus-4-6[1m]"

# Set a fallback model, tried automatically when the primary is overloaded/unavailable
aimux profile update w --fallback-model claude-sonnet-4-6
aimux profile update w --unset-fallback-model   # remove it
```

### Switch your shell to a profile (`aimux use`)

`aimux run` launches a one-off session. If you'd rather *activate* a profile so
plain `claude` / `codex` use it — like `nvm use` or `pyenv shell` — enable the
shell integration once:

```bash
# add to ~/.zshrc or ~/.bashrc (fish: ~/.config/fish/config.fish)
eval "$(aimux shell-init)"
```

Then:

```bash
aimux use work     # activate 'work' in this shell (persistent until you switch)
claude             # runs under 'work' — no `aimux run` needed
codex              # same; the CLI adapter sets CODEX_HOME for you
aimux use api      # switch profiles — stale ANTHROPIC_*/tokens are cleaned up
aimux use          # no name → interactive picker
```

Each shell is independent, so different terminals can hold different active
profiles at once. The switch only exports env vars into the current shell — it
never changes global state. `aimux run` still works for one-off launches.

## Commands

| Command | Description |
|---------|-------------|
| `aimux init` | Auto-detect Claude dirs, create config, migrate profiles |
| `aimux init --source <path>` | Initialize with explicit source directory |
| `aimux status` | TUI dashboard — profiles, auth, auto-mode posture, symlink health |
| `aimux usage` | Show token usage by profile from Claude transcript metadata |
| `aimux usage --profile work --since 24h` | Show usage for one profile over a recent window |
| `aimux run [profile]` | Launch AI CLI with correct env and model |
| `aimux run` | Interactive picker — history pre-selects last used profile |
| `aimux run w` | Prefix matching — launches `work` if unambiguous |
| `aimux run work -m claude-sonnet-4-6` | Launch with model override |
| `aimux use [profile]` | Switch the current shell to a profile (persistent) — plain `claude`/`codex` then use it. Requires `eval "$(aimux shell-init)"` in your rc |
| `aimux shell-init` | Print the shell function that enables `aimux use` (add to `~/.zshrc`/`~/.bashrc`/fish config) |
| `aimux agents` | Multi-profile agent view — see and manage claude background sessions across **all** profiles in one TUI |
| `aimux profile add <name>` | Create new profile with symlinks |
| `aimux profile add <name> --api` | Create a 3rd-party API profile (interactive endpoint + token prompt) |
| `aimux profile add <name> --cli codex` | Create a profile for another AI CLI (e.g. Codex) |
| `aimux handoff <sessionId> --to <profile>` | Continue a session under another profile/CLI via summary handoff |
| `aimux profile update <name>` | Update model/cli settings |
| `aimux profile update <name> --fallback-model <model>` | Set a fallback model, used when the primary is overloaded/unavailable |
| `aimux profile update <name> --unset-fallback-model` | Remove the fallback model |
| `aimux profile update <name> -e KEY=VALUE` | Set an env var in the profile `.env` file |
| `aimux profile update <name> --unset-env KEY` | Remove an env var from the profile `.env` file |
| `aimux profile list` | List all profiles |
| `aimux profile remove <name>` | Remove profile and clean up |
| `aimux profile clone <src> <name>` | Clone profile with private files |
| `aimux rebuild [profile]` | Sync symlinks and surface local shared-file conflicts |
| `aimux doctor` | Health check — broken symlinks, missing shared entries, conflicts |
| `aimux auth login <profile>` | Launch OAuth flow for a profile |
| `aimux auth status` | Show auth file status per profile |
| `aimux setup-shell` | Auto-install shell completions (bash/zsh/fish) |
| `aimux migrate isolate` | One-time migration: convert per-profile `jobs/`, `daemon/`, `projects/` symlinks into real private dirs so each profile gets its own supervisor and sessions. Safe — no data is deleted. Add `--dry-run` to preview. |

All profile commands support **prefix matching**: `aimux run w` → `work`, `aimux profile update o` → `own`.

## How It Works

```
~/.claude/          ← source of truth (your main profile)
  agents/
  skills/
  commands/
  memory/
  settings.json
  .credentials.json  ← private, stays here

~/.aimux/
  config.yaml        ← aimux config
  profiles/
    work/
      agents/ → ~/.claude/agents      ← symlink (shared)
      skills/ → ~/.claude/skills      ← symlink (shared)
      memory/ → ~/.claude/memory      ← symlink (shared)
      plugins/                        ← real dir (shared content, per-profile metadata)
        marketplaces/ → ~/.claude/plugins/marketplaces   ← symlink (shared)
        cache/        → ~/.claude/plugins/cache           ← symlink (shared)
        known_marketplaces.json       ← real file (paths point inside this profile)
        installed_plugins.json        ← real file (paths point inside this profile)
      .credentials.json               ← real file (private)
      .claude.json                    ← real file (private)
    own/
      ...same pattern...
```

When you run `aimux run work`, it sets `CLAUDE_CONFIG_DIR=~/.aimux/profiles/work` and launches the CLI. Claude sees a complete config directory — shared content via symlinks, private auth locally.

**Plugins** are shared too, but Claude validates that a marketplace's `installLocation`
lives inside the active config directory. So each profile gets a real `plugins/`
directory: the heavy content (`marketplaces/`, `cache/`) is symlinked to the shared
`~/.claude/plugins`, while `known_marketplaces.json` and `installed_plugins.json` are
real, path-rewritten copies. `~/.claude` stays the source of truth — install or update
plugins from your main profile (or with `CLAUDE_CONFIG_DIR=~/.claude claude plugin …`)
and every profile picks them up on its next run. A plugin installed from inside a
profile is merged back into the shared source automatically.

## Multiple AI CLIs (Codex)

aimux isn't claude-only. A profile's `cli` field selects which AI CLI it runs, so you
can keep claude **and** Codex subscriptions side by side — same shared brain, isolated
auth — and even hand a live conversation from one to the other when a limit hits.

```bash
aimux profile add codework --cli codex   # a Codex profile
aimux auth login codework                # runs `codex login` under an isolated CODEX_HOME
aimux run codework                        # launches Codex with the right model flag
aimux agents                              # claude + codex sessions in one view (CLI-badged)
```

- **Isolation per CLI.** Each CLI gets its own config-dir env (`CLAUDE_CONFIG_DIR` /
  `CODEX_HOME`), so subscriptions never collide.
- **Per-CLI source-of-truth.** `shared_sources` maps each CLI to its source
  (`claude → ~/.claude`, `codex → ~/.codex`); the legacy `shared_source` stays as the
  claude alias.
- **Per-CLI sharing.** claude shares everything except `private`; Codex shares a
  knowledge allowlist (`skills`, `rules`, `memories`) and keeps `auth.json` /
  `config.toml` / `sessions/` private. (Codex plugin sharing is a planned follow-up.)
- **claude is untouched.** Multi-CLI is strictly opt-in — without a non-claude profile
  nothing changes.

### Cross-CLI handoff (limit failover)

Hit a subscription limit mid-session? Continue it under another CLI:

```bash
aimux handoff <sessionId> --to codework
```

The two CLIs' transcripts are mutually unreadable, so this is a **summary handoff**, not
a native resume: aimux reads the source transcript, summarizes it with the target
profile (self-contained — the target CLI does the summarizing), then launches the target
seeded with that summary. Same-CLI continuation (claude↔claude, codex↔codex) still uses
native resume (`aimux run <profile> --resume <id>`). Note: the *conversation context*
carries over, not the model — the target continues with its own model.

### Other models via a provider preset

Many providers expose an **Anthropic-compatible** endpoint, so they run on the claude CLI
itself — just a different base URL + token. A provider profile is therefore a **claude
profile**: it shares the full claude brain (skills, plugins, settings, memory, transcripts)
and you can even `--resume` a claude session under it natively (same CLI, same model swap).

One command, prompts only for the token:

```bash
aimux profile add ds --provider deepseek   # fills base URL + model mapping
aimux run ds
```

Built-in presets: **deepseek, kimi, glm, qwen, minimax, mimo**. Base URLs are verified;
model names drift — update with `aimux profile update <name> -e ANTHROPIC_MODEL=…`.

For anything else (local models via Ollama/LM Studio, a proxy, Bedrock/Vertex), use the
generic `aimux profile add <name> --api` and point `ANTHROPIC_BASE_URL` at it (see below).
Costs shown by `aimux usage` are estimated against claude pricing and will be off for
non-claude models.

## Per-profile environment variables

Some Claude Code modes (3rd-party proxies, self-hosted gateways, Bedrock, Vertex) are activated by environment variables rather than OAuth. aimux injects per-profile env into the spawned `claude` process (and into `aimux auth login <profile>`) from two sources, merged in this order:

1. **`<profile>/.env`** — a dotenv file inside the profile directory. Best for secrets. Written with `chmod 600` when aimux creates it; `aimux run` warns if it becomes group/other-readable.
2. **`env:` block under the profile in `config.yaml`** — best for non-secret toggles you want versioned. **Overrides `.env`** on key conflict.

The fastest way to set up an API profile is the interactive prompt:

```bash
aimux profile add myapi --api      # prompts for Base URL, hidden token, models
aimux profile update myapi -e ANTHROPIC_MODEL=claude-opus-4-6   # edit later
```

…which writes something like:

```bash
# ~/.aimux/profiles/myapi/.env — do not commit
ANTHROPIC_BASE_URL=https://api.your-provider.com/v1
ANTHROPIC_AUTH_TOKEN=sk-your-token...
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5
```

The `.env` parser supports `KEY=value`, `export KEY=value`, comments, and single/double-quoted values (with `\n`/`\t` escapes inside double quotes). It does **not** do `${VAR}` interpolation or multi-line values — it's a secrets loader, not a full `dotenv-expand`. `.env` is always private (never symlinked to the shared source).

## Config

```yaml
# ~/.aimux/config.yaml
version: 1
shared_source: /home/user/.claude

profiles:
  main:
    cli: claude
    path: /home/user/.claude
    is_source: true
  work:
    cli: claude
    model: claude-opus-4-6
    path: /home/user/.aimux/profiles/work
  myapi:
    cli: claude
    model: claude-sonnet-4-6
    path: /home/user/.aimux/profiles/myapi   # secrets live in this dir's .env
    # Optional non-secret env injected into the spawned CLI (overrides .env).
    # env:
    #   ANTHROPIC_DEFAULT_OPUS_MODEL: claude-opus-4-6

private:
  - .credentials.json
  - .env                  # API credentials — never symlinked, never committed
  - .claude.json
  - policy-limits.json
  - mcp-needs-auth-cache.json
  - remote-settings.json
  - settings.local.json
  - stats-cache.json
  - statsig
  - telemetry
```

## Requirements

- Node.js 22+
- Claude Code CLI installed

## License

MIT
