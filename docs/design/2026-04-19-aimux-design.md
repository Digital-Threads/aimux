# aimux — Local AI Workspace Orchestrator

## Design Spec v0.1

**Date:** 2026-04-19
**Status:** Approved (brainstorming complete)

---

## 1. Product Vision

**aimux** — локальный CLI-оркестратор для параллельной работы с несколькими AI CLI подписками.

### Ключевая идея
Один мозг (shared knowledge), много подписок (isolated auth). Пользователь запускает любой профиль в любом проекте, в любой момент, в любом количестве терминалов одновременно.

### Что aimux делает
- Управляет профилями (подписками) AI CLI
- Собирает runtime-директории из shared + private слоёв через симлинки
- Запускает CLI с правильным окружением
- Даёт интерактивный TUI для управления

### Что aimux НЕ делает
- Не привязывает проекты к профилям жёстко
- Не подменяет Claude CLI — работает поверх него
- Не трогает механику авторизации — только направляет в нужную директорию

### Целевые платформы
- **MVP:** Linux/WSL
- **v2+:** macOS, Windows

---

## 2. Architecture

### 2.1 Stack
- **Core:** TypeScript
- **TUI:** Ink (React for terminal)
- **Distribution:** npm (`npx aimux` + `npm i -g aimux`)
- **Config:** YAML (`~/.aimux/config.yaml`)

### 2.2 Directory Structure

```
~/.claude/                        ← НЕ ТРОГАЕМ. Shared source of truth.
                                     Claude CLI без aimux работает как раньше.
                                     "main" профиль = ~/.claude напрямую.

~/.aimux/
  config.yaml                     ← конфигурация aimux
  profiles/
    work/                         ← symlinks на ~/.claude/* + private файлы
      .credentials.json           ← PRIVATE: токены подписки
      .claude.json                ← PRIVATE: состояние сессии
      policy-limits.json          ← PRIVATE: лимиты подписки
      mcp-needs-auth-cache.json   ← PRIVATE: MCP auth per-account
      remote-settings.json        ← PRIVATE: серверные настройки
      settings.local.json         ← PRIVATE: per-profile overrides
      stats-cache.json            ← PRIVATE: статистика per-account
      statsig/                    ← PRIVATE: feature flags per-account
      telemetry/                  ← PRIVATE: telemetry per-account
      agents → ~/.claude/agents          ← SHARED symlink
      skills → ~/.claude/skills          ← SHARED symlink
      commands → ~/.claude/commands      ← SHARED symlink
      rules → ~/.claude/rules           ← SHARED symlink
      plugins → ~/.claude/plugins        ← SHARED symlink
      memory → ~/.claude/memory          ← SHARED symlink
      ...                                ← все остальные — SHARED
    own/
      (аналогичная структура)
```

### 2.3 Launch Mechanism

```
aimux run work
  → reads ~/.aimux/config.yaml → profile "work"
  → verifies ~/.aimux/profiles/work/ exists and has valid symlinks
  → executes: CLAUDE_CONFIG_DIR=~/.aimux/profiles/work claude --model claude-opus-4-6
```

Для "main" профиля:
```
aimux run main
  → executes: CLAUDE_CONFIG_DIR=~/.claude claude --model claude-opus-4-7
```

### 2.4 Shared vs Private Classification

#### SHARED (symlink to ~/.claude):
| Element | Reason |
|---------|--------|
| `agents/` | Common agents |
| `skills/` | Common skills (~1393) |
| `commands/` | Common commands |
| `rules/` | Common rules |
| `plugins/` | MCP plugins |
| `memory/` | Shared memory |
| `agent-memory/` | Shared agent memory |
| `CLAUDE.md` | Global config |
| `settings.json` | Shared settings |
| `cache/` | Plugin cache |
| `context-mode/` | context-mode DB |
| `downloads/` | Shared downloads |
| `transcripts/` | Shared history |
| `worktrees/` | Shared worktrees |
| `backups/` | Shared backups |
| `todos/` | Shared todos |
| `tasks/` | Shared tasks |
| `plans/` | Shared plans |
| `sessions/` | Shared sessions |
| `session-env/` | Shared session env |
| `projects/` | Shared project configs |
| `history.jsonl` | Shared command history |
| `file-history/` | Shared file history |
| `paste-cache/` | Shared paste cache |
| `shell-snapshots/` | Shared snapshots |
| `debug/` | Shared debug logs |

