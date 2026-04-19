import { spawnSync } from 'node:child_process';
import type { AimuxConfig } from '../types/index.js';
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

  const env: Record<string, string> = {};
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
