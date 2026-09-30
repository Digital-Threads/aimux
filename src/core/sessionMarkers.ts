import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync, existsSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';

// What a claude session leaves behind in the config dir it ran under.
//
// Claude Code creates `session-env/<sessionId>/` inside CLAUDE_CONFIG_DIR for every
// session. Transcripts live in the shared `projects/`, so they cannot say which
// subscription ran them — the marker can, now that every profile keeps its own
// `session-env` (private since 0.27.0).

/** When a file or dir came into being. Falls back to mtime on filesystems without a
 *  birth time; for a directory that only moves the time later, so the rules below
 *  then attribute less rather than attribute wrongly. */
function bornAt(stat: Stats): number {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
}

function markersIn(configDir: string): Array<{ id: string; born: number }> {
  const dir = join(configDir, 'session-env');
  let ids: string[];
  try {
    ids = readdirSync(dir);
  } catch {
    return [];
  }

  const markers: Array<{ id: string; born: number }> = [];
  for (const id of ids) {
    try {
      markers.push({ id, born: bornAt(statSync(join(dir, id))) });
    } catch {
      // Claude pruned it between the listing and the stat.
    }
  }
  return markers;
}

/** One profile that opened a session, and when it first did. */
export interface SessionOwner {
  profile: string;
  since: number;
}

/**
 * Which profiles ran each session, keyed by session id, earliest first.
 *
 * The source profile needs care: before 0.27.0 every profile's `session-env` was a
 * symlink into the source's, so the source's older markers can belong to anyone. Its
 * markers count only while no profile still links there, and only from the moment
 * the first profile got a private `session-env` — the upgrade — onward.
 */
export function sessionOwners(config: AimuxConfig): Map<string, SessionOwner[]> {
  const owners = new Map<string, SessionOwner[]>();
  const add = (id: string, profile: string, since: number) =>
    owners.set(id, [...(owners.get(id) ?? []), { profile, since }]);

  const claude = Object.entries(config.profiles).filter(([, p]) => (p.cli ?? 'claude') === 'claude');
  const source = claude.find(([, p]) => p.is_source);
  let sourceShared = false;
  const privateSince: number[] = [];

  for (const [name, p] of claude) {
    if (p.is_source) continue;
    const dir = join(expandHome(p.path), 'session-env');
    let stat: Stats;
    try {
      stat = lstatSync(dir);
    } catch {
      continue; // never ran since the upgrade — nothing to attribute
    }

    if (stat.isSymbolicLink()) {
      sourceShared = true;
      continue;
    }

    privateSince.push(bornAt(stat));
    for (const { id, born } of markersIn(expandHome(p.path))) add(id, name, born);
  }

  // ponytail: a profile that has not run since the upgrade leaves the split undatable,
  // so the source stays untrusted until one does; a recorded upgrade time would lift that.
  const nonSourceCount = claude.length - (source ? 1 : 0);
  const trustSourceFrom = sourceShared
    ? null
    : nonSourceCount === 0
      ? 0
      : privateSince.length > 0 ? Math.min(...privateSince) : null;

  if (source && trustSourceFrom !== null) {
    for (const { id, born } of markersIn(expandHome(source[1].path))) {
      if (born >= trustSourceFrom) add(id, source[0], born);
    }
  }

  for (const list of owners.values()) list.sort((a, b) => a.since - b.since);
  return owners;
}

/**
 * Who was running a session at time `t`: the profile whose marker for it is the newest
 * one not after `t`. A profile's marker appears when it first opens the session, so a
 * turn from before that — a session begun elsewhere and resumed here — is not its.
 */
export function ownerAt(owners: SessionOwner[] | undefined, t: number): string | undefined {
  // ponytail: one marker per profile cannot date a second visit, so a session that goes
  // back to an earlier profile (A → B → A) stays credited to B after the return.
  let owner: string | undefined;
  for (const o of owners ?? []) {
    if (o.since > t) break;
    owner = o.profile;
  }
  return owner;
}

