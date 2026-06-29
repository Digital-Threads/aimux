# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.21.0] - 2026-06-29

### Added
- **Gemini CLI support (`--cli gemini`).** A third AI CLI alongside claude and codex.
  `aimux profile add gem --cli gemini` creates an isolated Gemini profile that shares
  knowledge (`GEMINI.md`, `skills`, `commands`, `extensions`, `memories`) from
  `~/.gemini` while keeping auth, `settings.json`, and history private. `run` / `use`
  launch `gemini` with the right `-m <model>` flag under an isolated config dir.
  - Gemini has no direct config-dir override, so aimux sets `GEMINI_CLI_HOME` to the
    profile's parent and makes the profile dir itself gemini's `.gemini` (a new optional
    `CliAdapter.configPathFor`). claude/codex profile paths are unchanged.
  - `aimux init` now also hints when `~/.gemini` is detected.
  - Note: Gemini resumes by per-project index (`-r latest`), not by session id, so
    cross-Gemini native resume is not wired into the session list yet.

## [0.20.0] - 2026-06-28

### Added
- **`aimux usage` now includes codex sessions.** Usage scanned only Claude
  transcripts, so codex profiles showed zero tokens and `$0` — a silently
  incomplete report. It now also reads codex session rollouts (final cumulative
  `token_count`, with `cached_input_tokens` split into the cache-read bucket) and
  attributes them to a profile via the same history → `unknown` fallback as Claude.
- **Pricing for OpenAI / codex (gpt-5 family).** Added list-price estimates for
  `gpt-5.3-codex`, `gpt-5-codex`, `gpt-5.5`, `gpt-5.4`, `gpt-5` (plus family
  prefixes) so codex turns are no longer costed at `$0`. Estimates only, like the
  existing Claude/provider prices.

### Fixed
- **`aimux profile remove` confirms before deleting.** It ran `rm -rf` on the
  profile's directory (credentials included) with no confirmation; combined with
  prefix-matched names, a typo could wipe the wrong profile. It now prompts `[y/N]`
  on a TTY (echoing the resolved name + full path). **Behavior change:** in a
  non-interactive shell it refuses to delete unless `-y/--yes` is passed (scripts
  must opt in). `--keep-dir` still removes the profile without touching disk.
- **Handoff locates the codex transcript by exact session id** (the trailing
  `-<uuid>.jsonl`) instead of a substring match a sibling file could win, and only
  trusts the generated summary when the headless summarizer exits `0`.

## [0.19.1] - 2026-06-28

### Fixed
- **Reply watchdog is now an inactivity timeout, not a turn cap.** In the
  live-session API the reply watchdog armed once per `send()` and cleared only on
  the turn's `result`, so a turn that streamed longer than `replyTimeoutMs`
  (default 10 min) was killed mid-work — a long implementation died with "did not
  respond within the time limit" while still actively streaming. It now re-arms on
  every streamed `assistant` event, so it fires only on genuine silence; a
  long-but-active turn keeps going. A stuck/silent turn still times out.

## [0.19.0] - 2026-06-26

### Added
- **Per-session reasoning effort (`openSession({ effort })`).** The live-session
  API forwards a reasoning-effort level to the CLI as `--effort <level>` (e.g.
  `low` | `medium` | `high` | `xhigh` | `max`). Thin passthrough — aimux only
  knows the flag; the caller owns the level. Optional and backward-compatible:
  omit it to keep the CLI's default, and existing `openSession` callers are
  unaffected.

## [0.18.0] - 2026-06-24

