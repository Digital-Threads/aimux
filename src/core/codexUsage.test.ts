import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('counts a session once (max cumulative) when it spans multiple rollout files', () => {
    // codex resume can write a second rollout for the same session id; each carries
    // its own cumulative total. Summing them would double-count — keep the largest.
    const day = join(dir, 'codex', 'sessions', '2026', '06', '28');
    writeFileSync(
      join(day, `rollout-2026-06-28T12-00-00-${UUID}.jsonl`),
      rolloutLines('gpt-5-codex', {
        input_tokens: 25000, cached_input_tokens: 10000, output_tokens: 5000,
        reasoning_output_tokens: 1000, total_tokens: 30000,
      }),
    );
    const u = summarizeUsage(config()).find((s) => s.profile === 'unknown')!;
    // Larger file wins; NOT the sum (2000 + 5000 = 7000) of both files.
    expect(u.outputTokens).toBe(5000);
    expect(u.inputTokens).toBe(15000); // 25000 - 10000, from the larger rollout
  });

  it('does not scan codex when no codex profile is configured', () => {
    const claudeOnly: AimuxConfig = { ...config(), profiles: { main: { cli: 'claude', path: join(dir, 'x'), is_source: true } } };
    const summaries = summarizeUsage(claudeOnly);
    expect(summaries.find((s) => s.profile === 'unknown')).toBeUndefined();
  });
});
