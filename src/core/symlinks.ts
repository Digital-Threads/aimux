import {
  readdirSync, lstatSync, statSync, symlinkSync, readlinkSync,
  existsSync, mkdirSync, unlinkSync,
  readFileSync, writeFileSync, renameSync, openSync, closeSync,
} from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';
import { sourceFor } from './config.js';
import { adapterFor } from './adapters/index.js';

export interface SyncResult {
  created: string[];
  skipped: string[];
  broken: string[];
  repaired: string[];
  conflicts: string[];
  private: string[];
}

export interface HealthReport {
  profile: string;
  valid: string[];
  broken: string[];
  missing: string[];
  orphaned: string[];
  conflicts: string[];
}

const PLUGINS_DIRNAME = 'plugins';
const PLUGINS_SENTINEL = '.aimux-managed';
const PLUGINS_MERGE_LOCK = '.aimux-merge.lock';
const PLUGIN_METADATA: { file: string; mergeKey: string }[] = [
  { file: 'known_marketplaces.json', mergeKey: '' },
  { file: 'installed_plugins.json', mergeKey: 'plugins' },
];

/**
 * Rewrite any string under `fromPrefix` (path-segment boundary) to `toPrefix`,
 * recursing through objects and arrays. Non-matching strings and non-strings are
 * returned unchanged. Used to project plugin metadata between config dirs.
 */
export function rewritePluginPaths(value: unknown, fromPrefix: string, toPrefix: string): unknown {
  if (typeof value === 'string') {
    if (value === fromPrefix) return toPrefix;
    if (value.startsWith(fromPrefix + sep)) return toPrefix + value.slice(fromPrefix.length);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewritePluginPaths(v, fromPrefix, toPrefix));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewritePluginPaths(v, fromPrefix, toPrefix);
    }
    return out;
  }
  return value;
}

function entryMap(data: unknown, mergeKey: string): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  if (mergeKey === '') return obj;
  const m = obj[mergeKey];
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

let tmpCounter = 0;

function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/** Best-effort advisory lock; steals a stale (>30s) lock. Returns false if held. */
function acquireLock(lockPath: string): boolean {
  try {
    closeSync(openSync(lockPath, 'wx'));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
        unlinkSync(lockPath);
        closeSync(openSync(lockPath, 'wx'));
        return true;
      }
    } catch {
      // lost the race or cannot stat — treat as held
    }
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

/**
 * Project one source metadata file into the profile with paths rewritten, after
 * back-merging any profile-local entries (keys absent from source) into the source
 * file. Additive only — existing source entries are never modified. Source writes
 * are atomic and guarded by an advisory lock. No-ops if the source file is missing
 * or unparseable.
 */
function projectPluginMetadata(
  srcJson: string,
  dstJson: string,
  srcPlugins: string,
  dstPlugins: string,
  mergeKey: string,
  lockPath: string,
): void {
  let srcData = readJson(srcJson);
  if (srcData === undefined) return;

  const dstData = existsSync(dstJson) ? readJson(dstJson) : undefined;
  const srcMap = entryMap(srcData, mergeKey);
  const dstMap = entryMap(dstData, mergeKey);

  if (srcMap && dstMap) {
    const additions: Record<string, unknown> = {};
    for (const key of Object.keys(dstMap)) {
      if (!(key in srcMap)) additions[key] = rewritePluginPaths(dstMap[key], dstPlugins, srcPlugins);
    }
    if (Object.keys(additions).length > 0 && acquireLock(lockPath)) {
      try {
        // Re-read the source under lock so we merge into the freshest copy. If it is
        // missing or unparseable now (e.g. a concurrent writer mid-rename), abort the
        // back-merge rather than overwrite the source with our stale snapshot.
        const current = readJson(srcJson);
        const currentMap = entryMap(current, mergeKey);
        if (currentMap) {
          let changed = false;
          for (const [key, val] of Object.entries(additions)) {
            if (!(key in currentMap)) {
              currentMap[key] = val;
              changed = true;
            }
          }
          if (changed) writeJsonAtomic(srcJson, current);
          srcData = current;
        }
      } finally {
        releaseLock(lockPath);
      }
    }
  }

  writeJsonAtomic(dstJson, rewritePluginPaths(srcData, srcPlugins, dstPlugins));
}

/** Ensure `dst` is a symlink to `src`, repairing a wrong one and leaving real files. */
function ensurePluginSymlink(src: string, dst: string): void {
  if (lstatExists(dst)) {
    const st = lstatSync(dst);
    if (st.isSymbolicLink()) {
      if (resolve(dirname(dst), readlinkSync(dst)) === resolve(src)) return;
      unlinkSync(dst);
    } else {
      return; // a real file/dir we did not create — leave it
    }
  }
  symlinkSync(src, dst);
}

/**
 * Build/refresh the per-profile `plugins/` directory: a real dir whose content
 * entries are symlinked to the shared source (bytes stay shared) while the two
 * metadata files are real, path-projected copies. Idempotent; converts a legacy
 * whole-dir symlink; reports a user-owned dir (no sentinel) as a conflict.
 */
