import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAimuxDir } from './paths.js';
import type { LimitsSnapshot } from './limits.js';

/** One past reading: each subscription's `[5-hour %, weekly %]`. */
export interface LimitsReading {
  at: number;
  profiles: Record<string, [number | null, number | null]>;
}

const historyPath = () => join(getAimuxDir(), 'limits-history.jsonl');

/**
 * Add a reading to the history (`~/.aimux/limits-history.jsonl`), one short line each.
 * Past `maxBytes` the older half goes: a reading every few minutes is ~50 KB a day, so
 * the default keeps a few weeks.
 */
export function recordLimits(snapshot: LimitsSnapshot, maxBytes = 1_000_000): void {
  const profiles: LimitsReading['profiles'] = {};
  for (const [name, probe] of Object.entries(snapshot.profiles)) {
    if (probe.status) profiles[name] = [probe.status.fiveHourPct, probe.status.weeklyPct];
  }

  try {
    const path = historyPath();
    appendFileSync(path, `${JSON.stringify({ at: snapshot.fetchedAt, profiles })}\n`, { mode: 0o600 });

    if (statSync(path).size > maxBytes) {
      const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
      // Written aside and renamed: a reader never meets half a file.
      writeFileSync(`${path}.${process.pid}`, `${lines.slice(Math.ceil(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
      renameSync(`${path}.${process.pid}`, path);
    }
  } catch {
    // history is a nicety: an unwritable ~/.aimux must not break reading the limits
  }
}

/** The readings since `sinceMs`, oldest first. A torn or foreign line is skipped. */
export function limitsHistory(sinceMs: number): LimitsReading[] {
  let raw: string;
  try {
    raw = readFileSync(historyPath(), 'utf-8');
  } catch {
    return [];
  }

  const readings: LimitsReading[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;

    try {
      const reading = JSON.parse(line) as LimitsReading;
      if (typeof reading.at === 'number' && reading.at >= sinceMs && reading.profiles) readings.push(reading);
    } catch {
      // torn by a concurrent writer
    }
  }

  return readings;
}
