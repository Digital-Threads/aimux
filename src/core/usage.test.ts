import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import { getAimuxDir, setAimuxDir } from './paths.js';
import { summarizeUsage, usageBySession, usageReport, parseSinceDuration, totalTokens } from './usage.js';

const TEST_DIR = join(tmpdir(), `aimux-usage-test-${Date.now()}`);
const NOW_TS = '2026-05-14T00:00:00.000Z';
const LATER_TS = '2026-05-14T00:00:01.000Z';
const OLD_TS = '2026-05-10T00:00:00.000Z';
const CUTOFF_TS = '2026-05-13T00:00:00.000Z';

let originalAimuxDir: string;

function makeConfig(): AimuxConfig {
  return {
    version: 1,
    shared_source: join(TEST_DIR, 'shared'),
    profiles: {
      main: { cli: 'claude', path: join(TEST_DIR, 'shared'), is_source: true },
      work: { cli: 'claude', path: join(TEST_DIR, 'profiles', 'work') },
    },
    private: ['.credentials.json'],
  };
}

function writeProfileSession(profile: string, sessionId: string, modified: number) {
  writeProfileSessions(profile, [{ sessionId, modified }]);
}

function writeProfileSessions(
  profile: string,
  sessions: Array<{ sessionId: string; modified: number }>,
) {
  const profilePath = profile === 'main' ? join(TEST_DIR, 'shared') : join(TEST_DIR, 'profiles', profile);
  mkdirSync(profilePath, { recursive: true });
  const projects: Record<string, { lastSessionId: string; lastSessionModified: number }> = {};
  for (const { sessionId, modified } of sessions) {
    projects[`/tmp/project-${sessionId}`] = {
      lastSessionId: sessionId,
      lastSessionModified: modified,
    };
  }
  writeFileSync(
    join(profilePath, '.claude.json'),
    JSON.stringify({ projects }),
  );
}

