import { spawn, spawnSync } from 'node:child_process';
import type { AimuxConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';

function buildEnv(config: AimuxConfig, profileName: string): NodeJS.ProcessEnv {
  const profile = getProfile(config, profileName);
  const profilePath = expandHome(profile.path);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!profile.is_source) {
    env.CLAUDE_CONFIG_DIR = profilePath;
  }
  return env;
}

export function attachSession(
  config: AimuxConfig,
  profileName: string,
  sessionShort: string,
): Promise<number> {
  const profile = getProfile(config, profileName);
  return new Promise((resolve, reject) => {
    const child = spawn(profile.cli, ['attach', sessionShort], {
      stdio: 'inherit',
      env: buildEnv(config, profileName),
    });
    child.on('error', (err) => reject(new Error(`Failed to attach: ${err.message}`)));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export function dispatchSession(
  config: AimuxConfig,
  profileName: string,
  prompt: string,
): { code: number; stdout: string; stderr: string } {
  const profile = getProfile(config, profileName);
  const result = spawnSync(profile.cli, ['--bg', prompt], {
    env: buildEnv(config, profileName),
    encoding: 'utf-8',
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function stopSession(
  config: AimuxConfig,
  profileName: string,
  sessionShort: string,
): { code: number; stderr: string } {
  const profile = getProfile(config, profileName);
  const result = spawnSync(profile.cli, ['stop', sessionShort], {
    env: buildEnv(config, profileName),
    encoding: 'utf-8',
  });
  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? '',
  };
}

export function respawnSession(
  config: AimuxConfig,
  profileName: string,
  sessionShort: string,
): { code: number; stdout: string; stderr: string } {
  const profile = getProfile(config, profileName);
  const result = spawnSync(profile.cli, ['respawn', sessionShort], {
    env: buildEnv(config, profileName),
    encoding: 'utf-8',
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function resumeSession(
  config: AimuxConfig,
  profileName: string,
  sessionId: string,
  options: { cwd?: string } = {},
): Promise<number> {
  const profile = getProfile(config, profileName);
  return new Promise((resolve, reject) => {
    const child = spawn(profile.cli, ['--resume', sessionId], {
      stdio: 'inherit',
      env: buildEnv(config, profileName),
      cwd: options.cwd,
    });
    child.on('error', (err) => reject(new Error(`Failed to resume: ${err.message}`)));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