function syncPluginsDir(sourcePluginsDir: string, profilePluginsDir: string, result: SyncResult): void {
  if (lstatExists(profilePluginsDir)) {
    const st = lstatSync(profilePluginsDir);
    if (st.isSymbolicLink()) {
      unlinkSync(profilePluginsDir); // legacy whole-dir symlink → rebuild
    } else if (st.isDirectory()) {
      if (!existsSync(join(profilePluginsDir, PLUGINS_SENTINEL))) {
        result.conflicts.push(PLUGINS_DIRNAME);
        return;
      }
      // managed → refresh below
    } else {
      result.conflicts.push(PLUGINS_DIRNAME);
      return;
    }
  }

  const isNew = !existsSync(profilePluginsDir);
  mkdirSync(profilePluginsDir, { recursive: true });

  const metaFiles = new Set(PLUGIN_METADATA.map((m) => m.file));

  for (const entry of readdirSync(sourcePluginsDir)) {
    if (metaFiles.has(entry)) continue;
    ensurePluginSymlink(join(sourcePluginsDir, entry), join(profilePluginsDir, entry));
  }

  const srcPlugins = resolve(sourcePluginsDir);
  const dstPlugins = resolve(profilePluginsDir);

  // Prune only the symlinks we created — those pointing into the source plugins dir —
  // whose source entry has since disappeared. A user's own symlink (pointing elsewhere)
  // is left untouched even if dangling.
  for (const entry of readdirSync(profilePluginsDir)) {
    if (entry === PLUGINS_SENTINEL || metaFiles.has(entry)) continue;
    const p = join(profilePluginsDir, entry);
    if (!lstatSync(p).isSymbolicLink()) continue;
    const target = resolve(dirname(p), readlinkSync(p));
    if ((target === srcPlugins || target.startsWith(srcPlugins + sep)) && !existsSync(target)) {
      unlinkSync(p);
    }
  }

  const lockPath = join(sourcePluginsDir, PLUGINS_MERGE_LOCK);
  for (const meta of PLUGIN_METADATA) {
    projectPluginMetadata(
      join(sourcePluginsDir, meta.file),
      join(profilePluginsDir, meta.file),
      srcPlugins,
      dstPlugins,
      meta.mergeKey,
      lockPath,
    );
  }

  writeFileSync(join(profilePluginsDir, PLUGINS_SENTINEL), '');
  (isNew ? result.created : result.skipped).push(PLUGINS_DIRNAME);
}

export function getSharedElements(config: AimuxConfig): string[] {
  const sourcePath = expandHome(config.shared_source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Shared source not found: ${sourcePath}`);
  }
  const all = readdirSync(sourcePath);
  const privateSet = new Set(config.private);
  return all.filter(name => !privateSet.has(name));
}

export function getPrivateElements(config: AimuxConfig): string[] {
  const sourcePath = expandHome(config.shared_source);
  if (!existsSync(sourcePath)) return config.private;
  const all = readdirSync(sourcePath);
  const privateSet = new Set(config.private);
  return all.filter(name => privateSet.has(name));
}

export function syncProfile(config: AimuxConfig, profileName: string): SyncResult {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found`);
  }
  if (profile.is_source) {
    return {
      created: [],
      skipped: [],
      broken: [],
      repaired: [],
      conflicts: [],
      private: [],
    };
  }

  const adapter = adapterFor(profile.cli);
  const sourcePath = expandHome(sourceFor(config, profile.cli));
  const profilePath = expandHome(profile.path);
  const configPrivate = new Set(config.private);

  if (!existsSync(profilePath)) {
    mkdirSync(profilePath, { recursive: true });
  }

  const result: SyncResult = {
    created: [],
    skipped: [],
    broken: [],
    repaired: [],
    conflicts: [],
    private: [],
  };

  const sourceEntries = readdirSync(sourcePath);

  for (const entry of sourceEntries) {
    const targetInProfile = join(profilePath, entry);
    const sourceTarget = join(sourcePath, entry);

    if (!adapter.isShared(entry, configPrivate)) {
      result.private.push(entry);
      continue;
    }

    if (entry === PLUGINS_DIRNAME && statSync(sourceTarget).isDirectory()) {
      syncPluginsDir(sourceTarget, targetInProfile, result);
      continue;
    }

    if (existsSync(targetInProfile) || lstatExists(targetInProfile)) {
      const stat = lstatSync(targetInProfile);
      if (stat.isSymbolicLink()) {
        const linkTarget = resolve(profilePath, readlinkSync(targetInProfile));
        if (linkTarget === sourceTarget) {
          result.skipped.push(entry);
        } else {
          unlinkSync(targetInProfile);
          symlinkSync(sourceTarget, targetInProfile);
          result.repaired.push(entry);
        }
      } else if (adapter.reclaimsFromSource?.(entry) && stat.isFile()) {
        // A real file where a source-authoritative entry (codex's session-index DB)
        // belongs — replace it with the source symlink instead of leaving a conflict.
        // Guarded to a regular file: a directory at this path would make unlinkSync
        // throw EISDIR and abort the whole sync, so it falls through to `conflicts`.
        unlinkSync(targetInProfile);
        symlinkSync(sourceTarget, targetInProfile);
        result.repaired.push(entry);
      } else {
        result.conflicts.push(entry);
      }
    } else {
      symlinkSync(sourceTarget, targetInProfile);
      result.created.push(entry);
    }
  }

  // Per-CLI extra symlinks (codex config overlay + plugin content) — names that do not
  // exist as source entries, so they are created beyond the readdir loop above.
  for (const { link, target } of adapter.extraLinks(sourcePath)) {
    const linkPath = join(profilePath, link);
    if (lstatExists(linkPath)) {
      const st = lstatSync(linkPath);
      if (!st.isSymbolicLink()) {
        result.conflicts.push(link);
      } else if (symlinkTargetMatches(profilePath, linkPath, target)) {
        result.skipped.push(link);
      } else {
        unlinkSync(linkPath);
        symlinkSync(target, linkPath);
        result.repaired.push(link);
      }
      continue;
    }
    if (existsSync(target)) {
      symlinkSync(target, linkPath);
      result.created.push(link);
    }
  }

  return result;
}