#### PRIVATE (local per-profile):
| Element | Reason |
|---------|--------|
| `.credentials.json` | OAuth tokens per subscription |
| `.claude.json` | Session/account state |
| `policy-limits.json` | Rate limits per subscription |
| `mcp-needs-auth-cache.json` | MCP auth per account |
| `remote-settings.json` | Server settings per account |
| `settings.local.json` | Per-profile overrides |
| `stats-cache.json` | Statistics per account |
| `statsig/` | Feature flags per account |
| `telemetry/` | Telemetry per account |

---

## 3. Config Format

```yaml
# ~/.aimux/config.yaml

version: 1

shared_source: ~/.claude

profiles:
  main:
    cli: claude
    model: claude-opus-4-7
    path: ~/.claude              # main uses source directly
    is_source: true              # marks this as the shared source
    
  work:
    cli: claude
    model: claude-opus-4-6
    path: ~/.aimux/profiles/work
    
  own:
    cli: claude
    model: claude-opus-4-6
    path: ~/.aimux/profiles/own

# Private elements (not symlinked, kept per-profile)
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

---

## 4. Commands (MVP — v0.1)

### 4.1 `aimux init`
Interactive migration wizard:
1. Scans for existing Claude directories (`~/.claude`, `~/.claude-*`)
2. Detects source of truth (real files vs symlinks)
3. Creates `~/.aimux/` structure
4. Migrates private files from existing dirs to `~/.aimux/profiles/`
5. Creates symlinks to shared source
6. Generates `config.yaml`
7. Optionally removes old directories (asks user)

### 4.2 `aimux profile add <name>`
1. Creates `~/.aimux/profiles/<name>/`
2. Creates symlinks to shared source for all shared elements
3. Optionally triggers auth (`--no-auth` to skip)
4. Updates `config.yaml`

### 4.3 `aimux profile list`
Shows all profiles with status:
```
┌─ aimux profiles ─────────────────────────────┐
│  NAME    AUTH          MODEL         SOURCE   │
│  main    ✓ active      opus-4-7     (source) │
│  work    ✓ active      opus-4-6              │
│  own     ✓ active      opus-4-6              │
│  new     ✗ no auth     opus-4-6              │
└──────────────────────────────────────────────┘
```

### 4.4 `aimux profile remove <name>`
1. Confirms with user
2. Removes `~/.aimux/profiles/<name>/`
3. Updates `config.yaml`
4. Cannot remove source profile

### 4.5 `aimux run [profile]`
- With profile: launches Claude with correct CLAUDE_CONFIG_DIR + model
- Without profile: shows history hint + interactive picker
- `--model <model>` overrides default model
- Logs which profile was used in which directory (for history hints)

### 4.6 `aimux rebuild [profile|--all]`
1. Scans shared source for all elements
2. For each profile: ensures all shared elements have symlinks
3. Creates missing symlinks (new files added by Claude CLI)
4. Reports what was added/fixed

### 4.7 `aimux status`
Overview dashboard:
```
┌─ aimux status ───────────────────────────────┐
│                                              │
│  Shared source: ~/.claude                    │
│  Profiles: 3 (3 authenticated)              │
│  Shared elements: 26                         │
│  Private elements: 9                         │
│                                              │
│  PROFILES:                                   │
│  main   ✓ auth   opus-4-7   (source)        │
│  work   ✓ auth   opus-4-6   26/26 symlinks  │
│  own    ✓ auth   opus-4-6   26/26 symlinks  │
│                                              │
│  Last rebuild: 2 hours ago                   │
│  Pending syncs: 0                            │
│                                              │
└──────────────────────────────────────────────┘
```

### 4.8 `aimux auth login <profile>`
Launches Claude CLI auth flow for specific profile.

### 4.9 `aimux auth status`
Detailed auth info per profile (token validity, expiration, etc.)

### 4.10 `aimux doctor`
Health check:
- Broken symlinks
- Missing credentials
- Shared/private conflicts
- Orphaned profiles
- Config inconsistencies

---

## 5. UX: `aimux run` Without Profile

1. Check history: was a profile used in this directory before?
   - Yes → "Last used 'work' here. Use 'work'? [Y/n/other]"
   - No → show interactive picker
2. Interactive picker: list all profiles with status
3. Selection saved to history for future hints

History stored in `~/.aimux/history.yaml`:
```yaml
- dir: ~/www/startups/telegram-microlearning
  profile: work
  timestamp: 2026-04-19T14:30:00Z
