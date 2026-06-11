# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and this project adheres to
[Semantic Versioning](https://semver.org/).

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
