export interface ProfileConfig {
  cli: string;
  model?: string;
  path: string;
  is_source?: boolean;
}

export interface AimuxConfig {
  version: number;
  shared_source: string;
  profiles: Record<string, ProfileConfig>;
  private: string[];
}

export const DEFAULT_PRIVATE_ELEMENTS = [
  '.credentials.json',
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
