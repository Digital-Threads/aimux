import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The user's home. Inside an agy profile $HOME is that profile's stand-in, so aimux
 *  hands the real one down in AIMUX_REAL_HOME; paths built from the stand-in would send
 *  every profile's links through it. */
export function userHome(): string {
  return process.env.AIMUX_REAL_HOME || homedir();
}

/** The stand-in home of a profile whose CLI finds its config only under HOME: `homeDir`
 *  levels above the profile's config dir. */
export function standInHome(profilePath: string, homeDir: string): string {
  return resolve(profilePath, ...homeDir.split('/').map(() => '..'));
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return join(userHome(), p.slice(2));
  }
  return resolve(p);
}

const _defaultAimuxDir = join(userHome(), '.aimux');
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
