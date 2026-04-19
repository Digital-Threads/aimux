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
npm install -g aimux
```

## Quick Start

```bash
# Auto-detect existing Claude directories and set up
aimux init

# See what you've got
aimux status

# Set models per profile
aimux profile update work --model claude-opus-4-6
aimux profile update own --model claude-opus-4-6

# Launch a profile
aimux run work

# Launch with model override
aimux run own --model claude-sonnet-4-6
```

## Commands

| Command | Description |
|---------|-------------|
| `aimux init` | Auto-detect Claude dirs, create config, migrate profiles |
| `aimux init --source <path>` | Initialize with explicit source directory |
| `aimux status` | TUI dashboard — profiles, auth, symlink health |
| `aimux run [profile]` | Launch AI CLI with correct env and model |
| `aimux run` | Smart picker — uses history hint or shows available profiles |
| `aimux profile add <name>` | Create new profile with symlinks |
| `aimux profile update <name>` | Update model/cli settings |
| `aimux profile list` | List all profiles |
| `aimux profile remove <name>` | Remove profile and clean up |
| `aimux rebuild [profile]` | Sync symlinks (after source changes) |
| `aimux doctor` | Health check — broken symlinks, missing files |
| `aimux auth login <profile>` | Launch OAuth flow for a profile |
| `aimux auth status` | Show auth file status per profile |

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

- Node.js 18+
- Claude Code CLI installed

## License

MIT
