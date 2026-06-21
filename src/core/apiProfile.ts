import { writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from './run.js';

/**
 * Default Claude model IDs offered when configuring a 3rd-party API profile.
 * Used both as the prompt placeholders and as the fallback when the user
 * accepts the default by entering nothing.
 */
export const API_MODEL_DEFAULTS = {
  ANTHROPIC_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
} as const;

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  /** Model mapped to ANTHROPIC_MODEL / opus / sonnet / haiku. Third-party providers
   *  usually expose one strong model; the small one (if any) maps to haiku/subagent. */
  models: { default: string; opus: string; sonnet: string; haiku: string };
}

/**
 * Ready-made Anthropic-compatible providers that run on the claude CLI by only
 * changing ANTHROPIC_BASE_URL + token. Base URLs are stable; model names drift, so
 * update with `aimux profile update <name> -e ANTHROPIC_MODEL=…` when a provider
 * renames. (Verified 2026-06.)
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: { default: 'deepseek-chat', opus: 'deepseek-reasoner', sonnet: 'deepseek-chat', haiku: 'deepseek-chat' },
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    models: { default: 'kimi-k2.5', opus: 'kimi-k2.5', sonnet: 'kimi-k2.5', haiku: 'kimi-k2.5' },
  },
  glm: {
    label: 'GLM (Z.ai)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    models: { default: 'glm-5.1', opus: 'glm-5.1', sonnet: 'glm-5.1', haiku: 'glm-4.5-air' },
  },
  qwen: {
    label: 'Qwen (Alibaba DashScope)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    models: { default: 'qwen3.6-plus', opus: 'qwen3.6-plus', sonnet: 'qwen3.6-plus', haiku: 'qwen3.6-plus' },
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    models: { default: 'minimax-m2.7', opus: 'minimax-m2.7', sonnet: 'minimax-m2.7', haiku: 'minimax-m2.7' },
  },
  mimo: {
    label: 'Xiaomi MiMo',
    baseUrl: 'https://api.xiaomimimo.com',
    models: { default: 'mimo-v2-pro', opus: 'mimo-v2-pro', sonnet: 'mimo-v2-pro', haiku: 'mimo-v2-pro' },
  },
};

/** The dotenv vars for a provider preset (+ token if given). Pure — used by both the
 *  interactive `--provider` flow and tests. */
export function providerEnv(preset: ProviderPreset, token?: string): Record<string, string> {
  const vars: Record<string, string> = {
    ANTHROPIC_BASE_URL: preset.baseUrl,
    ANTHROPIC_MODEL: preset.models.default,
    ANTHROPIC_DEFAULT_OPUS_MODEL: preset.models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: preset.models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: preset.models.haiku,
  };
  if (token) vars.ANTHROPIC_AUTH_TOKEN = token;
  return vars;
}

/**
 * Sequential line reader over a single stdin consumer. Reading multiple
 * prompts via repeated `readline.createInterface()` drops buffered input on
 * close (breaks piped/non-TTY), and muting readline's output writer stalls
 * its `question()` promise on Node 22+. This reader owns one `data` handler
 * and an explicit buffer, so no line is ever lost and secrets can be masked.
 *
 * - TTY: raw mode, echoes printable input (masked with `*` when `secret`),
 *   handles Enter, Backspace/Delete, and Ctrl+C.
 * - non-TTY (pipes/tests): splits incoming chunks on newlines; masking is a
 *   no-op since nothing is echoed.
 */
class StdinLineReader {
  private readonly stdin = process.stdin;
  private readonly isTTY = Boolean(process.stdin.isTTY);
  private buffer = '';
  private readonly completed: string[] = [];
  private waiter: { secret: boolean; resolve: (line: string) => void } | null = null;
  private attached = false;

  private ended = false;
  private lastWasCR = false;

  private readonly onData = (chunk: string): void => {
    if (this.isTTY) {
      this.consumeTty(chunk);
    } else {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        this.completed.push(this.buffer.slice(0, nl).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(nl + 1);
      }
    }
    this.flush();
  };

  // On EOF (piped input with no trailing newline), surface the last partial
  // line and let any still-pending prompts resolve empty so defaults apply.
  private readonly onEnd = (): void => {
    this.ended = true;
    if (this.buffer.length > 0) {
      this.completed.push(this.buffer);
      this.buffer = '';
    }
    this.flush();
  };