### Added
- **Switch your shell to a profile (`aimux use`).** Activate a profile in the
  current shell so plain `claude` / `codex` run under it — the `nvm use` / `pyenv
  shell` model, an alternative to per-launch `aimux run`. Enable once with
  `eval "$(aimux shell-init)"` in your rc (bash/zsh/fish supported), then:
  - `aimux use <profile>` exports the profile's env (the CLI adapter picks
    `CLAUDE_CONFIG_DIR` vs `CODEX_HOME`, plus any profile `.env`) into the
    current shell. No name → interactive picker.
  - Switching profiles cleans up the previous profile's managed vars (stale
    `ANTHROPIC_*` / tokens), so no credentials leak across a switch.
  - Each shell is independent — different terminals can hold different active
    profiles at once, preserving aimux's "any profile, any terminal" model.
  - `aimux shell-init [--shell <bash|zsh|fish>]` prints the wrapper function.
- **`aimux status` / `profile list` mark the in-use profile.** The profile
  activated in the current shell is highlighted with a `▸` marker and an
  `Active here:` summary line (read from `$AIMUX_PROFILE`, ignored if stale).

## [0.17.0] - 2026-06-21

### Added
- **Codex profiles reach full parity with claude.** In addition to knowledge
  (`skills`/`rules`/`memories`), codex profiles now also share:
  - **Session transcripts** — `sessions/` + `session_index.jsonl`, the codex analogue of
    claude's shared `projects/`. Switching codex subscriptions can `codex resume` the same
    session under another profile.
  - **Settings + plugins** — via codex's native config overlay: a symlinked
    `aimux.config.toml` (→ source `config.toml`) layered with `-p aimux`, which codex reads
    but never writes. The mutable `config.toml` itself stays private per profile. No TOML
    dependency, no merge — pure symlink + flag (verified against codex-cli 0.139.0).
- **Provider presets for Anthropic-compatible models.**
  `aimux profile add <name> --provider <deepseek|kimi|glm|qwen|minimax|mimo>` fills the
  provider's `ANTHROPIC_BASE_URL` + model mapping and prompts only for the token. These run
  on the claude CLI (`cli: claude`), so they share the **full claude brain** (skills,
  plugins, settings, memory, transcripts) and you can `--resume` a claude session under
  them natively — switching the model mid-session, no summary needed.
- `aimux init` detects `~/.codex` and pre-registers `shared_sources.codex`.

### Fixed
- **Codex auth shown correctly.** Profile list and `aimux auth status` checked claude's
  `.credentials.json`, so codex profiles showed `✗ no auth` despite being logged in; now
  routed through the adapter (`auth.json`).
- **Codex session names in `aimux agents`** skip the injected context preamble
  (`<environment_context>` / AGENTS.md) and show the real first prompt.

## [0.16.0] - 2026-06-20

### Added
- **Multi-CLI support (Codex first).** A profile can now run a different AI CLI, not
  just claude, selected by its `cli` field. `aimux profile add <name> --cli codex`
  creates a Codex profile; `aimux auth login <name>` runs `codex login` under an
  isolated `CODEX_HOME`; `aimux run <name>` launches Codex with the right model flag.
  claude profiles are byte-for-byte unchanged — multi-CLI is strictly opt-in.
  - **Per-CLI source-of-truth.** `shared_sources: { claude: ~/.claude, codex: ~/.codex }`
    (additive; the legacy `shared_source` remains as the claude alias). Each CLI shares
    from its own source.
  - **Per-CLI share regimen.** claude keeps its denylist (everything except `private`).
    Codex shares an allowlist of knowledge dirs (`skills`, `rules`, `memories`) and
    keeps creds/state (`auth.json`, `config.toml`, `sessions/`, …) private. Codex
    *plugin* sharing is a planned fast-follow.
  - **Codex in `aimux agents`.** Codex sessions are discovered (from rollout files) and
    listed alongside claude sessions with a CLI badge. Resuming routes per CLI
    (`codex resume <id>` vs `claude --resume <id>`).
- **Cross-CLI handoff.** `aimux handoff <sessionId> --to <profile>` continues a session
  under a different CLI when you hit a subscription limit. Because the two CLIs'
  transcripts are mutually unreadable, this is a summary handoff, not a native resume:
  aimux reads the source transcript, summarizes it with the target profile (fully
  self-contained — no external orchestration), then launches the target seeded with the
  summary. The same-CLI path (claude↔claude, codex↔codex) still uses native resume.
