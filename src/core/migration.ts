import { lstatSync, existsSync, unlinkSync, mkdirSync, readdirSync, rmdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';

const PRIVATE_DIR_ELEMENTS = new Set(['jobs', 'daemon']);

export interface IsolateProfileResult {
  profile: string;
  unlinkedSymlinks: string[];
  createdDirs: string[];
  alreadyPrivate: string[];
}

export interface IsolateAllResult {
  perProfile: IsolateProfileResult[];
}

function isSymlinkSafe(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isolateProfile(
  config: AimuxConfig,
  profileName: string,
): IsolateProfileResult {
  const profile = config.profiles[profileName];
  if (!profile) throw new Error(`Profile '${profileName}' not found`);
  const result: IsolateProfileResult = {
    profile: profileName,
    unlinkedSymlinks: [],
    createdDirs: [],
    alreadyPrivate: [],
  };
  if (profile.is_source) return result;

  const profilePath = expandHome(profile.path);
  if (!existsSync(profilePath)) return result;

  for (const element of config.private) {
    const target = join(profilePath, element);
    if (!existsSync(target) && !isSymlinkSafe(target)) {
      // not present at all — supervisor will create it on demand
      continue;
    }
    if (isSymlinkSafe(target)) {
      try {
        unlinkSync(target);
        result.unlinkedSymlinks.push(element);
      } catch {
        // ignore — user can re-run
        continue;
      }
      if (PRIVATE_DIR_ELEMENTS.has(element)) {
        mkdirSync(target, { recursive: true });
        result.createdDirs.push(element);
      }
    } else {
      result.alreadyPrivate.push(element);
    }
  }
  return result;
}

export function isolateAllProfiles(config: AimuxConfig): IsolateAllResult {
  const perProfile: IsolateProfileResult[] = [];
  for (const name of Object.keys(config.profiles)) {
    if (config.profiles[name].is_source) continue;
    perProfile.push(isolateProfile(config, name));
  }
  return { perProfile };
}

export type ShareProjectsStatus =
  | 'already-shared'
  | 'symlinked'
  | 'skipped-non-empty'
  | 'skipped-missing-source';

export interface ShareProjectsProfileResult {
  profile: string;
  status: ShareProjectsStatus;
  contents?: string[];
}

export function shareProjectsForProfile(
  config: AimuxConfig,
  profileName: string,
): ShareProjectsProfileResult {
  const profile = config.profiles[profileName];
  if (!profile) throw new Error(`Profile '${profileName}' not found`);
  if (profile.is_source) return { profile: profileName, status: 'already-shared' };

  const profilePath = expandHome(profile.path);
  const target = join(profilePath, 'projects');
  const sourceProjects = join(expandHome(config.shared_source), 'projects');

  if (!existsSync(sourceProjects)) {
    return { profile: profileName, status: 'skipped-missing-source' };
  }

  if (isSymlinkSafe(target)) {
    return { profile: profileName, status: 'already-shared' };
  }

  if (!existsSync(target)) {
    symlinkSync(sourceProjects, target);
    return { profile: profileName, status: 'symlinked' };
  }

  // Real dir — only safe to replace with symlink if empty (no transcripts
  // were created under this profile after the v0.3.0 migration).
  let contents: string[] = [];
  try {
    contents = readdirSync(target);
  } catch {
    contents = [];
  }
  if (contents.length > 0) {
    return { profile: profileName, status: 'skipped-non-empty', contents };
  }
  rmdirSync(target);
  symlinkSync(sourceProjects, target);
  return { profile: profileName, status: 'symlinked' };
}

export interface ShareProjectsAllResult {
  perProfile: ShareProjectsProfileResult[];
}

export function shareProjectsForAllProfiles(config: AimuxConfig): ShareProjectsAllResult {
  const perProfile: ShareProjectsProfileResult[] = [];
  for (const name of Object.keys(config.profiles)) {
    if (config.profiles[name].is_source) continue;
    perProfile.push(shareProjectsForProfile(config, name));
  }
  return { perProfile };
}
