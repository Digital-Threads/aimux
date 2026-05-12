import { lstatSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';

const PRIVATE_DIR_ELEMENTS = new Set(['jobs', 'daemon', 'projects']);

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
