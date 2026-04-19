import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return resolve(p);
}

export const AIMUX_DIR = join(homedir(), '.aimux');
export const CONFIG_PATH = join(AIMUX_DIR, 'config.yaml');
export const HISTORY_PATH = join(AIMUX_DIR, 'history.yaml');
export const PROFILES_DIR = join(AIMUX_DIR, 'profiles');
