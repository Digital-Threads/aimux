import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import { setAimuxDir } from './paths.js';
import { summarizeUsage } from './usage.js';

// A codex rollout: { timestamp, type, payload }. session_meta carries the id,
// turn_context the model, and event_msg/token_count the cumulative usage.
const UUID = '019c6198-5b6e-7671-b79c-2e3c96f32d95';

function rolloutLines(model: string, total: Record<string, number>): string {
  return [
    { timestamp: '2026-06-28T10:00:00.000Z', type: 'session_meta', payload: { id: UUID, cwd: '/tmp/proj' } },
    { timestamp: '2026-06-28T10:00:01.000Z', type: 'turn_context', payload: { cwd: '/tmp/proj', model } },
    { timestamp: '2026-06-28T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } },
    { timestamp: '2026-06-28T10:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: total } } },
  ].map((l) => JSON.stringify(l)).join('\n');
}

describe('codex usage in summarizeUsage', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aimux-codex-usage-'));
    setAimuxDir(join(dir, 'aimux')); // isolate history/profile-map lookups
    const rolloutDir = join(dir, 'codex', 'sessions', '2026', '06', '28');
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, `rollout-2026-06-28T10-00-00-${UUID}.jsonl`),
      rolloutLines('gpt-5-codex', {
        input_tokens: 10000, cached_input_tokens: 4000, output_tokens: 2000,
        reasoning_output_tokens: 500, total_tokens: 12000,
      }),
    );
  });

  afterEach(() => {
    setAimuxDir('');
    rmSync(dir, { recursive: true, force: true });
  });

  function config(): AimuxConfig {
    return {
      version: 1,
      shared_source: join(dir, 'claude-empty'),
      shared_sources: { codex: join(dir, 'codex') },
      profiles: { cx: { cli: 'codex', path: join(dir, 'profiles', 'cx') } },
      private: [],
    };
  }

  it('maps codex token_count into the usage buckets (cached split out) and prices it', () => {
    const summaries = summarizeUsage(config());
    // Unattributed (not in history) → lands under the 'unknown' profile, like claude.
    const u = summaries.find((s) => s.profile === 'unknown');
    expect(u).toBeDefined();
    expect(u!.cacheReadInputTokens).toBe(4000);     // cached_input_tokens
    expect(u!.inputTokens).toBe(6000);              // input_tokens - cached
    expect(u!.cacheCreationInputTokens).toBe(0);    // codex reports no cache writes
    expect(u!.outputTokens).toBe(2000);
    expect(u!.estimatedCostUsd).toBeGreaterThan(0); // gpt-5-codex is priced, not $0
  });

  // One model call: the running total after it, and what the call itself spent (all output).
  const call = (at: string, total: number, output: number) => JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: output } } },
  });
  const header = (payload: object) => JSON.stringify({ type: 'session_meta', payload });
  const day = () => join(dir, 'codex', 'sessions', '2026', '06', '28');
  const OTHER = '019c6198-5b6e-7671-b79c-aaaaaaaaaaaa';
  const FORK = '019c6198-5b6e-7671-b79c-bbbbbbbbbbbb';

  it('does not count the calls a forked session copied from its parent', () => {
    // A fork's rollout: its own header, the parent's, the parent's calls under the moment
    // of the fork, then what the fork itself did.
    writeFileSync(join(day(), `rollout-2026-06-28T12-00-00-${OTHER}.jsonl`), [
      header({ id: OTHER, cwd: '/srv/root' }),
      call('2026-06-01T08:00:00.000Z', 7, 7),
      call('2026-06-02T08:00:00.000Z', 37, 30),
    ].join('\n'));
    writeFileSync(join(day(), `rollout-2026-06-28T13-00-00-${FORK}.jsonl`), [
      header({ id: FORK, forked_from_id: OTHER, cwd: '/srv/root' }),
      header({ id: OTHER, cwd: '/srv/root' }),
      call('2026-06-28T13:00:01.000Z', 7, 7),
      call('2026-06-28T13:00:01.500Z', 37, 30),
      call('2026-06-28T13:05:00.000Z', 537, 500),
    ].join('\n'));

    const u = summarizeUsage(config()).find((s) => s.profile === 'unknown')!;
    expect(u.outputTokens).toBe(2000 + 7 + 30 + 500);
    expect(u.requests).toBe(1 + 2 + 1);
  });

  it('leaves the copied calls out even when the parent lies outside the window asked for', () => {
    const old = join(day(), `rollout-2026-06-01T08-00-00-${OTHER}.jsonl`);
    writeFileSync(old, [header({ id: OTHER }), call('2026-06-01T08:00:00.000Z', 7, 7)].join('\n'));
    utimesSync(old, new Date('2026-06-01T08:00:00Z'), new Date('2026-06-01T08:00:00Z'));
    writeFileSync(join(day(), `rollout-2026-06-28T13-00-00-${FORK}.jsonl`), [
      header({ id: FORK, forked_from_id: OTHER }),
      call('2026-06-28T13:00:01.000Z', 7, 7),
      call('2026-06-28T13:05:00.000Z', 507, 500),
    ].join('\n'));

    // The parent was last written before the window opened; the copy is stamped inside it.
    const u = summarizeUsage(config(), { sinceMs: Date.parse('2026-06-20T00:00:00Z') }).find((s) => s.profile === 'unknown')!;
    expect(u.outputTokens).toBe(2000 + 500);
  });

  it('credits a subagent to whoever typed into the thread that started it', () => {
    writeFileSync(join(day(), `rollout-2026-06-28T12-00-00-${OTHER}.jsonl`), [
      header({ id: OTHER, parent_thread_id: UUID }),
      call('2026-06-28T12:10:05.000Z', 30, 30),
    ].join('\n'));
    mkdirSync(join(dir, 'profiles', 'cx'), { recursive: true });
    writeFileSync(join(dir, 'profiles', 'cx', 'history.jsonl'), `${JSON.stringify({ session_id: UUID, ts: Date.parse('2026-06-28T12:10:00.000Z') / 1000, text: 'go' })}\n`);

    expect(summarizeUsage(config()).find((s) => s.profile === 'cx')!.outputTokens).toBe(30);
  });

  it('credits each turn to the profile that typed it, by codex\'s own prompt history', () => {
    writeFileSync(
      join(day(), `rollout-2026-06-28T12-00-00-${OTHER}.jsonl`),
      [call('2026-06-28T12:00:05.000Z', 7, 7), call('2026-06-28T12:10:05.000Z', 37, 30), call('2026-06-28T12:20:05.000Z', 537, 500)].join('\n'),
    );
    // Typed in plain codex, then under the profile, then in plain codex again.
    const prompt = (at: string) => JSON.stringify({ session_id: OTHER, ts: Date.parse(at) / 1000, text: 'go' });
    writeFileSync(join(dir, 'codex', 'history.jsonl'), `${prompt('2026-06-28T12:00:00.000Z')}\n${prompt('2026-06-28T12:20:00.000Z')}\n`);
    mkdirSync(join(dir, 'profiles', 'cx'), { recursive: true });
    writeFileSync(join(dir, 'profiles', 'cx', 'history.jsonl'), `${prompt('2026-06-28T12:10:00.000Z')}\n`);

    const summaries = summarizeUsage(config());
    expect(summaries.find((s) => s.profile === 'cx')!.outputTokens).toBe(30);
    expect(summaries.find((s) => s.profile === 'unknown')!.outputTokens).toBe(2000 + 7 + 500);
  });

  it('does not scan codex when no codex profile is configured', () => {
    const claudeOnly: AimuxConfig = { ...config(), profiles: { main: { cli: 'claude', path: join(dir, 'x'), is_source: true } } };
    const summaries = summarizeUsage(claudeOnly);
    expect(summaries.find((s) => s.profile === 'unknown')).toBeUndefined();
  });
});
