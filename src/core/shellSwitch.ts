import type { AimuxConfig } from '../types/index.js';
import { buildRunParams } from './run.js';

export type SupportedShell = 'bash' | 'zsh' | 'fish';

/**
 * Detect the user's shell from `$SHELL`, falling back to bash. Only the basename
 * is inspected so `/usr/local/bin/zsh` resolves to `zsh`.
 */
export function detectShell(shellPath: string | undefined): SupportedShell {
  const name = (shellPath ?? '').split('/').pop() ?? '';
  if (name.includes('fish')) return 'fish';
  if (name.includes('zsh')) return 'zsh';
  return 'bash';
}

/**
 * Resolve an explicit `--shell` value, or fall back to {@link detectShell}.
 * Throws on an unsupported value so a typo fails loudly instead of silently
 * emitting POSIX syntax into a shell that can't run it.
 */
export function parseShell(value: string | undefined, shellPath: string | undefined): SupportedShell {
  if (!value) return detectShell(shellPath);
  if (value === 'bash' || value === 'zsh' || value === 'fish') return value;
  throw new Error(`Unsupported --shell '${value}'. Use bash, zsh, or fish.`);
}

/**
 * Resolve the env var map that "activating" a profile injects into a shell.
 * Reuses {@link buildRunParams} so the switch path stays byte-identical to what
 * `aimux run` would export — adapter decides CLAUDE_CONFIG_DIR vs CODEX_HOME,
 * plus any profile `.env` (ANTHROPIC_BASE_URL, tokens, model overrides).
 */
export function buildSwitchEnv(config: AimuxConfig, profileName: string): Record<string, string> {
  return buildRunParams(config, profileName).env;
}

/** Single-quote a value for POSIX shells, escaping embedded single quotes. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a value for fish, escaping backslashes then single quotes. */
function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, `\\'`)}'`;
}

export interface RenderExportsOptions {
  env: Record<string, string>;
  profileName: string;
  /** Keys aimux set on the previous `use` (from `$AIMUX_MANAGED`), unset first. */
  previousManaged?: string;
  shell: SupportedShell;
}

/**
 * Render the shell script that `eval`'d into the current shell activates a
 * profile: unset the previously-managed keys, export the new ones, and record
 * the active profile + managed key list so the next switch can clean up.
 */
export function renderShellExports({ env, profileName, previousManaged, shell }: RenderExportsOptions): string {
  const keys = Object.keys(env);
  // Invariant: every entry is a bare env-var name (no spaces) — cleanup re-parses
  // `$AIMUX_MANAGED` by splitting on whitespace, so a spaced value would strand
  // stale keys and leak the previous profile's credentials across a switch.
  const managed = [...keys, 'AIMUX_PROFILE'];
  const stale = (previousManaged ?? '')
    .split(/\s+/)
    .filter((k) => k && !managed.includes(k));

  const lines: string[] = [];
  if (shell === 'fish') {
    for (const key of stale) lines.push(`set -e ${key}`);
    for (const key of keys) lines.push(`set -gx ${key} ${fishQuote(env[key])}`);
    lines.push(`set -gx AIMUX_PROFILE ${fishQuote(profileName)}`);
    lines.push(`set -gx AIMUX_MANAGED ${fishQuote(managed.join(' '))}`);
  } else {
    if (stale.length > 0) lines.push(`unset ${stale.join(' ')}`);
    for (const key of keys) lines.push(`export ${key}=${posixQuote(env[key])}`);
    lines.push(`export AIMUX_PROFILE=${posixQuote(profileName)}`);
    lines.push(`export AIMUX_MANAGED=${posixQuote(managed.join(' '))}`);
  }
  return lines.join('\n');
}

/**
 * Render the shell snippet for the user's rc file. It wraps the real binary so
 * `aimux use <profile>` evaluates the exports in the current shell, while every
 * other subcommand passes straight through.
 */
export function renderShellInit(shell: SupportedShell): string {
  if (shell === 'fish') {
    return [
      'function aimux',
      '    if test "$argv[1]" = "use"',
      '        eval (command aimux use $argv[2..-1] --export --shell fish | string collect)',
      '    else',
      '        command aimux $argv',
      '    end',
      'end',
    ].join('\n');
  }
  // bash / zsh share POSIX function syntax.
  return [
    'aimux() {',
    '  if [ "$1" = "use" ]; then',
    '    shift',
    '    local _aimux_out',
    '    _aimux_out="$(command aimux use "$@" --export)" || return $?',
    '    eval "$_aimux_out"',
    '  else',
    '    command aimux "$@"',
    '  fi',
    '}',
  ].join('\n');
}
