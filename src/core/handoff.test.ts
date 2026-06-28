import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHandoffPrompt, buildSummarizePrompt, handoffSession, readTranscript, type HandoffDeps } from './handoff.js';
import type { AimuxConfig } from '../types/index.js';
import type { UnifiedSession } from './unifiedSessions.js';

const config = { version: 1, shared_source: '/x', profiles: {}, private: [] } as AimuxConfig;

function session(extra?: Partial<UnifiedSession>): UnifiedSession {
  return {
    sessionId: 'sess-1',
    short: 'sess-1',
    name: 'n',
    intent: 'fix bug',
    cli: 'claude',
    cwd: '/p',
    state: 'idle',
    detail: '',
    updatedAtMs: 1,
    createdAtMs: 1,
    events: 2,
    isInteractive: true,
    isBackground: false,
    ...extra,
  };
}

describe('prompt builders', () => {
  it('buildHandoffPrompt embeds the summary and a continue instruction', () => {
    const out = buildHandoffPrompt('  did X, next Y  ');
    expect(out).toContain('did X, next Y');
    expect(out).toContain('Continue from here');
    expect(out).toContain('reached its usage limit');
  });

  it('buildSummarizePrompt embeds the transcript under a marker', () => {
    const out = buildSummarizePrompt('TRANSCRIPT_BODY');
    expect(out).toContain('--- TRANSCRIPT ---');
    expect(out).toContain('TRANSCRIPT_BODY');
    expect(out).toContain('immediate next step');
  });
});

describe('readTranscript (codex)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  function codexConfig(): AimuxConfig {
    return { version: 1, shared_source: '/x', shared_sources: { codex: dir }, profiles: {}, private: [] } as AimuxConfig;
  }

  it('matches the rollout by exact session id, not a substring', () => {
    dir = mkdtempSync(join(tmpdir(), 'aimux-handoff-codex-'));
    const day = join(dir, 'sessions', '2026', '06', '28');
    mkdirSync(day, { recursive: true });
    // Decoy: filename CONTAINS the id but isn't the session's rollout (extra suffix).
    writeFileSync(join(day, `rollout-2026-06-28T10-00-00-${ID}-decoy.jsonl`), 'DECOY');
    writeFileSync(join(day, `rollout-2026-06-28T11-00-00-${ID}.jsonl`), 'REAL');

    const text = readTranscript(codexConfig(), session({ cli: 'codex', sessionId: ID }));
    expect(text).toBe('REAL');
  });
});

describe('handoffSession orchestration', () => {
  it('summarizes the transcript with the target profile, then launches it seeded', async () => {
    const summarize = vi.fn().mockResolvedValue('SUMMARY');
    const launch = vi.fn().mockResolvedValue(0);
    const deps: HandoffDeps = {
      findSession: () => session({ cli: 'claude' }),
      readTranscript: () => 'RAW',
      summarize,
      launch,
    };

    const res = await handoffSession(config, 'sess-1', 'codework', deps);

    expect(summarize).toHaveBeenCalledWith(config, 'codework', buildSummarizePrompt('RAW'));
    expect(launch).toHaveBeenCalledWith(config, 'codework', buildHandoffPrompt('SUMMARY'));
    expect(res).toEqual({ sessionId: 'sess-1', fromCli: 'claude', toProfile: 'codework', summary: 'SUMMARY', exitCode: 0 });
  });

  it('falls back to the session intent when no transcript text is found', async () => {
    const summarize = vi.fn().mockResolvedValue('S');
    const deps: HandoffDeps = {
      findSession: () => session({ intent: 'the goal' }),
      readTranscript: () => '',
      summarize,
      launch: () => Promise.resolve(0),
    };
    await handoffSession(config, 'sess-1', 'codework', deps);
    expect(summarize).toHaveBeenCalledWith(config, 'codework', buildSummarizePrompt('the goal'));
  });

  it('throws when the session is not found', async () => {
    const deps: HandoffDeps = {
      findSession: () => undefined,
      readTranscript: () => '',
      summarize: () => Promise.resolve('S'),
      launch: () => Promise.resolve(0),
    };
    await expect(handoffSession(config, 'nope', 'codework', deps)).rejects.toThrow('not found');
  });

  it('throws when the summarizer returns nothing', async () => {
    const deps: HandoffDeps = {
      findSession: () => session(),
      readTranscript: () => 'RAW',
      summarize: () => Promise.resolve(''),
      launch: () => Promise.resolve(0),
    };
    await expect(handoffSession(config, 'sess-1', 'codework', deps)).rejects.toThrow('no output');
  });
});
