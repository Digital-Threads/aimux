import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';

interface ProjectsBag {
  [cwd: string]: {
    lastSessionId?: string;
    lastSessionModified?: number;
  };
}

interface ClaudeJsonShape {
  projects?: ProjectsBag;
}

export interface ProfileSessionMapEntry {
  profile: string;
  modifiedAtMs?: number;
}

/**
 * Walks each profile's private `.claude.json` and builds a
 * sessionId -> profile mapping derived from `projects[cwd].lastSessionId`.
 * When the same session-id appears under more than one profile, the entry
 * with the more recent `lastSessionModified` timestamp wins.
 *
 * This lets the dashboard show which profile last touched a session even
 * for sessions launched before aimux started tracking them explicitly.
 */
export function buildProfileSessionMap(
  config: AimuxConfig,
): Map<string, ProfileSessionMapEntry> {
  const map = new Map<string, ProfileSessionMapEntry>();
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    const path = join(expandHome(profile.path), '.claude.json');
    if (!existsSync(path)) continue;
    let parsed: ClaudeJsonShape;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as ClaudeJsonShape;
    } catch {
      continue;
    }
    const projects = parsed.projects ?? {};
    for (const project of Object.values(projects)) {
      const sid = project?.lastSessionId;
      if (!sid || typeof sid !== 'string') continue;
      const modifiedAtMs =
        typeof project.lastSessionModified === 'number' ? project.lastSessionModified : undefined;
      const existing = map.get(sid);
      if (!existing) {
        map.set(sid, { profile: profileName, modifiedAtMs });
      } else if (
        modifiedAtMs !== undefined &&
        (existing.modifiedAtMs === undefined || modifiedAtMs > existing.modifiedAtMs)
      ) {
        map.set(sid, { profile: profileName, modifiedAtMs });
      }
    }
  }
  return map;
}
