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
  // Per-profile background-session state — must be PRIVATE so each profile
  // has its own supervisor and its own dispatched sessions instead of
  // sharing them with the source profile via symlinks.
  'jobs',
  'daemon',
  'daemon.lock',
  'daemon.log',
  'daemon.status.json',
  'projects',
];

export const DEFAULT_CONFIG: AimuxConfig = {
  version: 1,
  shared_source: '~/.claude',
  profiles: {},
  private: DEFAULT_PRIVATE_ELEMENTS,
};
