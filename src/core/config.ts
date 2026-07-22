import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'yaml';
import type { AimuxConfig, ProfileConfig, HistoryEntry } from '../types/index.js';
import { DEFAULT_CONFIG, DEFAULT_PRIVATE_ELEMENTS } from '../types/index.js';
import { getConfigPath, getHistoryPath, getAimuxDir, getProfilesDir, expandHome } from './paths.js';
import { adapterFor } from './adapters/index.js';


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
  options: { cli?: string; model?: string; fallbackModel?: string },
): AimuxConfig {
  if (config.profiles[name]) {
    throw new Error(`Profile '${name}' already exists`);
  }
  const cli = options.cli ?? 'claude';
  const baseDir = `~/.aimux/profiles/${name}`;
  // Most CLIs use the base dir as their config home; gemini needs it to be a `.gemini`
  // subdir (see geminiAdapter.configPathFor / configDirEnv).
  const adapter = adapterFor(cli);
  const profilePath = adapter.configPathFor ? adapter.configPathFor(baseDir) : baseDir;
  const updated = { ...config };
  updated.profiles = {
    ...config.profiles,
    [name]: {
      cli,
      model: options.model,
      fallback_model: options.fallbackModel,
      path: profilePath,
    },
  };
  // A non-claude CLI needs its own source-of-truth registered so sharing resolves to
  // the right dir (not the legacy claude shared_source). Default to the adapter's source.
  if (cli !== 'claude' && !config.shared_sources?.[cli]) {
    updated.shared_sources = { ...config.shared_sources, [cli]: adapterFor(cli).defaultSource() };
  }
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

/** Resolve the source-of-truth dir for a CLI. Per-CLI `shared_sources` wins; absence
 *  falls back to the legacy single `shared_source` (the claude source), preserving
 *  pre-multi-CLI behavior. */
export function sourceFor(config: AimuxConfig, cli: string): string {
  return config.shared_sources?.[cli] ?? config.shared_source;
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
      if (p.fallback_model !== undefined && typeof p.fallback_model !== 'string') {
        errors.push(`Profile '${name}': fallback_model must be a string`);
      }
      if (p.env !== undefined) {
        if (!p.env || typeof p.env !== 'object' || Array.isArray(p.env)) {
          errors.push(`Profile '${name}': env must be a map of string keys to string values`);
        } else {
          for (const [k, v] of Object.entries(p.env as Record<string, unknown>)) {
            if (typeof v !== 'string') {
              errors.push(`Profile '${name}': env.${k} must be a string`);
            }
          }
        }
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

  if (c.bindings !== undefined) {
    if (!Array.isArray(c.bindings)) {
      errors.push('bindings must be an array of objects');
    } else {
      const profiles = (c.profiles || {}) as Record<string, unknown>;
      for (let i = 0; i < c.bindings.length; i++) {
        const b = c.bindings[i];
        if (!b || typeof b !== 'object' || Array.isArray(b)) {
          errors.push(`bindings[${i}] must be an object`);
          continue;
        }
        if (typeof b.pattern !== 'string' || !b.pattern) {
          errors.push(`bindings[${i}]: pattern must be a non-empty string`);
        }
        if (typeof b.profile !== 'string' || !b.profile) {
          errors.push(`bindings[${i}]: profile must be a non-empty string`);
        } else if (!profiles[b.profile]) {
          errors.push(`bindings[${i}]: profile '${b.profile}' does not exist in profiles`);
        }
      }
    }
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

export function matchGlob(dir: string, pattern: string): boolean {
  const cleanDir = resolve(expandHome(dir));
  // Anchor a relative pattern to $HOME, never to process.cwd(): a binding in config.yaml
  // must mean the same directory no matter where `aimux` was invoked from. Test the RAW
  // pattern — expandHome() already resolves a bare relative path against the cwd.
  const cleanPattern = pattern.startsWith('~/') || isAbsolute(pattern)
    ? expandHome(pattern)
    : resolve(homedir(), pattern);

  if (cleanDir === cleanPattern) return true;

  const dirParts = cleanDir.split(sep);
  const patternParts = cleanPattern.split(sep);

  let d = 0;
  let p = 0;
  while (d < dirParts.length && p < patternParts.length) {
    const part = patternParts[p];
    if (part === '**') {
      if (p === patternParts.length - 1) {
        return true;
      }
      const nextPatternPart = patternParts[p + 1];
      let found = false;
      while (d < dirParts.length) {
        if (matchSegment(dirParts[d], nextPatternPart)) {
          found = true;
          break;
        }
        d++;
      }
      if (!found) return false;
      p += 2;
      d++;
      continue;
    }

    if (!matchSegment(dirParts[d], part)) {
      return false;
    }
    d++;
    p++;
  }

  if (d === dirParts.length && p === patternParts.length - 1 && patternParts[p] === '**') {
    return true;
  }

  return d === dirParts.length && p === patternParts.length;
}

function matchSegment(segment: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$';
  const regex = new RegExp(regexStr);
  return regex.test(segment);
}

export function resolveProfileForDir(config: AimuxConfig, dir: string): string | null {
  if (config.bindings && config.bindings.length > 0) {
    for (const binding of config.bindings) {
      if (matchGlob(dir, binding.pattern) && config.profiles[binding.profile]) {
        return binding.profile;
      }
    }
  }
  return null;
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
