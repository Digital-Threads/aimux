// Live session — a long-lived, multi-turn Claude session under a profile.
//
// This is the persistent sibling of `runProfileHeadless` (one-shot): instead of
// running one prompt and exiting, it keeps ONE process alive and lets the caller
// send turn after turn over the verified stream-json protocol. It OWNS every
// Claude-CLI detail (the `-p` print flags, stream-json framing, `--session-id` /
// `--resume`, `--settings` / `--mcp-config` / permission flags) so a consumer
// asks for a *session on a profile*, never a command line.
//
// Verified protocol: `claude -p --verbose --input-format stream-json
// --output-format stream-json --session-id <uuid>`; an input line is
// {"type":"user","message":{role,content}}; a turn ends on a {"type":"result"}
// event carrying the text + total_cost_usd + permission_denials.

import { spawn, type ChildProcess } from 'child_process';
import { buildRunParams } from './run.js';
import type { AimuxConfig } from '../types/index.js';

// The headless multi-turn protocol flags. Owned here, never exposed to callers.
const STREAM_FLAGS = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'];

/** Max wait for one reply before the session is killed and the turn resolves with
 *  a timeout marker — a stuck agent must not hang the caller forever. */
const DEFAULT_REPLY_TIMEOUT_MS = 10 * 60_000;

export interface OpenSessionOptions {
  /** Model for THIS session (a session's model is fixed at spawn). */
  model?: string;
  /** Stable id: created with `--session-id`, recovered with `--resume`. */
  sessionId: string;
  /** The session already exists in Claude (e.g. recovering after a host restart),
   *  so the first send must `--resume` instead of creating it. */
  resume?: boolean;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Extra env merged over the profile env (e.g. spine ids). */
  env?: Record<string, string>;
  /** Spine link — stamped as LOOM_TASK_ID (same as runProfileHeadless). */
  taskId?: string;
  /** Spine link — stamped as LOOM_WORKFLOW_ID. */
  workflowId?: string;
  /** A settings file to load (→ `--settings <path>`). The caller supplies the
   *  path/content; aimux only knows the flag. */
  settingsPath?: string;
  /** An MCP run-config file (→ `--mcp-config <path>`). */
  mcpConfigPath?: string;
  /** Auto-allowed tools (→ `--allowedTools=<csv>` as one arg, never flag-shaped). */
  allowedTools?: string[];
  /** Full access — `--dangerously-skip-permissions`. The caller owns the policy. */
  bypassPermissions?: boolean;
  /** Override the reply watchdog (tests). */
  replyTimeoutMs?: number;
  /** Spawn function (injectable for tests). Default: node child_process spawn. */
  spawnFn?: typeof spawn;
}

export interface SessionEvent {
  /** 'assistant' = streamed text / tool activity; 'result' = turn finished. */
  kind: 'assistant' | 'result' | 'other';
  /** assistant: text + readable tool lines; result: the final reply text. */
  text?: string;
  raw: unknown;
}

export interface TurnResult {
  text: string;
  costUsd: number;
  denials: string[];
}

export interface LiveSession {
  /** Send one turn; resolves when the turn's `result` event arrives. `onEvent`
   *  streams assistant text/tool activity as it comes. */
  send(text: string, onEvent?: (e: SessionEvent) => void): Promise<TurnResult>;
  /** Inject guidance into the LIVE turn without awaiting (intervene). */
  interject(text: string): boolean;
  /** Move this session to another profile/account (e.g. rate-limit recovery):
   *  stop the current process and re-attach under the new profile via `--resume`,
   *  preserving the conversation. */
  relocate(toProfile: string): void;
  /** Accumulated cost (sum of per-turn total_cost_usd). */
  cost(): number;
  /** Tools the agent tried to use but were denied (await approval). */
  denials(): string[];
  /** Stop the process. */
  close(): void;
}

function userMessage(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

/** Build the full args for a live session: the profile/model (buildRunParams) +
 *  the protocol flags + the translated option flags + the session id/resume. */
export function buildSessionArgs(
  config: AimuxConfig,
  profileName: string,
  opts: OpenSessionOptions,
  resume: boolean,
): { cli: string; args: string[]; env: Record<string, string> } {
  const extra: string[] = [...STREAM_FLAGS];
  if (opts.settingsPath) extra.push('--settings', opts.settingsPath);
  if (opts.mcpConfigPath) extra.push('--mcp-config', opts.mcpConfigPath);
  if (opts.bypassPermissions) extra.push('--dangerously-skip-permissions');
  else if (opts.allowedTools && opts.allowedTools.length) extra.push(`--allowedTools=${opts.allowedTools.join(',')}`);
  // Session lifecycle: create with --session-id, recover with --resume.
  extra.push(...(resume ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId]));
  const params = buildRunParams(config, profileName, { model: opts.model, extraArgs: extra });
  const env: Record<string, string> = { ...params.env, ...(opts.env ?? {}) };
  if (opts.taskId) env.LOOM_TASK_ID = opts.taskId;
  if (opts.workflowId) env.LOOM_WORKFLOW_ID = opts.workflowId;
  return { cli: params.cli, args: params.args, env };
}