- **Public core API:** `adapterFor`/`CliAdapter`, `sourceFor`, `handoffSession`,
  `buildHandoffPrompt`, and `UnifiedSession.cli`. Additive.

### Notes
- Cross-CLI handoff carries the *conversation context*, not the model — the target CLI
  continues with a different model. The transfer is a summary, not a verbatim replay.

## [0.15.0] - 2026-06-19

### Added
- **Live-session core API (`openSession`).** The persistent sibling of
  `runProfileHeadless`: keeps ONE Claude process alive under a profile and drives a
  multi-turn conversation over the verified stream-json protocol. It owns every
  Claude-CLI detail (the `-p` print flags, stream-json framing,
  `--session-id`/`--resume`, `--settings`/`--mcp-config`/permission flags) so a
  consumer asks for a *session on a profile*, never a command line. Supports
  `send`/`interject`, per-turn cost and permission-denial reporting, assistant
  streaming with tool labels, a reply watchdog, and dead-process recovery so a stuck
  turn never hangs the caller. `relocate(toProfile)` switches account mid-session
  (rate-limit recovery) via `--resume`, preserving the conversation — the core
  multi-subscription domain. Also injects `LOOM_TASK_ID`/`LOOM_WORKFLOW_ID` (the
  shared-ID "spine"), same as the headless path.
- `core` barrel now re-exports `openSession`, `buildSessionArgs` and the
  `OpenSessionOptions` / `SessionEvent` / `TurnResult` / `LiveSession` types.

### Backward compatibility
- Purely additive. The new module is lazy — nothing in the interactive CLI imports
  it, and it has no import-time side effects — so standalone `aimux` behavior is
  unchanged. No existing export or signature was touched.

## [0.14.0] - 2026-06-14

### Added
- **`runProfileHeadless()` core API.** Non-interactive launch: pipes stdio and
  captures `stdout`/`stderr`/`exitCode` instead of inheriting the terminal. The
  interactive `launchProfile` is untouched. Injects `LOOM_TASK_ID`/`LOOM_WORKFLOW_ID`
  into the spawned session env so token-pilot / task-journal telemetry can tie to the
  same task (the shared-ID "spine"). CLI-agnostic — the caller passes print/prompt
  flags via `extraArgs`.
- **`usageBySession()` core API.** Per-session usage breakdown (the "spent" source for
  exact per-task cost). Internals refactored into a shared `collectUsageRecords`
  scanner so per-profile and per-session views stay in sync; `summarizeUsage` output
  is unchanged.

### Backward compatibility
- No existing behavior changes. New env vars are read only in the new headless path
  (no env → identical behavior); `launchProfile` / `summarizeUsage` public output is
  untouched.

## [0.13.0] - 2026-06-11

### Fixed
- **Plugin marketplaces no longer fail validation under a profile.** Newer Claude
  Code checks that each marketplace's `installLocation` is literally inside
  `$CLAUDE_CONFIG_DIR/plugins/marketplaces` (string prefix, not realpath). Because
  aimux symlinked the whole `plugins/` directory to the shared `~/.claude/plugins`,
  the shared `known_marketplaces.json` carried `~/.claude/...` paths that don't match
  a profile's config dir — so `/plugin` refresh/update reported
  `corrupted installLocation` and showed stale versions. Plugins still loaded, but
  could not be refreshed from within a profile.

### Changed
- **Per-profile plugin metadata.** A profile's `plugins/` is now a real directory:
  content (`marketplaces/`, `cache/`, `data/`, …) is still symlinked to the shared
  source so plugin bytes stay shared, but `known_marketplaces.json` and
  `installed_plugins.json` are real, path-projected copies whose `installLocation`
  values point inside the profile. The shared source (`~/.claude/plugins`) remains the
  source of truth; the projection is regenerated on sync. A plugin installed from
  within a profile is back-merged (additively) into the source so it propagates to the
  other profiles. Conversion is automatic and lazy on the next `aimux run`, idempotent,
  and never touches the source profile (`~/.claude`); an older aimux treats the new
  layout as a local override and leaves it intact.

