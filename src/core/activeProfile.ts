import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getAimuxDir } from './paths.js';

interface ActiveProfileFile {
  version: 1;
  profile: string;
}

export function getActiveProfilePath(): string {
  return join(getAimuxDir(), 'active-profile.json');
}

export function loadActiveProfile(): string | null {
  const path = getActiveProfilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as ActiveProfileFile;
    return typeof raw?.profile === 'string' ? raw.profile : null;
  } catch {
    return null;
  }
}

export function saveActiveProfile(profile: string): void {
  const path = getActiveProfilePath();
  mkdirSync(dirname(path), { recursive: true });
  const data: ActiveProfileFile = { version: 1, profile };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}
