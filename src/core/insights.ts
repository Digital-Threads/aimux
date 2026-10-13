import { pickFreestProfile, type LimitsSnapshot, type RateLimitProbe } from './limits.js';

const FIVE_HOURS = 5 * 3_600_000;
const SEVEN_DAYS = 7 * 24 * 3_600_000;

/** How a window is doing: fine, heading for nearly full, heading past full, or full. */
export type Verdict = 'ok' | 'tight' | 'over' | 'spent';

export interface WindowPace {
  pct: number;
  resetsAt?: number;
  /** Where the window ends up if the pace since it opened holds; null when unknown. */
  projectedPct: number | null;
  /** When it fills at that pace, if before the reset. */
  runsOutAt: number | null;
  verdict: Verdict;
}

const DAY = 24 * 3_600_000;
// How much of a day goes to work, at most. A week is not burned around the clock: carried
// through the nights as well, the first working day of a week would forecast three times
// what the week will take, and every Monday would read as running out.
const WORK_PER_DAY = DAY / 2;

/** The working time in a stretch of `ms` that starts with work: whole days of it, and the rest up to a day's worth. */
const workIn = (ms: number) => Math.floor(ms / DAY) * WORK_PER_DAY + Math.min(ms % DAY, WORK_PER_DAY);
/** How long from now until `work` of working time has passed: the other way round. */
const untilWorked = (work: number) => Math.floor(work / WORK_PER_DAY) * DAY + (work % WORK_PER_DAY);

/**
 * Judge one window by its pace: `pct` used over the part of the window already gone,
 * carried to the reset. A window is `over` when that lands past 100% — it will run out
 * first — and `tight` from 85%. A window of more than a day is carried over its working
 * hours (see WORK_PER_DAY); a shorter one over the clock.
 *
 * No forecast without a reset time, nor from the very start of a window: not in its first
 * hundredth at all (one large request would project to thousands of percent), and not in
 * its first twentieth while under a tenth is used. Then only the level counts.
 */
export function windowPace(pct: number, resetsAt: number | undefined, lengthMs: number, now: number): WindowPace {
  const left = resetsAt === undefined ? NaN : resetsAt - now;
  // Full, unless the reset has passed since the reading: then it is no longer full.
  if (pct >= 100 && !(left <= 0)) return { pct, resetsAt, projectedPct: null, runsOutAt: null, verdict: 'spent' };

  const elapsed = lengthMs - left;
  const isTooEarly = elapsed < lengthMs / 100 || (elapsed < lengthMs / 20 && pct < 10);
  if (!(left > 0) || isTooEarly) {
    return { pct, resetsAt, projectedPct: null, runsOutAt: null, verdict: pct >= 90 && pct < 100 ? 'tight' : 'ok' };
  }

  const isLong = lengthMs > DAY;
  const perMs = pct / (isLong ? workIn(elapsed) : elapsed);
  // Judged before rounding: 99.6% is not running out.
  const projected = pct + perMs * (isLong ? workIn(left) : left);
  const toFull = (100 - pct) / perMs;
  const runsOutAt = projected >= 100 ? Math.round(now + (isLong ? untilWorked(toFull) : toFull)) : null;

  return {
    pct,
    resetsAt,
    projectedPct: Math.min(999, projected >= 100 ? Math.ceil(projected) : Math.floor(projected)),
    runsOutAt,
    verdict: projected >= 100 ? 'over' : projected >= 85 ? 'tight' : 'ok',
  };
}

export interface ProfileInsight {
  name: string;
  cli: string;
  error?: RateLimitProbe['error'];
  fiveHour: WindowPace | null;
  weekly: WindowPace | null;
  /** The worse of its windows; `unknown` when there are no figures to judge. */
  verdict: Verdict | 'unknown';
}

export interface LimitsInsight {
  fetchedAt: number;
  now: number;
  profiles: ProfileInsight[];
  /** The subscription with the most room in its tightest window, if any has figures. */
  freest: string | null;
}

const WORST: Array<Verdict | 'unknown'> = ['unknown', 'ok', 'tight', 'over', 'spent'];

/** A reading of every subscription's limits, as answers: who has room, who burns too fast. */
export function limitsInsight(snapshot: LimitsSnapshot, now: number = Date.now()): LimitsInsight {
  const profiles = Object.entries(snapshot.profiles).map(([name, probe]): ProfileInsight => {
    const s = probe.status;
    const fiveHour = s && s.fiveHourPct !== null ? windowPace(s.fiveHourPct, s.fiveHourResetsAt, FIVE_HOURS, now) : null;
    const weekly = s && s.weeklyPct !== null ? windowPace(s.weeklyPct, s.weeklyResetsAt, SEVEN_DAYS, now) : null;
    const verdict = [fiveHour, weekly]
      .map((w) => w?.verdict ?? 'unknown')
      .reduce((worst, v) => (WORST.indexOf(v) > WORST.indexOf(worst) ? v : worst), 'unknown' as Verdict | 'unknown');

    return { name, cli: probe.cli, error: probe.error, fiveHour, weekly, verdict };
  });

  return {
    fetchedAt: snapshot.fetchedAt,
    now,
    profiles,
    freest: pickFreestProfile(new Map(Object.entries(snapshot.profiles))),
  };
}