  private consumeTty(chunk: string): void {
    for (const ch of chunk) {
      const wasCR = this.lastWasCR;
      this.lastWasCR = false;
      if (ch === '\r' || ch === '\n') {
        // Coalesce CRLF: a '\n' right after a '\r' is the same Enter press,
        // not a second (empty) line. Without this the next prompt resolves
        // empty and every later answer shifts up by one field.
        if (ch === '\n' && wasCR) continue;
        this.lastWasCR = ch === '\r';
        process.stdout.write('\n');
        this.completed.push(this.buffer);
        this.buffer = '';
      } else if (ch === '\u0003') { // Ctrl+C
        this.detach();
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          if (!this.waiter?.secret) process.stdout.write('\b \b');
        }
      } else if (ch >= ' ') {
        this.buffer += ch;
        process.stdout.write(this.waiter?.secret ? '*' : ch);
      }
    }
  }

  private flush(): void {
    while (this.waiter && this.completed.length > 0) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(this.completed.shift()!);
    }
    if (this.ended && this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve('');
    }
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    if (this.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', this.onData);
    this.stdin.on('end', this.onEnd);
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.stdin.removeListener('data', this.onData);
    this.stdin.removeListener('end', this.onEnd);
    if (this.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  question(query: string, secret = false): Promise<string> {
    this.attach();
    process.stdout.write(query);
    return new Promise((resolve) => {
      this.waiter = { secret, resolve: (line) => resolve(line.trim()) };
      this.flush();
    });
  }

  close(): void {
    this.detach();
  }
}

/**
 * Interactively collect 3rd-party API endpoint credentials. Returns the env
 * var map to persist to the profile's `.env`. The auth token is read with no
 * echo; model fields fall back to {@link API_MODEL_DEFAULTS} when left blank.
 */
export async function collectApiCredentials(): Promise<Record<string, string>> {
  // label is padded so the `[default]` hints line up in the terminal.
  const MODEL_PROMPTS: ReadonlyArray<[key: keyof typeof API_MODEL_DEFAULTS, label: string]> = [
    ['ANTHROPIC_MODEL', 'Default model'],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'Opus model   '],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'Sonnet model '],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'Haiku model  '],
  ];

  const reader = new StdinLineReader();
  try {
    const vars: Record<string, string> = {};

    const baseUrl = await reader.question('  Base URL:                          ');
    if (baseUrl) vars.ANTHROPIC_BASE_URL = baseUrl;

    const authToken = await reader.question('  Auth token:                        ', true);
    if (authToken) vars.ANTHROPIC_AUTH_TOKEN = authToken;

    for (const [key, label] of MODEL_PROMPTS) {
      const fallback = API_MODEL_DEFAULTS[key];
      const answer = await reader.question(`  ${label} [${fallback}]: `);
      vars[key] = answer || fallback;
    }

    return vars;
  } finally {
    reader.close();
  }
}

/**
 * Provider-preset flow: fills base URL + model mapping from {@link PROVIDER_PRESETS}
 * and prompts ONLY for the API token. Returns the env var map to persist.
 */
export async function collectProviderCredentials(preset: ProviderPreset): Promise<Record<string, string>> {
  const reader = new StdinLineReader();
  try {
    const token = await reader.question(`  ${preset.label} API token:  `, true);
    return providerEnv(preset, token || undefined);
  } finally {
    reader.close();
  }
}

/**
 * Seed a minimal `.claude.json` for an API profile so Claude Code skips its
 * first-run onboarding/OAuth flow and goes straight to the API endpoint
 * configured via env. No-op if the file already exists (never clobbers a real
 * one). Written chmod 600 alongside the profile's `.env`.
 */
export function seedApiClaudeJson(profilePath: string): boolean {
  const target = join(profilePath, '.claude.json');
  if (existsSync(target)) return false;
  writeFileSync(target, JSON.stringify({ hasCompletedOnboarding: true }, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return true;
}

/** Quote a dotenv value only when it contains characters that need it. */
function serializeDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Write a profile's `.env` file with `chmod 600` so secrets are not
 * world-readable. Overwrites any existing file.
 */
export function writeProfileDotEnv(profilePath: string, vars: Record<string, string>): void {
  const lines = ['# Generated by aimux — do not commit', ''];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}=${serializeDotenvValue(value)}`);
  }
  const target = join(profilePath, '.env');
  writeFileSync(target, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync's mode only applies on creation; chmod so an overwrite of an
  // existing looser-permission file (e.g. a hand-written 0644 .env) is tightened too.
  chmodSync(target, 0o600);
}

/**
 * Apply `KEY=VALUE` sets and key unsets to a profile's `.env` file in place,
 * preserving existing entries. Re-writes with `chmod 600`. Returns the keys
 * that were set and unset for reporting.
 */
export function mergeProfileDotEnv(
  profilePath: string,
  set: string[],
  unset: string[],
): { set: string[]; unset: string[] } {
  const dotenvPath = join(profilePath, '.env');
  const vars = existsSync(dotenvPath) ? parseDotenv(readFileSync(dotenvPath, 'utf-8')) : {};

  const setKeys: string[] = [];
  for (const pair of set) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`Invalid env assignment '${pair}': expected KEY=VALUE`);
    const key = pair.slice(0, eq).trim();
    vars[key] = pair.slice(eq + 1);
    setKeys.push(key);
  }
  for (const key of unset) delete vars[key];

  writeProfileDotEnv(profilePath, vars);
  return { set: setKeys, unset };
}

/**
 * Return a warning string if the profile's `.env` is readable beyond the
 * owner (mode has group/other bits set), else null. Lets callers nudge users
 * toward `chmod 600` the way docker warns about loose key permissions.
 */
export function checkDotenvPermissions(profilePath: string): string | null {
  const dotenvPath = join(profilePath, '.env');
  try {
    const mode = statSync(dotenvPath).mode & 0o777;
    if (mode & 0o077) {
      return `${dotenvPath} is readable by group/other (mode ${mode.toString(8).padStart(3, '0')}). Run: chmod 600 ${dotenvPath}`;
    }
  } catch {
    // no .env or not stat-able — nothing to warn about
  }
  return null;
}