/** Where claude keeps interactive transcripts: `<source>/projects/<cwd-hash>/<id>.jsonl`. */
function projectsRoot(config: AimuxConfig): string {
  return join(expandHome(config.shared_source), 'projects');
}

/**
 * Follow which conversation a running claude process is on.
 *
 * claude keeps `<config>/sessions/<pid>.json` pointing at its current session — it
 * changes on /clear and /resume — and deletes the file when it exits. Reading it while
 * the process runs, and keeping the last value, names the exact session the launch
 * ended on, with no guessing from file times and no clash with another terminal running
 * the same profile.
 */
export function followProcessSession(
  configDir: string,
  pid: number,
  intervalMs = 1000,
): { current: () => string | undefined; stop: () => void } {
  const file = join(configDir, 'sessions', `${pid}.json`);
  let last: string | undefined;

  const read = () => {
    try {
      const id = JSON.parse(readFileSync(file, 'utf-8'))?.sessionId;
      if (typeof id === 'string' && id) last = id;
    } catch {
      // not written yet, or already removed on exit — keep what we saw
    }
  };

  read();
  const timer = setInterval(read, intervalMs);
  timer.unref();

  return {
    current: () => last,
    stop: () => clearInterval(timer),
  };
}

/**
 * The session this profile ran whose transcript was written most recently at or after
 * `sinceMs` — the one a launch that started then was working on. Keyed on the
 * transcript, not the marker: a resumed session (`--continue`, `/resume`) keeps the
 * marker it got long ago, but its transcript is written to again.
 */
export function sessionTouchedSince(config: AimuxConfig, configDir: string, sinceMs: number): string | null {
  const mine = new Set(markersIn(configDir).map((m) => m.id));
  if (mine.size === 0) return null;

  const root = projectsRoot(config);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }

  let best: { id: string; mtime: number } | null = null;
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, dir));
    } catch {
      continue;
    }

    for (const file of files) {
      const id = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : '';
      if (!mine.has(id)) continue;
      let mtime: number;
      try {
        mtime = statSync(join(root, dir, file)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime >= sinceMs && (!best || mtime > best.mtime)) best = { id, mtime };
    }
  }
  return best?.id ?? null;
}

/** A session's transcript in the shared `projects/` tree, whichever project holds it. */
export function findTranscript(config: AimuxConfig, sessionId: string): string | null {
  const root = projectsRoot(config);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface QuotaHit {
  /** Claude's own window name: `five_hour`, `seven_day`, … */
  rateLimitType?: string;
  /** When that window frees up, epoch ms. */
  resetsAt?: number;
  /** When the hit was recorded, epoch ms. */
  at?: number;
}

/** Enough tail to hold the last few records even when tool output makes them large. */
const TAIL_BYTES = 256 * 1024;

/**
 * Whether a session stopped on an exhausted subscription.
 *
 * Claude Code records the hit itself: a synthetic assistant record with
 * `error: "rate_limit"` and `quotaLimits.status: "rejected"`, naming the window and its
 * reset. A transient server 429 carries no `quotaLimits`, so it never counts, and a hit
 * the session later got past is not the last reply any more. Only the file's tail is
 * read — transcripts run to hundreds of megabytes.
 */
export function sessionQuotaHit(transcriptPath: string): QuotaHit | null {
  let text: string;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: {
      type?: string;
      error?: string;
      timestamp?: string;
      quotaLimits?: { status?: string; rateLimitType?: string; resetsAt?: number };
    };
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue; // blank line, or the cut-off first line of the tail
    }
    if (record?.type !== 'assistant') continue;

    const quota = record.quotaLimits;
    if (record.error !== 'rate_limit' || quota?.status !== 'rejected') return null;
    const at = record.timestamp ? Date.parse(record.timestamp) : NaN;
    return {
      rateLimitType: quota.rateLimitType,
      resetsAt: typeof quota.resetsAt === 'number' ? quota.resetsAt * 1000 : undefined,
      at: Number.isNaN(at) ? undefined : at,
    };
  }
  return null;
}