function writeTranscript(cwdHash: string, sessionId: string, lines: unknown[]) {
  const dir = join(TEST_DIR, 'shared', 'projects', cwdHash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function assistantLine(
  sessionId: string,
  requestId: string,
  usage: Record<string, unknown>,
  timestamp = NOW_TS,
) {
  return {
    type: 'assistant',
    requestId,
    timestamp,
    sessionId,
    message: {
      id: `msg-${requestId}`,
      model: 'claude-opus-4-7',
      usage,
    },
  };
}

function queueOperationLine() {
  return {
    type: 'queue-operation',
    operation: 'task',
    timestamp: NOW_TS,
  };
}

beforeEach(() => {
  originalAimuxDir = getAimuxDir();
  mkdirSync(TEST_DIR, { recursive: true });
  setAimuxDir(join(TEST_DIR, '.aimux'));
});

afterEach(() => {
  setAimuxDir(originalAimuxDir);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('summarizeUsage', () => {
  it('attributes transcript usage to profiles via .claude.json session ownership', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
      }),
    ]);

    const summaries = summarizeUsage(makeConfig());
    const work = summaries.find((s) => s.profile === 'work')!;
    expect(work.sessions).toBe(1);
    expect(work.requests).toBe(1);
    expect(totalTokens(work)).toBe(100);
    expect(work.models.get('claude-opus-4-7')).toBe(1);
  });

  it('deduplicates repeated transcript lines for the same requestId', () => {
    writeProfileSession('work', 'session-a', 1000);
    const repeated = assistantLine('session-a', 'req-1', {
      input_tokens: 10,
      output_tokens: 5,
    });
    writeTranscript('-tmp-project', 'session-a', [repeated, repeated]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect(work.inputTokens).toBe(10);
    expect(work.outputTokens).toBe(5);
  });

  it('does not count the notices Claude Code writes itself as requests', () => {
    // A spent limit or an API error lands in the transcript as a `<synthetic>` record.
    writeProfileSession('work', 'session-a', 1000);
    const notice = assistantLine('session-a', 'req-2', { input_tokens: 0, output_tokens: 0 });
    notice.message.model = '<synthetic>';
    writeTranscript('-tmp-project', 'session-a', [assistantLine('session-a', 'req-1', { input_tokens: 10 }), notice]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect([...work.models.keys()]).toEqual(['claude-opus-4-7']);
  });

  it('deduplicates forked sessions that share a requestId', () => {
    writeProfileSessions('work', [
      { sessionId: 'session-original', modified: 1000 },
      { sessionId: 'session-fork', modified: 2000 },
    ]);
    writeTranscript('-tmp-project', 'session-original', [
      assistantLine('session-original', 'req-shared', {
        input_tokens: 10,
        output_tokens: 5,
      }),
    ]);
    writeTranscript('-tmp-project', 'session-fork', [
      assistantLine('session-fork', 'req-shared', {
        input_tokens: 10,
        output_tokens: 5,
      }, LATER_TS),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect(work.inputTokens).toBe(10);
    expect(work.outputTokens).toBe(5);
  });

  it('skips subagent transcripts', () => {
    writeProfileSession('work', 'session-subagent', 1000);
    writeTranscript('-tmp-project', 'session-subagent', [
      queueOperationLine(),
      assistantLine('session-subagent', 'req-subagent', {
        input_tokens: 1000,
        output_tokens: 500,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(0);
    expect(totalTokens(work)).toBe(0);
  });

  it('counts stable line fallback keys when request identifiers are missing', () => {
    writeProfileSession('work', 'session-a', 1000);
    const line: { requestId?: string; message: { id?: string } } = assistantLine('session-a', '', {
      input_tokens: 10,
      estimated_cost_usd: 0.01,
    });
    delete line.requestId;
    delete line.message.id;
    writeTranscript('-tmp-project', 'session-a', [line, line]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(2);
    expect(work.inputTokens).toBe(20);
    expect(work.estimatedCostUsd).toBe(0.02);
  });

  it('ignores malformed non-numeric usage values', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-bad', {
        input_tokens: '10',
        output_tokens: Number.NaN,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect(totalTokens(work)).toBe(0);
  });

  it('attributes a session aimux did not launch to the profile that ran it', () => {
    // No aimux history and no .claude.json entry: the only trace is the session-env
    // marker Claude Code left in the config dir it ran under.
    mkdirSync(join(TEST_DIR, 'profiles', 'work', 'session-env', 'session-m'), { recursive: true });
    const afterMarker = new Date(Date.now() + 60_000).toISOString();
    writeTranscript('-tmp-project', 'session-m', [
      assistantLine('session-m', 'req-m', { input_tokens: 10, output_tokens: 5 }, afterMarker),
    ]);

    const summaries = summarizeUsage(makeConfig());
    expect(summaries.find((s) => s.profile === 'work')?.requests).toBe(1);
    expect(summaries.find((s) => s.profile === 'unknown')).toBeUndefined();
  });

  it('splits a session continued on another subscription even though .claude.json names only the second', async () => {
    const pause = () => new Promise((r) => setTimeout(r, 30));
    // work has its own session-env from the start, so the source's markers are trusted.
    mkdirSync(join(TEST_DIR, 'profiles', 'work', 'session-env'), { recursive: true });
    await pause();
    mkdirSync(join(TEST_DIR, 'shared', 'session-env', 'session-c'), { recursive: true }); // started on main
    await pause();
    const onMain = new Date().toISOString();
    await pause();
    mkdirSync(join(TEST_DIR, 'profiles', 'work', 'session-env', 'session-c'), { recursive: true }); // continued on work
    await pause();
    const onWork = new Date().toISOString();
    // work's .claude.json now lists the session as its last one — a whole-session claim.
    writeProfileSession('work', 'session-c', Date.now());
    writeTranscript('-tmp-project', 'session-c', [
      assistantLine('session-c', 'req-main', { input_tokens: 10, output_tokens: 5 }, onMain),
      assistantLine('session-c', 'req-work', { input_tokens: 10, output_tokens: 5 }, onWork),
    ]);

    const summaries = summarizeUsage(makeConfig());
    expect(summaries.find((s) => s.profile === 'main')?.requests).toBe(1);
    expect(summaries.find((s) => s.profile === 'work')?.requests).toBe(1);
  });

  it('does not credit a profile with turns from before it opened the session', () => {
    // `aimux run work --resume <id>` on a session begun under another subscription:
    // work's marker appears at the resume, so the earlier turns are not work's.
    mkdirSync(join(TEST_DIR, 'profiles', 'work', 'session-env', 'session-r'), { recursive: true });
    const afterMarker = new Date(Date.now() + 60_000).toISOString();
    writeTranscript('-tmp-project', 'session-r', [
      assistantLine('session-r', 'req-early', { input_tokens: 10, output_tokens: 5 }, NOW_TS),
      assistantLine('session-r', 'req-late', { input_tokens: 10, output_tokens: 5 }, afterMarker),
    ]);

    const summaries = summarizeUsage(makeConfig());
    expect(summaries.find((s) => s.profile === 'work')?.requests).toBe(1);
    expect(summaries.find((s) => s.profile === 'unknown')?.requests).toBe(1);
  });

  it('derives estimated cost from the price table when transcripts lack cost', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    // assistantLine() uses model claude-opus-4-7 = $5 in + $25 out per 1M (list price
    // since Opus 4.5; the $15/$75 this used to assert was Opus 4.1's).
    expect(work.estimatedCostUsd).toBeCloseTo(30, 6);
  });

  it('prefers transcript cost over the price-table estimate when present', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        estimated_cost_usd: 0.5,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.estimatedCostUsd).toBe(0.5);
  });

  it('leaves cost at 0 when the model has no price entry', () => {
    writeProfileSession('work', 'session-a', 1000);
    const line = assistantLine('session-a', 'req-x', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    line.message.model = 'mystery-model-x';
    writeTranscript('-tmp-project', 'session-a', [line]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.estimatedCostUsd).toBe(0);
  });

  it('filters by profile and since timestamp', () => {
    writeProfileSession('main', 'session-main', 1000);
    writeProfileSession('work', 'session-work', 1000);
    writeTranscript('-tmp-project', 'session-main', [
      assistantLine('session-main', 'req-main', { input_tokens: 100 }, OLD_TS),
    ]);
    writeTranscript('-tmp-project', 'session-work', [
      assistantLine('session-work', 'req-old', { input_tokens: 100 }, OLD_TS),
      assistantLine('session-work', 'req-new', { input_tokens: 200 }),
    ]);

    const summaries = summarizeUsage(makeConfig(), {
      profile: 'work',
      sinceMs: Date.parse(CUTOFF_TS),
    });
    expect(summaries.map((s) => s.profile)).toEqual(['work']);
    expect(summaries[0].requests).toBe(1);
    expect(summaries[0].inputTokens).toBe(200);
  });
});

describe('usageBySession', () => {
  it('breaks usage down per session with profile and totals', () => {
    writeProfileSessions('work', [
      { sessionId: 'session-a', modified: 1000 },
      { sessionId: 'session-b', modified: 2000 },
    ]);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', { input_tokens: 10, output_tokens: 5 }),
    ]);
    writeTranscript('-tmp-project', 'session-b', [
      assistantLine('session-b', 'req-2', { input_tokens: 100, output_tokens: 50 }),
    ]);

    const rows = usageBySession(makeConfig());
    const a = rows.find((r) => r.sessionId === 'session-a')!;
    const b = rows.find((r) => r.sessionId === 'session-b')!;
    expect(a.profile).toBe('work');
    expect(a.requests).toBe(1);
    expect(totalTokens(a)).toBe(15);
    expect(totalTokens(b)).toBe(150);
  });

  it('deduplicates repeated lines and respects the profile filter', () => {
    writeProfileSessions('work', [{ sessionId: 'session-a', modified: 1000 }]);
    writeProfileSessions('main', [{ sessionId: 'session-m', modified: 1000 }]);
    const repeated = assistantLine('session-a', 'req-1', { input_tokens: 10, output_tokens: 5 });
    writeTranscript('-tmp-project', 'session-a', [repeated, repeated]);
    writeTranscript('-tmp-main', 'session-m', [
      assistantLine('session-m', 'req-2', { input_tokens: 7, output_tokens: 3 }),
    ]);

    const rows = usageBySession(makeConfig(), { profile: 'work' });
    expect(rows.map((r) => r.sessionId)).toEqual(['session-a']);
    expect(rows[0].requests).toBe(1);
    expect(rows[0].inputTokens).toBe(10);
  });
});

describe('parseSinceDuration', () => {
  it('parses hours, days, and weeks', () => {
    const now = Date.parse(NOW_TS);
    expect(parseSinceDuration('24h', now)).toBe(now - 24 * 60 * 60 * 1000);
    expect(parseSinceDuration('7d', now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(parseSinceDuration('2w', now)).toBe(now - 14 * 24 * 60 * 60 * 1000);
  });

  it('rejects invalid durations', () => {
    expect(() => parseSinceDuration('yesterday')).toThrow('Invalid duration');
  });
});

describe('summarizeUsage — large transcripts', () => {
  it('reads a transcript too big to hold in one piece, line by line', () => {
    // Real transcripts pass half a gigabyte, which Node cannot load as one string — and the
    // heaviest sessions are exactly those. Lines here straddle every chunk the reader takes.
    writeProfileSession('work', 'session-a', 1000);
    const padding = { type: 'user', sessionId: 'session-a', timestamp: NOW_TS, message: { role: 'user', content: 'x'.repeat(700_000) } };
    const lines: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      lines.push(padding);
      lines.push(assistantLine('session-a', `req-${i}`, { input_tokens: 10, output_tokens: 1 }));
    }
    writeTranscript('-tmp-project', 'session-a', lines);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(6);
    expect(work.inputTokens).toBe(60);
  });

  it('does not mistake talk about usage for a request', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      { type: 'user', sessionId: 'session-a', timestamp: NOW_TS, message: { role: 'user', content: 'show me the "usage" field' } },
      assistantLine('session-a', 'req-1', { input_tokens: 7 }),
    ]);

    expect(summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!.requests).toBe(1);
  });
});

describe('usageReport', () => {
  // Local-time timestamps, so the day a record falls on does not depend on the zone
  // the tests run in.
  const at = (day: number, hour: number) => new Date(2026, 4, day, hour).toISOString();
  const line = (sessionId: string, requestId: string, when: string, cwd: string, model: string, outputTokens: number) => ({
    ...assistantLine(sessionId, requestId, { input_tokens: 10, output_tokens: outputTokens }, when),
    cwd,
    message: { id: `msg-${requestId}`, model, usage: { input_tokens: 10, output_tokens: outputTokens } },
  });

  function twoSessions() {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-srv-shop', 'session-a', [
      line('session-a', 'r1', at(13, 9), '/srv/shop', 'claude-opus-4-7', 100),
      line('session-a', 'r2', at(13, 23), '/srv/shop', 'claude-opus-4-7', 200),
      line('session-a', 'r3', at(14, 10), '/srv/shop', 'claude-haiku-4-5', 300),
    ]);
    writeTranscript('-srv-blog', 'session-b', [
      line('session-b', 'r4', at(14, 11), '/srv/blog', 'claude-opus-4-7', 50),
    ]);
  }

  it('totals per profile, in plain data a page or another program can take', () => {
    twoSessions();
    const report = usageReport(makeConfig());

    const work = report.profiles.find((p) => p.profile === 'work')!;
    expect(work).toMatchObject({ sessions: 1, requests: 3, outputTokens: 600, models: ['claude-opus-4-7', 'claude-haiku-4-5'] });
    expect(report.profiles.find((p) => p.profile === 'unknown')).toMatchObject({ requests: 1, outputTokens: 50 });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('spreads the spend over the days it happened on, per profile', () => {
    twoSessions();
    const days = usageReport(makeConfig()).days.map((d) => [d.day, d.profile, d.requests, d.outputTokens]);

    expect(days).toEqual([
      ['2026-05-13', 'work', 2, 300],
      ['2026-05-14', 'unknown', 1, 50],
      ['2026-05-14', 'work', 1, 300],
    ]);
  });

  it('says which models, projects and sessions the tokens went to, biggest first', () => {
    twoSessions();
    const report = usageReport(makeConfig());

    expect(report.models.map((m) => [m.model, m.requests])).toEqual([['claude-opus-4-7', 3], ['claude-haiku-4-5', 1]]);
    expect(report.projects.map((p) => [p.project, p.outputTokens])).toEqual([['/srv/shop', 600], ['/srv/blog', 50]]);
    expect(report.sessions[0]).toMatchObject({ sessionId: 'session-a', profile: 'work', project: '/srv/shop', requests: 3 });
  });

  it('keeps the heaviest by cost as well as by tokens, whichever a reader ranks by', () => {
    writeProfileSession('work', 'session-a', 1000);
    // Many cheap tokens in one project, few costly ones in the other.
    writeTranscript('-srv-cheap', 'session-a', [{
      ...assistantLine('session-a', 'r1', { input_tokens: 1_000_000 }, at(14, 10)),
      cwd: '/srv/cheap',
      message: { id: 'msg-r1', model: 'claude-haiku-4-5', usage: { input_tokens: 1_000_000 } },
    }]);
    writeTranscript('-srv-dear', 'session-b', [line('session-b', 'r2', at(14, 11), '/srv/dear', 'claude-opus-4-7', 200_000)]);

    const report = usageReport(makeConfig(), { top: 1 });
    const [cheap, dear] = report.projects;

    expect([cheap.project, dear.project]).toEqual(['/srv/cheap', '/srv/dear']);
    expect(dear.estimatedCostUsd).toBeGreaterThan(cheap.estimatedCostUsd);
  });

  it('lists every day of the window, the ones with no usage too, and every hour when asked', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const days = usageReport(makeConfig(), { sinceMs: Date.now() - 3 * 24 * 3_600_000 }).buckets;
    expect(days).toHaveLength(4);
    expect(days.at(-1)).toBe(today);

    const hours = usageReport(makeConfig(), { sinceMs: Date.now() - 5 * 3_600_000, byHour: true }).buckets;
    expect(hours.at(-1)).toBe(`${today}T${pad(now.getHours())}`);
    expect(new Set(hours).size).toBe(hours.length);
  });

  it('starts the list at the first day there is usage on when no window was asked for', () => {
    twoSessions();

    expect(usageReport(makeConfig()).buckets[0]).toBe('2026-05-13');
  });

  it('names the hour a request was made in when asked to split by the hour', () => {
    twoSessions();
    const hours = usageReport(makeConfig(), { byHour: true }).days.map((d) => d.day);

    expect(hours).toEqual(['2026-05-13T09', '2026-05-13T23', '2026-05-14T10', '2026-05-14T11']);
  });

  it('keeps only the biggest when asked to', () => {
    twoSessions();
    const report = usageReport(makeConfig(), { top: 1 });

    expect(report.projects.map((p) => p.project)).toEqual(['/srv/shop']);
    expect(report.sessions).toHaveLength(1);
  });
});

