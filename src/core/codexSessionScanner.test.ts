import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanCodexInteractive } from './codexSessionScanner.js';

const TEST_DIR = join(tmpdir(), `aimux-codex-scan-${Date.now()}`);
const SRC = join(TEST_DIR, 'codex');

function rollout(dir: string, file: string, records: unknown[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => {
  mkdirSync(SRC, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('scanCodexInteractive', () => {
  it('returns empty when there is no sessions dir', () => {
    expect(scanCodexInteractive(SRC)).toEqual([]);
  });

  it('extracts sessionId, cwd, createdAt and the first user message as intent', () => {
    rollout(join(SRC, 'sessions', '2026', '06', '18'), 'rollout-2026-06-18T14-05-17-019eda31-3172-7182-98a4-6c86e3c1ad6c.jsonl', [
      { timestamp: '2026-06-18T10:05:23.926Z', type: 'session_meta', payload: { id: '019eda31-3172-7182-98a4-6c86e3c1ad6c', cwd: '/home/u/proj' } },
      { timestamp: '2026-06-18T10:05:24.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the auth bug' }] } },
      { timestamp: '2026-06-18T10:05:25.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sure' }] } },
    ]);

    const out = scanCodexInteractive(SRC);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('019eda31-3172-7182-98a4-6c86e3c1ad6c');
    expect(out[0].cwd).toBe('/home/u/proj');
    expect(out[0].intent).toBe('fix the auth bug');
    expect(out[0].events).toBe(2);
    expect(out[0].createdAtMs).toBe(Date.parse('2026-06-18T10:05:23.926Z'));
  });

  it('falls back to the UUID in the filename when session_meta is missing an id', () => {
    rollout(join(SRC, 'sessions', '2026', '06', '18'), 'rollout-2026-06-18T09-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl', [
      { timestamp: '2026-06-18T09:00:00.000Z', type: 'session_meta', payload: { cwd: '/x' } },
    ]);
    const out = scanCodexInteractive(SRC);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('honors the scan window when a clock is provided', () => {
    const day = 86_400_000;
    const now = Date.parse('2026-06-18T12:00:00.000Z');
    rollout(join(SRC, 'sessions', '2026', '06', '18'), 'rollout-2026-06-18T11-00-00-11111111-1111-1111-1111-111111111111.jsonl', [
      { timestamp: '2026-06-18T11:00:00.000Z', type: 'session_meta', payload: { id: '11111111-1111-1111-1111-111111111111', cwd: '/y' } },
    ]);
    // windowDays=0.0001 → cutoff ~8.6s ago; the file's mtime is "now" so it stays in window.
    const recent = scanCodexInteractive(SRC, { now, windowDays: 1 });
    expect(recent).toHaveLength(1);
    // A 100-day window cutoff in the FUTURE relative to mtime would exclude it.
    const excluded = scanCodexInteractive(SRC, { now: now + 100 * day, windowDays: 1 });
    expect(excluded).toHaveLength(0);
  });
});
