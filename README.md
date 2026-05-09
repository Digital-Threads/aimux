# aimux

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

# Set default model per profile (quote model names with special chars)
aimux profile update w -m claude-opus-4-6
aimux profile update o -m "claude-opus-4-6[1m]"
```

## Commands

| Command | Description |
|---------|-------------|
| `aimux init` | Auto-detect Claude dirs, create config, migrate profiles |
| `aimux init --source <path>` | Initialize with explicit source directory |
| `aimux status` | TUI dashboard — profiles, auth, symlink health |
| `aimux run [profile]` | Launch AI CLI with correct env and model |
| `aimux run` | Interactive picker — history pre-selects last used profile |
| `aimux run w` | Prefix matching — launches `work` if unambiguous |
| `aimux run work -m claude-sonnet-4-6` | Launch with model override |
| `aimux profile add <name>` | Create new profile with symlinks |
| `aimux profile update <name>` | Update model/cli settings |
| `aimux profile list` | List all profiles |
| `aimux profile remove <name>` | Remove profile and clean up |
| `aimux profile clone <src> <name>` | Clone profile with private files |
| `aimux rebuild [profile]` | Sync symlinks and surface local shared-file conflicts |
| `aimux doctor` | Health check — broken symlinks, missing shared entries, conflicts |
| `aimux auth login <profile>` | Launch OAuth flow for a profile |
| `aimux auth status` | Show auth file status per profile |
| `aimux setup-shell` | Auto-install shell completions (bash/zsh/fish) |

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
      .credentials.json               ← real file (private)
      .claude.json                    ← real file (private)
    own/
      ...same pattern...
```

When you run `aimux run work`, it sets `CLAUDE_CONFIG_DIR=~/.aimux/profiles/work` and launches the CLI. Claude sees a complete config directory — shared content via symlinks, private auth locally.

## Per-profile environment variables

Some Claude Code modes (Microsoft Foundry, Bedrock, Vertex, custom proxies) are activated by environment variables, not by JSON config. aimux gives each profile two ways to inject env vars into the spawned `claude` process:

1. **`<profile>/.env`** — dotenv file inside the profile directory. Best for secrets; supports `KEY=value`, `export KEY=value`, comments, and quoted values. `chmod 600` it.
2. **`env:` block under the profile in `config.yaml`** — best for non-secret toggles you want versioned alongside the rest of the profile config. Overrides `.env` on key conflict.

Both are merged together and passed to `claude` along with `CLAUDE_CONFIG_DIR`. The same env is also applied to `aimux auth login <profile>`.

### Microsoft Foundry recipe

```yaml
# ~/.aimux/config.yaml
profiles:
  foundry:
    cli: claude
    path: ~/.aimux/profiles/foundry
    model: claude-opus-4-7
    env:
      CLAUDE_CODE_USE_FOUNDRY: "1"
      ANTHROPIC_FOUNDRY_RESOURCE: <your-foundry-resource>
      ANTHROPIC_DEFAULT_OPUS_MODEL: claude-opus-4-7
      ANTHROPIC_DEFAULT_SONNET_MODEL: claude-sonnet-4-6
      ANTHROPIC_DEFAULT_HAIKU_MODEL: claude-haiku-4-5
```

```bash
# ~/.aimux/profiles/foundry/.env
ANTHROPIC_FOUNDRY_API_KEY=<your-azure-foundry-key>
```

```bash
chmod 600 ~/.aimux/profiles/foundry/.env
aimux run foundry
```

> Note: putting Foundry settings inside `.claude.json` is not enough — Claude Code activates Foundry mode from environment variables on startup. Fields like `useFoundry` / `foundryResource` in `.claude.json` are state Claude Code *writes* after the env-driven activation, not the activation switch itself.

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
  own:
    cli: claude
    model: claude-opus-4-6
    path: /home/user/.aimux/profiles/own
    # Optional per-profile env injected into the spawned CLI.
    # env:
    #   CLAUDE_CODE_USE_FOUNDRY: "1"
    #   ANTHROPIC_FOUNDRY_RESOURCE: my-resource

private:
  - .credentials.json
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
