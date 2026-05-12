import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import type { AimuxConfig, ProfileConfig, HistoryEntry } from '../types/index.js';
import { DEFAULT_CONFIG, DEFAULT_PRIVATE_ELEMENTS } from '../types/index.js';
import { getConfigPath, getHistoryPath, getAimuxDir, getProfilesDir, expandHome } from './paths.js';

export function loadConfig(): AimuxConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }
  const raw = readFileSync(configPath, 'utf-8');
  const config = parse(raw) as AimuxConfig;
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid config:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
  // Union with current defaults so old configs pick up new private entries
  // (e.g. jobs/daemon for session isolation) without manual edits.
  const merged = new Set([...config.private, ...DEFAULT_PRIVATE_ELEMENTS]);
  config.private = Array.from(merged);
  return config;
}

export function saveConfig(config: AimuxConfig): void {
  ensureAimuxDir();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Cannot save invalid config:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
  const yamlStr = stringify(config, { lineWidth: 120 });
  writeFileSync(getConfigPath(), yamlStr, 'utf-8');
}

export function createDefaultConfig(sharedSource: string): AimuxConfig {
  return {
    ...DEFAULT_CONFIG,
    shared_source: sharedSource,
    profiles: {
      main: {
        cli: 'claude',
        path: sharedSource,
        is_source: true,
      },
    },
  };
}

export function addProfile(
  config: AimuxConfig,
  name: string,
  options: { cli?: string; model?: string },
): AimuxConfig {
  if (config.profiles[name]) {
    throw new Error(`Profile '${name}' already exists`);
  }
  const profilePath = `~/.aimux/profiles/${name}`;
  const updated = { ...config };
  updated.profiles = {
    ...config.profiles,
    [name]: {
      cli: options.cli ?? 'claude',
      model: options.model,
      path: profilePath,
    },
  };
  return updated;
}

export function removeProfile(config: AimuxConfig, name: string): AimuxConfig {
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Profile '${name}' not found`);
  }
  if (profile.is_source) {
    throw new Error(`Cannot remove source profile '${name}'`);
  }
  const updated = { ...config };
  const { [name]: _, ...rest } = config.profiles;
  updated.profiles = rest;
  return updated;
}

export function getProfile(config: AimuxConfig, name: string): ProfileConfig {
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Profile '${name}' not found. Available: ${Object.keys(config.profiles).join(', ')}`);
  }
  return profile;
}

export function getSourceProfile(config: AimuxConfig): [string, ProfileConfig] {
  const entry = Object.entries(config.profiles).find(([, p]) => p.is_source);
  if (!entry) {
    throw new Error('No source profile found in config');
  }
  return entry;
}

export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return ['Config must be an object'];
  }

  const c = config as Record<string, unknown>;

  if (c.version !== 1) {
    errors.push(`Unsupported config version: ${c.version} (expected 1)`);
  }

  if (typeof c.shared_source !== 'string' || !c.shared_source) {
    errors.push('shared_source must be a non-empty string');
  }

  if (!c.profiles || typeof c.profiles !== 'object') {
    errors.push('profiles must be an object');
  } else {
    const profiles = c.profiles as Record<string, unknown>;
    let sourceCount = 0;

    for (const [name, profile] of Object.entries(profiles)) {
      if (!profile || typeof profile !== 'object') {
        errors.push(`Profile '${name}' must be an object`);
        continue;
      }
      const p = profile as Record<string, unknown>;

      if (typeof p.cli !== 'string' || !p.cli) {
        errors.push(`Profile '${name}': cli must be a non-empty string`);
      }
      if (typeof p.path !== 'string' || !p.path) {
        errors.push(`Profile '${name}': path must be a non-empty string`);
      }
      if (p.model !== undefined && typeof p.model !== 'string') {
        errors.push(`Profile '${name}': model must be a string`);
      }
      if (p.is_source) sourceCount++;
    }

    if (sourceCount === 0) {
      errors.push('At least one profile must have is_source: true');
    }
    if (sourceCount > 1) {
      errors.push('Only one profile can be the source');
    }
  }

  if (!Array.isArray(c.private)) {
    errors.push('private must be an array of strings');
  }

  return errors;
}

// --- History ---

export function loadHistory(): HistoryEntry[] {
  const historyPath = getHistoryPath();
  if (!existsSync(historyPath)) {
    return [];
  }
  const raw = readFileSync(historyPath, 'utf-8');
  const data = parse(raw);
  return Array.isArray(data) ? data : [];
}

export function saveHistory(entries: HistoryEntry[]): void {
  ensureAimuxDir();
  const yamlStr = stringify(entries, { lineWidth: 120 });
  writeFileSync(getHistoryPath(), yamlStr, 'utf-8');
}

export function recordHistory(dir: string, profile: string): void {
  const entries = loadHistory();
  const existing = entries.findIndex(e => e.dir === dir);
  const entry: HistoryEntry = { dir, profile, timestamp: new Date().toISOString() };
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  saveHistory(entries);
}

export function getLastProfile(dir: string): string | null {
  const entries = loadHistory();
  const entry = entries.find(e => e.dir === dir);
  return entry?.profile ?? null;
}

// --- Filesystem ---

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export function ensureAimuxDir(): void {
  const aimuxDir = getAimuxDir();
  if (!existsSync(aimuxDir)) {
    mkdirSync(aimuxDir, { recursive: true });
  }
  const profilesDir = getProfilesDir();
  if (!existsSync(profilesDir)) {
    mkdirSync(profilesDir, { recursive: true });
  }
}

export function ensureProfileDir(config: AimuxConfig, name: string): string {
  const profile = getProfile(config, name);
  const fullPath = expandHome(profile.path);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }
  return fullPath;
}