describe('what a scan remembers about a transcript', () => {
  const work = () => summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!.requests;

  it('counts a transcript that was still empty the first time it was seen', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-srv-shop', 'session-a', []);
    expect(work()).toBe(0);

    writeTranscript('-srv-shop', 'session-a', [assistantLine('session-a', 'req-1', { input_tokens: 7 })]);
    expect(work()).toBe(1);
  });

  it('counts a conversation that was only a queued prompt the first time it was seen', () => {
    writeProfileSession('work', 'session-a', 1000);
    const waiting = [{ type: 'mode', sessionId: 'session-a' }, { type: 'queue-operation', sessionId: 'session-a' }];
    writeTranscript('-srv-shop', 'session-a', waiting);
    expect(work()).toBe(0);

    writeTranscript('-srv-shop', 'session-a', [
      ...waiting,
      { type: 'user', userType: 'external', sessionId: 'session-a', message: { role: 'user', content: 'hello' } },
      assistantLine('session-a', 'req-1', { input_tokens: 7 }),
    ]);
    expect(work()).toBe(1);
  });

  it('still sets a helper\'s transcript aside the second time', () => {
    writeProfileSession('work', 'session-a', 1000);
    const helper = [{ type: 'queue-operation', sessionId: 'session-a' }, assistantLine('session-a', 'req-1', { input_tokens: 7 })];
    writeTranscript('-srv-shop', 'session-a', helper);
    expect(work()).toBe(0);

    writeTranscript('-srv-shop', 'session-a', [...helper, assistantLine('session-a', 'req-2', { input_tokens: 7 })]);
    expect(work()).toBe(0);
  });
});
