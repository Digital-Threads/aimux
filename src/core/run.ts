import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';

export interface RunOptions {
  model?: string;
  extraArgs?: string[];
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};

/**
 * Parse a single dotenv right-hand-side value.
 *
 * - Quoted values (`"..."` / `'...'`) end at the matching closing quote; any
 *   trailing inline comment after the closing quote is discarded.
 * - Double-quoted values decode `\n`, `\r`, `\t`, `\"`, `\\` escapes.
 * - Single-quoted values are taken literally (no escape decoding).
 * - Unquoted values strip a trailing ` #` inline comment.
 *
 * Note: `${VAR}` interpolation and multi-line values are NOT supported —
 * this is a secrets-oriented loader, not a full dotenv-expand implementation.
 */
function parseDotenvValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i];
      if (quote === '"' && ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        out += DOUBLE_QUOTE_ESCAPES[next] ?? `\\${next}`;
        i++;
        continue;
      }
      if (ch === quote) return out; // closing quote — ignore any inline comment after it
      out += ch;
    }
    return raw; // unterminated quote — treat the raw text literally
  }
  const inlineComment = raw.search(/\s#/); // whitespace + '#' starts a comment
  return (inlineComment >= 0 ? raw.slice(0, inlineComment) : raw).trimEnd();
}

/**
 * Parse the contents of a dotenv file into a key/value map.
 *
 * Supports `KEY=value`, `export KEY=value`, `# comments`, blank lines,
 * single/double-quoted values, escape sequences inside double quotes only,
 * and trailing inline comments on both quoted and unquoted values.
 */
export function parseDotenv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = ENV_LINE.exec(rawLine);
    if (!match) continue;
    result[match[1]] = parseDotenvValue(match[2]);
  }
  return result;
}

/**
 * Resolve the environment variables injected into the spawned CLI for a
 * profile. Merges the profile's `<path>/.env` dotenv file with the optional
 * `env:` block from config.yaml; the YAML block wins on key conflict.
 */
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
  const userPassedFallback = extraArgs.some((a) => a === '--fallback-model');

  const args: string[] = [];
  if (model && !isSubcommand && !userPassedModel) {
    args.push('--model', model);
  }
  if (profile.fallback_model && !isSubcommand && !userPassedFallback) {
    args.push('--fallback-model', profile.fallback_model);
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
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
): Promise<number> {
  const params = buildRunParams(config, profileName, options);

  if (process.env.AIMUX_DEBUG) {
    process.stderr.write(
      `[aimux-diag] cli=${params.cli} args=${JSON.stringify(params.args)}\n` +
      `[aimux-diag] tty: stdin=${process.stdin.isTTY} stdout=${process.stdout.isTTY} stderr=${process.stderr.isTTY}\n` +
      `[aimux-diag] cwd=${process.cwd()}\n` +
      `[aimux-diag] CLAUDE_CONFIG_DIR=${params.env.CLAUDE_CONFIG_DIR ?? '(not set, inherits)'}\n` +
      `[aimux-diag] TERM=${process.env.TERM}\n`
    );
  }

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

export interface HeadlessOptions extends RunOptions {
  /** Stamped into the spawned session env as LOOM_TASK_ID (spine link). */
  taskId?: string;
  /** Stamped into the spawned session env as LOOM_WORKFLOW_ID (spine link). */
  workflowId?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
}

export interface HeadlessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Non-interactive launch: pipes stdio and captures stdout/stderr/exit instead of
 * inheriting the terminal. `launchProfile` stays the interactive path, untouched.
 *
 * Injects LOOM_TASK_ID / LOOM_WORKFLOW_ID into the spawned session's env so that
 * token-pilot and task-journal running inside it can tie their telemetry to the same
 * task — the shared-ID "spine". CLI-agnostic: the caller supplies the print/prompt
 * flags via `extraArgs` (e.g. `['-p', prompt]`), so this works for any AI CLI.
 */
export function runProfileHeadless(
  config: AimuxConfig,
  profileName: string,
  options: HeadlessOptions = {},
): Promise<HeadlessResult> {
  const params = buildRunParams(config, profileName, options);
  const env: NodeJS.ProcessEnv = { ...process.env, ...params.env };
  if (options.taskId) env.LOOM_TASK_ID = options.taskId;
  if (options.workflowId) env.LOOM_WORKFLOW_ID = options.workflowId;

  return new Promise((resolve, reject) => {
    const child = spawn(params.cli, params.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: options.cwd,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to launch ${params.cli}: ${err.message}`));
    });

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();

    // 'close' fires after stdio streams are flushed, so captured output is complete.
    child.on('close', (code, signal) => {
      const exitCode = signal
        ? 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1)
        : code ?? 1;
      resolve({ exitCode, stdout, stderr });
    });
  });
}