### Added
- `core` barrel now re-exports `loadActiveProfile`, `saveActiveProfile`, and
  `getActiveProfilePath` from `@digital-threads/aimux/core`. Additive — lets
  external consumers read/switch the active profile through the public API
  without deep-importing. No behavior change.

## [0.11.2] - 2026-06-08

### Changed
- **Attaching a session from the agents view now mirrors the terminal.** It runs
  `claude --resume <id>` under the active profile — exactly like
  `aimux run <profile> --resume <id>` — so the chosen profile (and its
  subscription) always wins. A still-running background agent is continued with
  `--fork-session` (claude requires it for a live session); a finished or
  interactive session resumes in place under the chosen profile, same session id.
  Removed the previous join/stop special-casing that could land you back on the
  original (possibly exhausted) subscription.

## [0.11.1] - 2026-06-08

### Fixed
- **Attaching now honors the chosen profile.** A live background agent is owned
  by the profile it was dispatched under, and aimux always joined via that owner
  — so switching profile with `p` (e.g. after a subscription ran out) had no
  effect and the row kept showing the old profile. Now, when the chosen/active
  profile differs from the owner, aimux stops the owner's live agent and resumes
  the shared transcript under the chosen profile (billing and `last:` follow it).
  When the chosen profile matches the owner, it still joins the live agent as
  before. To simply join another profile's live agent, make that profile active
  first.

## [0.11.0] - 2026-06-07

### Added
- **Session names from Claude titles.** The agents list now shows a session's
  real title — a user `/rename` (custom-title) takes precedence, otherwise
  Claude's generated ai-title — instead of the raw first prompt. Falls back to
  the first prompt, then a short session id. Titles are read from the end of the
  transcript (where Claude appends them) with a bounded tail read, so the default
  7-day scan stays fast.

### Fixed
- **Escape sequence no longer leaks into a re-attached session.** The terminal's
  Device-Attributes response is drained before handing the tty to Claude, and
  stdin is restored to a clean paused state afterward so the agents TUI no longer
  freezes on return from a session.

## [0.10.0] - 2026-06-07

### Added
- **Per-profile fallback model.** Set a model that Claude falls back to when the
  primary is overloaded or unavailable:
  `aimux profile update <name> --fallback-model <model>` (and
  `--unset-fallback-model`). Applies to `aimux run` and to background dispatch
  from the agents view. `aimux profile add --fallback-model` and `clone` carry it
  too. Maps to Claude's `--fallback-model`.
- **`aimux agents` live view.** The session list now refreshes on its own while
  agents are working (state transitions and newly dispatched agents appear
  without a keypress), with an animated spinner on running rows.
- Short-id column and clearer status labels in the agents list.

### Changed
- **Agents view is now near-instant to open.** Profile token/$ usage
  (`summarizeUsage`) is no longer computed on the render path and is skipped
  entirely when no API-endpoint profile is present — previously it scanned every
  transcript on every open/return (several seconds on busy machines) for a result
  that is only shown for API profiles.
- Faster re-scans via a per-file parse cache and an in-process list cache, so
  returning from an attached session paints immediately.
- Agents view restyled to match Claude's own agents UI (status glyphs, header
  rules, selected-row accent, footer) while keeping aimux's multi-profile status
  bar, rate limits, profile colors, pinning, grouping, filtering and peek.

### Fixed
- **Dispatching a background agent no longer tears down the TUI.** `n` → prompt →
  Enter now runs in place and refreshes the list, instead of unmounting the view
  and dumping the raw `backgrounded · <short>` banner into the terminal.
- Compaction-continuation and `<local-command-stdout/stderr>` lines are no longer
  used as session names.

### Known issues
- A terminal Device-Attributes response (`;…c`) can still leak into the prompt
  when re-attaching to a session a second time (cosmetic).
