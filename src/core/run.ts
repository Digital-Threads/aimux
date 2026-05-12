import { spawn } from 'node:child_process';
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

const SUBCOMMAND_TOKEN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function looksLikeSubcommand(arg: string | undefined): boolean {
  if (!arg) return false;
  if (arg.startsWith('-')) return false;
  return SUBCOMMAND_TOKEN.test(arg);
}

export function buildRunParams(
  config: AimuxConfig,
  profileName: string,
  options: RunOptions = {},
): RunParams {
  const profile = getProfile(config, profileName);
  const profilePath = expandHome(profile.path);
  const model = options.model ?? profile.model;

  const extraArgs = options.extraArgs ?? [];
  const firstExtra = extraArgs[0];
  const isSubcommand = looksLikeSubcommand(firstExtra);
  const userPassedModel = extraArgs.some((a) => a === '--model' || a === '-m');

  const args: string[] = [];
  if (model && !isSubcommand && !userPassedModel) {
    args.push('--model', model);
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
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
): Promise<number> {
  const params = buildRunParams(config, profileName, options);

  return new Promise((resolve, reject) => {
    const child = spawn(params.cli, params.args, {
      stdio: 'inherit',
      env: { ...process.env, ...params.env },
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to launch ${params.cli}: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