export function syncAllProfiles(config: AimuxConfig): Map<string, SyncResult> {
  const results = new Map<string, SyncResult>();
  for (const name of Object.keys(config.profiles)) {
    results.set(name, syncProfile(config, name));
  }
  return results;
}

export function checkProfileHealth(config: AimuxConfig, profileName: string): HealthReport {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found`);
  }

  const report: HealthReport = {
    profile: profileName,
    valid: [],
    broken: [],
    missing: [],
    orphaned: [],
    conflicts: [],
  };

  if (profile.is_source) return report;

  const adapter = adapterFor(profile.cli);
  const sourcePath = expandHome(sourceFor(config, profile.cli));
  const profilePath = expandHome(profile.path);
  const configPrivate = new Set(config.private);

  if (!existsSync(profilePath)) {
    report.missing.push('(profile directory)');
    return report;
  }

  const sourceEntries = new Set(readdirSync(sourcePath));
  const profileEntries = readdirSync(profilePath);

  for (const entry of sourceEntries) {
    if (!adapter.isShared(entry, configPrivate)) continue;

    const targetInProfile = join(profilePath, entry);
    if (!lstatExists(targetInProfile)) {
      report.missing.push(entry);
      continue;
    }

    if (entry === PLUGINS_DIRNAME) {
      const st = lstatSync(targetInProfile);
      if (st.isSymbolicLink()) {
        // legacy whole-dir symlink — valid if it still points at the source
        const linkTarget = resolve(profilePath, readlinkSync(targetInProfile));
        report[linkTarget === join(sourcePath, entry) && existsSync(linkTarget) ? 'valid' : 'broken'].push(entry);
      } else if (st.isDirectory() && existsSync(join(targetInProfile, PLUGINS_SENTINEL))) {
        report.valid.push(entry); // aimux-managed per-profile plugins dir
      } else {
        report.conflicts.push(entry);
      }
      continue;
    }

    const stat = lstatSync(targetInProfile);
    if (stat.isSymbolicLink()) {
      const linkTarget = resolve(profilePath, readlinkSync(targetInProfile));
      const expectedTarget = join(sourcePath, entry);
      if (linkTarget === expectedTarget && existsSync(linkTarget)) {
        report.valid.push(entry);
      } else {
        report.broken.push(entry);
      }
    } else {
      report.conflicts.push(entry);
    }
  }

  for (const entry of profileEntries) {
    if (!adapter.isShared(entry, configPrivate)) continue;
    if (!sourceEntries.has(entry)) {
      const stat = lstatSync(join(profilePath, entry));
      if (stat.isSymbolicLink()) {
        report.orphaned.push(entry);
      }
    }
  }

  // Per-CLI extra symlinks (codex overlay + plugins). They are not source entries, so
  // they're validated here rather than in the loops above.
  for (const { link, target } of adapter.extraLinks(sourcePath)) {
    // syncProfile only creates an extra link when its source target exists; mirror that
    // here so an absent optional source (e.g. no ~/.codex/plugins) isn't a false 'missing'.
    if (!existsSync(target)) continue;
    const linkPath = join(profilePath, link);
    if (!lstatExists(linkPath)) {
      report.missing.push(link);
      continue;
    }
    const ok = lstatSync(linkPath).isSymbolicLink() && symlinkTargetMatches(profilePath, linkPath, target);
    report[ok ? 'valid' : 'broken'].push(link);
  }

  return report;
}

export function checkAllProfiles(config: AimuxConfig): Map<string, HealthReport> {
  const reports = new Map<string, HealthReport>();
  for (const name of Object.keys(config.profiles)) {
    reports.set(name, checkProfileHealth(config, name));
  }
  return reports;
}

/** Whether the symlink at `linkPath` resolves to `target` (relative to `fromDir`). */
function symlinkTargetMatches(fromDir: string, linkPath: string, target: string): boolean {
  return resolve(fromDir, readlinkSync(linkPath)) === resolve(target);
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