/** Summarise an assistant message: its text PLUS a readable line per tool call,
 *  so a long turn (lots of tool use) doesn't look dead on the stream. */
function summarizeAssistant(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; text?: unknown; name?: unknown; input?: unknown };
    if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text);
    else if (blk.type === 'tool_use') parts.push(`→ ${toolLabel(blk.name, blk.input)}`);
  }
  return parts.join('\n');
}

function toolLabel(name: unknown, input: unknown): string {
  const n = typeof name === 'string' ? name : 'tool';
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const raw = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description ?? o.prompt;
  const arg = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  const brief = arg.length > 80 ? `${arg.slice(0, 80)}…` : arg;
  return brief ? `${n}: ${brief}` : n;
}

function denialLabel(d: unknown): string {
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    const o = d as { tool_name?: string; tool?: string; name?: string };
    return o.tool_name ?? o.tool ?? o.name ?? JSON.stringify(d);
  }
  return String(d);
}

/**
 * Open a long-lived multi-turn session under `profileName`. The process is
 * spawned lazily on the first `send` (and re-spawned with `--resume` if it dies
 * or the session is relocated to another profile).
 */
export function openSession(config: AimuxConfig, profileName: string, opts: OpenSessionOptions): LiveSession {
  const spawnFn = opts.spawnFn ?? spawn;
  const replyTimeout = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;

  let profile = profileName;
  let proc: ChildProcess | null = null;
  let buf = '';
  let pending: ((r: TurnResult) => void) | null = null;
  let curEvent: ((e: SessionEvent) => void) | undefined;
  let totalCost = 0;
  const denialSet: string[] = [];
  // First send creates the session (--session-id); afterwards it recovers (--resume).
  // resume=true means the session already exists in Claude (e.g. recovering after a
  // host restart) — so the very first send must --resume, not re-create.
  let everSpawned = !!opts.resume;

  function settle(text: string, cost = 0, denials: string[] = []): void {
    const p = pending;
    pending = null;
    p?.({ text, costUsd: cost, denials });
  }

  function onData(d: Buffer | string): void {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev: { type?: string; result?: string; total_cost_usd?: number; permission_denials?: unknown[]; message?: { content?: unknown } };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') {
        const s = summarizeAssistant(ev.message?.content);
        if (s) curEvent?.({ kind: 'assistant', text: s, raw: ev });
      } else if (ev.type === 'result') {
        if (typeof ev.total_cost_usd === 'number') totalCost += ev.total_cost_usd;
        const turnDenials: string[] = [];
        for (const d of ev.permission_denials ?? []) {
          const t = denialLabel(d);
          if (!denialSet.includes(t)) denialSet.push(t);
          turnDenials.push(t);
        }
        const text = ev.result ?? '';
        curEvent?.({ kind: 'result', text, raw: ev });
        settle(text, ev.total_cost_usd ?? 0, turnDenials);
      } else {
        curEvent?.({ kind: 'other', raw: ev });
      }
    }
  }

  function ensure(): ChildProcess {
    if (proc) return proc;
    const resume = everSpawned; // dead/relocated → recover the same session id
    const { cli, args, env } = buildSessionArgs(config, profile, opts, resume);
    const child = spawnFn(cli, args, { cwd: opts.cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    everSpawned = true;
    proc = child;
    buf = '';
    child.stdout?.on('data', onData);
    // A dead/errored process must settle any awaiting send (else send() hangs);
    // the next send respawns via --resume.
    child.on('close', () => { proc = null; settle('⚠ The agent process ended before replying. Re-run the stage.'); });
    child.on('error', () => { proc = null; settle('⚠ The agent process errored. Re-run the stage.'); });
    return child;
  }

  return {
    send(text, onEvent) {
      const child = ensure();
      curEvent = onEvent;
      return new Promise<TurnResult>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        pending = (r: TurnResult) => { clearTimeout(timer); resolve(r); };
        timer = setTimeout(() => {
          pending = null;
          try { child.kill(); } catch { /* best-effort */ }
          proc = null;
          resolve({ text: '⏱ The agent did not respond within the time limit — the session was stopped. Re-run the stage or switch the subscription.', costUsd: 0, denials: [] });
        }, replyTimeout);
        child.stdin?.write(userMessage(text));
      });
    },
    interject(text) {
      if (!proc) return false;
      proc.stdin?.write(userMessage(text));
      return true;
    },
    relocate(toProfile) {
      // Switch account: stop the current process; the next send re-spawns under
      // the new profile via --resume, continuing the same conversation.
      if (proc) { try { proc.stdin?.end(); proc.kill(); } catch { /* best-effort */ } proc = null; }
      profile = toProfile;
    },
    cost: () => totalCost,
    denials: () => denialSet.slice(),
    close() {
      if (proc) { try { proc.stdin?.end(); proc.kill(); } catch { /* best-effort */ } proc = null; }
    },
  };
}
