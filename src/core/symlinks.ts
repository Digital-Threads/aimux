import {
  readdirSync, lstatSync, symlinkSync, readlinkSync,
  existsSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';

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

  const sourcePath = expandHome(config.shared_source);
  const profilePath = expandHome(profile.path);
  const privateSet = new Set(config.private);

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

    if (privateSet.has(entry)) {
      result.private.push(entry);
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
      } else {
        result.conflicts.push(entry);
      }
    } else {
      symlinkSync(sourceTarget, targetInProfile);
      result.created.push(entry);
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

  const sourcePath = expandHome(config.shared_source);
  const profilePath = expandHome(profile.path);
  const privateSet = new Set(config.private);

  if (!existsSync(profilePath)) {
    report.missing.push('(profile directory)');
    return report;
  }

  const sourceEntries = new Set(readdirSync(sourcePath));
  const profileEntries = readdirSync(profilePath);

  for (const entry of sourceEntries) {
    if (privateSet.has(entry)) continue;

    const targetInProfile = join(profilePath, entry);
    if (!lstatExists(targetInProfile)) {
      report.missing.push(entry);
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
    if (privateSet.has(entry)) continue;
    if (!sourceEntries.has(entry)) {
      const stat = lstatSync(join(profilePath, entry));
      if (stat.isSymbolicLink()) {
        report.orphaned.push(entry);
      }
    }
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

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
