import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';
import { adapterFor } from './adapters/index.js';

export interface RunOptions {
  model?: string;
  extraArgs?: string[];
  /** Called with the CLI's pid right after it starts (interactive launches only). */
  onSpawn?: (pid: number) => void;
  /** Extra variables for this launch, over the profile's own. */
  env?: Record<string, string>;
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

export { looksLikeSubcommand } from './subcommand.js';

/**
 * The environment a profile's CLI starts from: this process's own, minus whatever
 * belongs to a different profile.
 *
 * Another profile's identity arrives two ways: `aimux use` exported it into the shell
 * (and listed it in AIMUX_MANAGED), or aimux runs inside a session it launched earlier
 * (CLAUDE_CONFIG_DIR is set for that session). A non-source profile overwrites its
 * config-dir variable anyway; the source profile sets none, so it inherited the other
 * profile's dir — `aimux run main` after `aimux use dt` logged in as dt.
 */
export function baseEnvFor(
  profile: ProfileConfig,
  profilePath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...env };

  for (const key of (env.AIMUX_MANAGED ?? '').split(/\s+/)) {
    if (key) delete base[key];
  }

  // A config-dir variable pointing anywhere but this profile's own dir is someone
  // else's. One pointing at our own dir stays: that is how a source relocated with
  // CLAUDE_CONFIG_DIR keeps working.
  for (const [key, ownDir] of Object.entries(adapterFor(profile.cli).configDirEnv(profilePath, false))) {
    const inherited = base[key];
    if (inherited && resolve(expandHome(inherited)) !== resolve(ownDir)) delete base[key];
  }

  return base;
}

export function buildRunParams(
  config: AimuxConfig,
  profileName: string,
  options: RunOptions = {},
): RunParams {
  const profile = getProfile(config, profileName);
  const profilePath = expandHome(profile.path);
  const model = options.model ?? profile.model;
  const adapter = adapterFor(profile.cli);

  const extraArgs = options.extraArgs ?? [];
  const firstExtra = extraArgs[0];
  const isSubcommand = adapter.isSubcommand(firstExtra);
  const userPassedModel = extraArgs.some((a) => a === '--model' || a === '-m');
  const userPassedFallback = extraArgs.some((a) => a === '--fallback-model');

  const args: string[] = adapter.globalArgs(firstExtra);
  args.push(...adapter.modelArgs({
    model,
    fallbackModel: profile.fallback_model,
    isSubcommand,
    userPassedModel,
    userPassedFallback,
  }));
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  const env: Record<string, string> = loadProfileEnv(profile, profilePath);
  Object.assign(env, adapter.configDirEnv(profilePath, profile.is_source === true));

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

  const baseEnv = baseEnvFor(getProfile(config, profileName), params.profilePath);

  return new Promise((resolve, reject) => {
    const child = spawn(params.cli, params.args, {
      stdio: 'inherit',
      env: { ...baseEnv, ...params.env, ...options.env },
    });
    if (child.pid !== undefined) options.onSpawn?.(child.pid);

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
  const env: NodeJS.ProcessEnv = { ...baseEnvFor(getProfile(config, profileName), params.profilePath), ...params.env, ...options.env };
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
