import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return resolve(p);
}

const _defaultAimuxDir = join(homedir(), '.aimux');
let _aimuxDir = _defaultAimuxDir;

export function getAimuxDir(): string {
  return _aimuxDir;
}

export function getConfigPath(): string {
  return join(_aimuxDir, 'config.yaml');
}

export function getHistoryPath(): string {
  return join(_aimuxDir, 'history.yaml');
}

export function getProfilesDir(): string {
  return join(_aimuxDir, 'profiles');
}

export function setAimuxDir(dir: string): void {
  _aimuxDir = dir;
}

export function resetAimuxDir(): void {
  _aimuxDir = _defaultAimuxDir;
}
