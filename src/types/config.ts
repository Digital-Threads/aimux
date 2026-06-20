export interface ProfileConfig {
  cli: string;
  model?: string;
  /** Fallback model tried when the primary is overloaded/unavailable (claude --fallback-model). */
  fallback_model?: string;
  path: string;
  is_source?: boolean;
  /** Non-secret env vars injected into the spawned CLI; overrides `.env` on conflict. */
  env?: Record<string, string>;
}

export interface AimuxConfig {
  version: number;
  /** Legacy single source (the claude source-of-truth). Always present for backward
   *  compatibility; equivalent to `shared_sources.claude`. */
  shared_source: string;
  /** Per-CLI source-of-truth dirs, keyed by `cli` (e.g. `claude` → ~/.claude,
   *  `codex` → ~/.codex). Additive; absence falls back to `shared_source`. */
  shared_sources?: Record<string, string>;
  profiles: Record<string, ProfileConfig>;
  private: string[];
}

export const DEFAULT_PRIVATE_ELEMENTS = [
  '.credentials.json',
  '.env',
  '.claude.json',
  '.last-cleanup',
  'policy-limits.json',
  'mcp-needs-auth-cache.json',
  'remote-settings.json',
  'settings.local.json',
  'stats-cache.json',
  'statsig',
  'telemetry',
  // Per-profile background-session supervisor state — PRIVATE so each
  // profile has its own daemon and dispatched-session pool.
  //
  // NOTE: `projects/` stays SHARED (not in this list). It holds interactive
  // session transcripts keyed by cwd hash. Sharing it is what makes the
  // killer aimux workflow possible: hit a rate limit on one profile,
  // Ctrl+C, resume the SAME session from another profile's subscription
  // via `claude --resume <id>`.
  'jobs',
  'daemon',
  'daemon.lock',
  'daemon.log',
  'daemon.status.json',
];

export const DEFAULT_CONFIG: AimuxConfig = {
  version: 1,
  shared_source: '~/.claude',
  profiles: {},
  private: DEFAULT_PRIVATE_ELEMENTS,
};
