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
  'policy-limits.json',
  'mcp-needs-auth-cache.json',
  'remote-settings.json',
  'settings.local.json',
  'stats-cache.json',
  'statsig',
  'telemetry',
];

export const DEFAULT_CONFIG: AimuxConfig = {
  version: 1,
  shared_source: '~/.claude',
  profiles: {},
  private: DEFAULT_PRIVATE_ELEMENTS,
};
