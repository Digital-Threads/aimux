import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAimuxDir, setAimuxDir } from './paths.js';
import { limitsInsight, windowPace } from './insights.js';
import { limitsHistory, recordLimits } from './limitsHistory.js';
import type { LimitsSnapshot } from './limits.js';

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const NOW = Date.UTC(2026, 9, 13, 12);

describe('windowPace', () => {
  it('is fine when the window will reset before it fills at this pace', () => {
    // 30% used, 3 of 5 hours gone: heading for 50%.
    const pace = windowPace(30, NOW + 2 * HOUR, FIVE_HOURS, NOW);
    expect(pace).toMatchObject({ verdict: 'ok', projectedPct: 50, runsOutAt: null });
  });

  it('says when a window will run out before it resets, and when', () => {
    // 60% used after 1 of 5 hours: 60 points an hour, so the last 40 take 40 minutes.
    const pace = windowPace(60, NOW + 4 * HOUR, FIVE_HOURS, NOW);
    expect(pace.verdict).toBe('over');
    expect(pace.runsOutAt).toBe(NOW + 40 * 60_000);
  });

  it('flags a window that will end nearly full', () => {
    expect(windowPace(54, NOW + 2 * HOUR, FIVE_HOURS, NOW).verdict).toBe('tight'); // heading for 90%
  });

  it('calls a full window spent', () => {
    expect(windowPace(100, NOW + HOUR, FIVE_HOURS, NOW)).toMatchObject({ verdict: 'spent', runsOutAt: null });
  });

  it('does not forecast from the first minutes of a window, or without a reset time', () => {
    // 4% in the first six minutes would "project" to 200%.
    expect(windowPace(4, NOW + FIVE_HOURS - 6 * 60_000, FIVE_HOURS, NOW)).toMatchObject({ verdict: 'ok', projectedPct: null });
    expect(windowPace(95, undefined, FIVE_HOURS, NOW)).toMatchObject({ verdict: 'tight', projectedPct: null });
  });

  it('does forecast that early once a tenth of the window is gone', () => {
    // 11% two hours into a week, 5.5 points an hour: the other 89% takes 16 hours of work,
    // twelve today and the rest tomorrow.
    const pace = windowPace(11, NOW + 7 * 24 * HOUR - 2 * HOUR, 7 * 24 * HOUR, NOW);
    expect(pace.verdict).toBe('over');
    expect(Math.round((pace.runsOutAt! - NOW) / HOUR)).toBe(28);
  });

  it('carries a week over its working hours, so one working day does not read as running out', () => {
    // 7% nine hours into a week. Around the clock that is 130% by the reset; at twelve
    // working hours a day there are 84 of them left, and 7% + 84 × (7% / 9) is 72%.
    expect(windowPace(7, NOW + 7 * 24 * HOUR - 9 * HOUR, 7 * 24 * HOUR, NOW)).toMatchObject({ verdict: 'ok', projectedPct: 72, runsOutAt: null });

    // Half the week gone and 60% with it is over pace on any count.
    expect(windowPace(60, NOW + 3.5 * 24 * HOUR, 7 * 24 * HOUR, NOW).verdict).toBe('over');
  });

  it('does not forecast from the very start of a window, whatever was used', () => {
    // One large request: 10% two minutes into five hours would "project" to 1500%.
    expect(windowPace(10, NOW + FIVE_HOURS - 2 * 60_000, FIVE_HOURS, NOW)).toMatchObject({ verdict: 'ok', projectedPct: null });
  });

  it('judges before rounding: just under full at the reset is tight, not running out', () => {
    // 49.8% at half time lands on 99.6%.
    const pace = windowPace(49.8, NOW + 2.5 * HOUR, FIVE_HOURS, NOW);
    expect(pace).toMatchObject({ verdict: 'tight', projectedPct: 99, runsOutAt: null });
  });

  it('does not call a window full once its reset has passed', () => {
    expect(windowPace(100, NOW - 60_000, FIVE_HOURS, NOW)).toMatchObject({ verdict: 'ok', runsOutAt: null });
  });

  it('does not forecast for a window whose reset lies further off than its length', () => {
    expect(windowPace(40, NOW + 6 * HOUR, FIVE_HOURS, NOW)).toMatchObject({ verdict: 'ok', projectedPct: null });
  });
});

describe('limits history and insight', () => {
  let root: string;
  let originalAimuxDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aimux-insights-'));
    originalAimuxDir = getAimuxDir();
    setAimuxDir(join(root, '.aimux'));
    mkdirSync(join(root, '.aimux'), { recursive: true });
  });
  afterEach(() => {
    setAimuxDir(originalAimuxDir);
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = (at: number, five: number, week: number): LimitsSnapshot => ({
    fetchedAt: at,
    profiles: {
      dt: { cli: 'claude', status: { fiveHourPct: five, weeklyPct: week, fiveHourResetsAt: at + 4 * HOUR, weeklyResetsAt: at + 24 * HOUR } },
      cx: { cli: 'codex', status: { fiveHourPct: null, weeklyPct: 30, weeklyResetsAt: at + 90 * HOUR } },
      old: { cli: 'claude', status: null, error: 'auth' },
    },
  });

  it('keeps each reading, so the burn of a window can be drawn', () => {
    recordLimits(snapshot(NOW - 2 * HOUR, 10, 40));
    recordLimits(snapshot(NOW - HOUR, 35, 41));
    recordLimits(snapshot(NOW, 60, 43));

    expect(limitsHistory(NOW - 90 * 60_000)).toEqual([
      { at: NOW - HOUR, profiles: { dt: [35, 41], cx: [null, 30] } },
      { at: NOW, profiles: { dt: [60, 43], cx: [null, 30] } },
    ]);
  });

  it('survives a torn line and does not grow without bound', () => {
    writeFileSync(join(root, '.aimux', 'limits-history.jsonl'), '{"at": 1, "profiles"\n');
    for (let i = 0; i < 30; i++) recordLimits(snapshot(NOW + i, 10, 10), 1_000);

    const kept = readFileSync(join(root, '.aimux', 'limits-history.jsonl'), 'utf-8').trim().split('\n');
    expect(kept.length).toBeLessThan(30);
    expect(limitsHistory(0).at(-1)?.at).toBe(NOW + 29);
  });

  it('turns a reading into what a person asks: who has room, who is burning too fast', () => {
    const insight = limitsInsight(snapshot(NOW, 60, 43), NOW);

    const dt = insight.profiles.find((p) => p.name === 'dt')!;
    expect(dt.fiveHour).toMatchObject({ pct: 60, verdict: 'over' });
    expect(dt.weekly).toMatchObject({ pct: 43, verdict: 'ok' });
    expect(dt.verdict).toBe('over');

    expect(insight.profiles.find((p) => p.name === 'cx')).toMatchObject({ fiveHour: null, verdict: 'ok' });
    expect(insight.profiles.find((p) => p.name === 'old')).toMatchObject({ error: 'auth', verdict: 'unknown' });
    // The freest is judged by its tightest window, as everywhere else in aimux.
    expect(insight.freest).toBe('cx');
  });
});