- dir: ~/www/playerok/pl-api
  profile: main
  timestamp: 2026-04-19T15:00:00Z
```

---

## 6. Migration Flow (init)

### Current state:
```
~/.claude          → source of truth (all real data)
~/.claude-work     → 30+ symlinks to ~/.claude + 5 private files
~/.claude-own      → 30+ symlinks to ~/.claude + 6 private files
```

### After `aimux init`:
```
~/.claude          → untouched (shared source)
~/.aimux/
  config.yaml
  history.yaml
  profiles/
    work/          ← private files migrated from ~/.claude-work
    own/           ← private files migrated from ~/.claude-own
~/.claude-work     → removed (or kept as compat symlink, user choice)
~/.claude-own      → removed (or kept as compat symlink, user choice)
```

### bashrc cleanup:
`aimux init` offers to replace bash functions with:
```bash
alias aimux='npx aimux'
# or if globally installed, nothing needed
```

---

## 7. Version Roadmap

### v0.1 (MVP)
- `init`, `profile add/list/remove`, `run`, `rebuild`, `status`
- `auth login/status`
- `doctor`
- History-based profile hints
- Ink TUI for interactive commands

### v0.2
- `aimux run` interactive picker with TUI
- Auto-rebuild on `run` if stale symlinks detected
- `aimux config edit` — interactive config editor
- `aimux profile clone <from> <to>`
- Shell completions (bash, zsh, fish)

### v0.3
- Multi-CLI support: Gemini CLI, Codex CLI
- `aimux run <profile> --cli gemini`
- Per-CLI shared/private classification
- Unified status across CLIs

### v0.4
- Multi-session management in single terminal (tmux-style via Ink)
- Split-pane view
- Session switching hotkeys

### v1.0
- macOS support
- Windows support
- Plugin system for custom CLIs
- Export/import config
- Snapshot/restore profiles

---

## 8. Technical Decisions

### Why TypeScript + Ink
- Author is proficient in TypeScript (primary stack)
- Ink = React for terminal — powerful TUI with minimal effort
- npm distribution — zero-friction install via npx
- Fast iteration for MVP, Rust optimization possible later

### Why symlinks (not config merge/overlay)
- Already proven pattern (user's current setup works)
- Zero overhead at runtime — Claude CLI reads files normally
- Transparent — `ls -la` shows exactly what's happening
- Easy to debug

### Why ~/.claude stays untouched
- Claude CLI writes new files/folders on updates
- New files automatically available to all profiles via symlinks
- `claude` without aimux continues working
- Non-invasive — safe to uninstall aimux

### Why no project→profile binding
- User quote: "вся суть в том что у нас становится возможным запуск несколько разных подписок в одном терминале — а в каком проекте какой запускать решает сам пользователь"
- Profiles are subscriptions, not project configs
- Soft hints via history are sufficient
