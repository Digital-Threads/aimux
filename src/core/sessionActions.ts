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

/**
 * Dispatch a background session WITHOUT touching the terminal. stdin is ignored
 * and stdout/stderr are captured (never inherited), so this can run while an Ink
 * TUI stays mounted — the caller refreshes its list instead of tearing down.
 */
export function dispatchSessionAsync(
  config: AimuxConfig,
  profileName: string,
  prompt: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const profile = getProfile(config, profileName);
  const args = profile.fallback_model
    ? ['--fallback-model', profile.fallback_model, '--bg', prompt]
    : ['--bg', prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(profile.cli, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildEnv(config, profileName),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(new Error(`Failed to dispatch: ${err.message}`)));
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Stop a background session off-screen (captured stdio), keeping the TUI alive. */
export function stopSessionAsync(
  config: AimuxConfig,
  profileName: string,
  sessionShort: string,
): Promise<{ code: number; stderr: string }> {
  const profile = getProfile(config, profileName);
  return new Promise((resolve, reject) => {
    const child = spawn(profile.cli, ['stop', sessionShort], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: buildEnv(config, profileName),
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(new Error(`Failed to stop: ${err.message}`)));
    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }));
  });
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
  options: { cwd?: string; forkSession?: boolean } = {},
): Promise<number> {
  const profile = getProfile(config, profileName);
  const args = ['--resume', sessionId];
  if (options.forkSession) args.push('--fork-session');
  return new Promise((resolve, reject) => {
    const child = spawn(profile.cli, args, {
      stdio: 'inherit',
      env: buildEnv(config, profileName),
      cwd: options.cwd,
    });
    child.on('error', (err) => reject(new Error(`Failed to resume: ${err.message}`)));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
