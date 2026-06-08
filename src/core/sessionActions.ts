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

/**
 * Swallow any buffered/in-flight terminal-query response (e.g. a Device-
 * Attributes reply `\x1b[?...c`) before handing the tty to an interactive child,
 * so it isn't read as typed input (the stray ";...c" in the prompt on re-attach).
 *
 * CRITICAL: we briefly raw + resume + consume, then **pause()** and lower raw
 * again so stdin is left in a clean, non-flowing state. An earlier version
 * omitted the pause() and left stdin flowing, which broke the next Ink mount's
 * raw-mode grab and froze the TUI on return. Keep the pause().
 */
function prepareTtyForHandoff(): Promise<void> {
  const s = process.stdin;
  if (!s.isTTY || typeof s.setRawMode !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    const swallow = (): void => {
      /* discard query-response bytes */
    };
    try {
      s.setRawMode(true);
      s.on('data', swallow);
      s.resume();
    } catch {
      // best-effort
    }
    setTimeout(() => {
      try {
        s.off('data', swallow);
        s.pause();
        s.setRawMode(false);
      } catch {
        // best-effort
      }
      resolve();
    }, 120);
  });
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

export async function resumeSession(
  config: AimuxConfig,
  profileName: string,
  sessionId: string,
  options: { cwd?: string; forkSession?: boolean } = {},
): Promise<number> {
  const profile = getProfile(config, profileName);
  const args = ['--resume', sessionId];
  if (options.forkSession) args.push('--fork-session');
  await prepareTtyForHandoff();
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
