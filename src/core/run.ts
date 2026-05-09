import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';

export interface RunOptions {
  model?: string;
  extraArgs?: string[];
}

export interface RunParams {
  cli: string;
  args: string[];
  env: Record<string, string>;
  profilePath: string;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseDotenv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = ENV_LINE.exec(rawLine);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    // Strip a trailing inline comment for unquoted values.
    if (!/^['"]/.test(value)) {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    // Strip matching surrounding quotes.
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
        if (first === '"') {
          value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
      }
    }
    result[key] = value;
  }
  return result;
}

export function loadProfileEnv(profile: ProfileConfig, profilePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  const dotenvPath = join(profilePath, '.env');
  if (existsSync(dotenvPath)) {
    Object.assign(env, parseDotenv(readFileSync(dotenvPath, 'utf-8')));
  }
  if (profile.env) {
    Object.assign(env, profile.env);
  }
  return env;
}

export function buildRunParams(
  config: AimuxConfig,
  profileName: string,
  options: RunOptions = {},
): RunParams {
  const profile = getProfile(config, profileName);
  const profilePath = expandHome(profile.path);
  const model = options.model ?? profile.model;

  const args: string[] = [];
  if (model) {
    args.push('--model', model);
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  const env: Record<string, string> = loadProfileEnv(profile, profilePath);
  if (!profile.is_source) {
    env.CLAUDE_CONFIG_DIR = profilePath;
  }

  return {
    cli: profile.cli,
    args,
    env,
    profilePath,
  };
}

export function launchProfile(
  config: AimuxConfig,
  profileName: string,
  options: RunOptions = {},
): number {
  const params = buildRunParams(config, profileName, options);

  const result = spawnSync(params.cli, params.args, {
    stdio: 'inherit',
    env: { ...process.env, ...params.env },
  });

  if (result.error) {
    throw new Error(`Failed to launch ${params.cli}: ${result.error.message}`);
  }

  return result.status ?? 1;
}
