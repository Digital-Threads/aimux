import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import type { RateLimitProbe } from './limits.js';
import { continuationArgs, planContinuation, runWithContinuation, sessionIdFromArgs, type ContinuationPlan, type RunDeps } from './continuation.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aimux-continue-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const source = () => join(root, 'claude');
const profileDir = (name: string) => join(root, 'profiles', name);

function config(): AimuxConfig {
  const profiles: AimuxConfig['profiles'] = { main: { cli: 'claude', path: source(), is_source: true } };
  for (const name of ['work', 'spare', 'busy']) {
    mkdirSync(profileDir(name), { recursive: true });
    writeFileSync(join(profileDir(name), '.credentials.json'), '{}');
    profiles[name] = { cli: 'claude', path: profileDir(name) };
  }
  mkdirSync(profileDir('cx'), { recursive: true });
  writeFileSync(join(profileDir('cx'), 'auth.json'), '{}');
  profiles.cx = { cli: 'codex', path: profileDir('cx') };
  return { version: 1, shared_source: source(), private: [], profiles };
}

/** A session `work` ran, whose transcript ends on the given record. */
function sessionEndingWith(record: unknown) {
  mkdirSync(join(profileDir('work'), 'session-env', 'sess-1'), { recursive: true });
  mkdirSync(join(source(), 'projects', '-home-me-app'), { recursive: true });
  writeFileSync(join(source(), 'projects', '-home-me-app', 'sess-1.jsonl'), JSON.stringify(record) + '\n');
}

const FAR_FUTURE = 4102444800; // 2100-01-01, epoch seconds
const quotaHit = {
  type: 'assistant',
  error: 'rate_limit',
  quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: FAR_FUTURE },
  message: { model: '<synthetic>', role: 'assistant', content: [] },
};

const status = (five: number, week: number): RateLimitProbe => ({ status: { fiveHourPct: five, weeklyPct: week } });

describe('planContinuation', () => {
  it('offers the freest other claude subscription for a session that hit its limit', async () => {
    sessionEndingWith(quotaHit);
    const probed: string[] = [];
    const probe = async (_p: unknown, path: string) => {
      probed.push(path);
      return path.endsWith('spare') ? status(10, 20) : status(95, 40);
    };

    const plan = await planContinuation(config(), 'work', { since: 0 }, probe);

    expect(plan?.sessionId).toBe('sess-1');
    expect(plan?.hit.rateLimitType).toBe('five_hour');
    expect(plan?.next?.profile).toBe('spare');
    // Never the profile that just ran out, and never a different CLI.
    expect(probed.some((p) => p.endsWith('work') || p.endsWith('cx'))).toBe(false);
  });

  it('says so when no other subscription has room', async () => {
    sessionEndingWith(quotaHit);
    const plan = await planContinuation(config(), 'work', { since: 0 }, async () => status(100, 50));
    expect(plan?.sessionId).toBe('sess-1');
    expect(plan?.next).toBeNull();
  });

  it('offers nothing when the window already reset while the session sat idle', async () => {
    // The same subscription has room again — there is nothing to move.
    sessionEndingWith({ ...quotaHit, quotaLimits: { ...quotaHit.quotaLimits, resetsAt: 1_000_000 } });
    let calls = 0;
    const plan = await planContinuation(config(), 'work', { since: 0 }, async () => { calls++; return status(0, 0); });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });

  it('ignores a hit an earlier run left in the transcript', async () => {
    // A session continued elsewhere still ends on the old hit until someone replies in it:
    // opening it and quitting at once must not be read as the new profile running out.
    sessionEndingWith({ ...quotaHit, timestamp: new Date(1_000_000).toISOString() });
    const plan = await planContinuation(config(), 'work', { since: 2_000_000 }, async () => status(0, 0));
    expect(plan).toBeNull();
  });

  it('offers nothing — and probes nothing — for a session that did not hit a limit', async () => {
    sessionEndingWith({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } });
    let calls = 0;
    const plan = await planContinuation(config(), 'work', { since: 0 }, async () => { calls++; return status(0, 0); });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('planContinuation — which session', () => {
  const writeSession = (id: string, record: unknown) => {
    mkdirSync(join(profileDir('work'), 'session-env', id), { recursive: true });
    mkdirSync(join(source(), 'projects', '-home-me-app'), { recursive: true });
    writeFileSync(join(source(), 'projects', '-home-me-app', `${id}.jsonl`), JSON.stringify(record) + '\n');
  };
  const normal = { type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } };
  const pause = () => new Promise((r) => setTimeout(r, 30));

  it('checks the session it launched, not a newer one another terminal started under the same profile', async () => {
    writeSession('mine', quotaHit);
    await pause();
    writeSession('theirs', normal); // newer marker, newer transcript — but not ours
    const plan = await planContinuation(config(), 'work', { id: 'mine', since: 0 }, async () => status(10, 10));
    expect(plan?.sessionId).toBe('mine');
  });

  it('finds a resumed older session by its transcript being written since launch', async () => {
    // `aimux run work --continue`: the marker predates the launch, the transcript does not.
    writeSession('older', normal);
    await pause();
    const since = Date.now();
    await pause();
    writeSession('older', quotaHit);
    const plan = await planContinuation(config(), 'work', { since }, async () => status(10, 10));
    expect(plan?.sessionId).toBe('older');
  });
});

describe('continuationArgs', () => {
  it('keeps the flags the session was started with', () => {
    expect(continuationArgs(['--dangerously-skip-permissions', '--add-dir', '../lib', '--permission-mode', 'plan'], 's1'))
      .toEqual(['--dangerously-skip-permissions', '--add-dir', '../lib', '--permission-mode', 'plan', '--resume', 's1']);
  });

  it('drops whatever picked the old session, so only the new --resume decides', () => {
    expect(continuationArgs(['--resume', 'old', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--resume=old'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['-r', 'old'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['--resume', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--continue', '--fork-session'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['-c'], 's1')).toEqual(['--resume', 's1']);
    expect(continuationArgs(['--session-id', 'abc', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--from-pr', '123', '--verbose'], 's1')).toEqual(['--verbose', '--resume', 's1']);
    expect(continuationArgs(['--teleport'], 's1')).toEqual(['--resume', 's1']);
  });

  it('does not send the opening prompt a second time', () => {
    expect(continuationArgs(['fix the login bug', '--add-dir', 'x'], 's1')).toEqual(['--add-dir', 'x', '--resume', 's1']);
  });
});

describe('sessionIdFromArgs', () => {
  const ID = '0f2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b';

  it('reads the session a launch names', () => {
    expect(sessionIdFromArgs(['--resume', ID])).toBe(ID);
    expect(sessionIdFromArgs(['-r', ID, '--verbose'])).toBe(ID);
    expect(sessionIdFromArgs([`--resume=${ID}`])).toBe(ID);
    expect(sessionIdFromArgs(['--session-id', ID])).toBe(ID);
  });

  it('does not take a picker search term for a session id', () => {
    // `claude --resume auth-bug` opens the picker filtered by "auth-bug".
    expect(sessionIdFromArgs(['--resume', 'auth-bug'])).toBeUndefined();
  });

  it('knows no id when --fork-session moves the conversation to a new one', () => {
    expect(sessionIdFromArgs(['--resume', ID, '--fork-session'])).toBeUndefined();
  });

  it('knows no id when the launch leaves the choice to claude', () => {
    expect(sessionIdFromArgs(['--continue'])).toBeUndefined();
    expect(sessionIdFromArgs(['--resume'])).toBeUndefined();
    expect(sessionIdFromArgs([])).toBeUndefined();
  });
});

describe('runWithContinuation', () => {
  const HIT: ContinuationPlan['hit'] = { rateLimitType: 'five_hour', resetsAt: FAR_FUTURE * 1000 };
  const room = (profile: string) => ({ profile, status: { fiveHourPct: 10, weeklyPct: 20 } });

  /** A run whose launches exit with `codes` in turn, and whose sessions hit a limit per `plans`. */
  function scripted(plans: Array<ContinuationPlan | null>, opts: { answer?: boolean; agreed?: string[]; codes?: number[] } = {}) {
    const seen = { launches: [] as Array<[string, string[]]>, prepared: [] as string[], asked: [] as string[], said: [] as string[] };
    const deps: RunDeps = {
      prepare: (profile) => { seen.prepared.push(profile); },
      launch: async (profile, args) => {
        const n = seen.launches.push([profile, args]) - 1;
        return { code: opts.codes?.[n] ?? 0, since: n, sessionId: `s${n}`, moveAgreed: opts.agreed?.[n] };
      },
      plan: async () => plans.shift() ?? null,
      ask: (question) => { seen.asked.push(question); return opts.answer ?? true; },
      say: (line) => { seen.said.push(line); },
    };
    return { seen, deps };
  }

  it('runs once and hands back the exit code when no limit was hit', async () => {
    const { seen, deps } = scripted([null], { codes: [3] });
    expect(await runWithContinuation('work', ['--verbose'], true, deps)).toBe(3);
    expect(seen.launches).toEqual([['work', ['--verbose']]]);
    expect(seen.asked).toEqual([]);
  });

  it('asks, then resumes the same session on the freest subscription with the user\'s flags', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }, null], { codes: [0, 7] });

    expect(await runWithContinuation('work', ['--add-dir', 'x'], true, deps)).toBe(7);
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0]).toContain('work hit its 5-hour limit');
    expect(seen.asked[0]).toContain('Continue this session on spare (5h 10%, 7d 20%)? [Y/n]');
    expect(seen.launches).toEqual([['work', ['--add-dir', 'x']], ['spare', ['--add-dir', 'x', '--resume', 'abc']]]);
    expect(seen.prepared).toEqual(['work', 'spare']);
  });

  it('stops when the user says no', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }], { answer: false, codes: [5] });
    expect(await runWithContinuation('work', [], true, deps)).toBe(5);
    expect(seen.launches).toHaveLength(1);
  });

  it('moves without asking when the person already agreed inside claude', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: room('spare') }, null], { agreed: ['spare'] });
    await runWithContinuation('work', [], true, deps);

    expect(seen.asked).toEqual([]);
    expect(seen.said.join('\n')).toContain('Continuing this session on spare (5h 10%, 7d 20%).');
    expect(seen.launches.map(([profile]) => profile)).toEqual(['work', 'spare']);
  });

  it('says how to carry on when the person agreed to move but no spent limit was recorded', async () => {
    // The mod offered the move after a refused turn; the transcript shows no spent window,
    // so aimux does not move on its own — but it must not just exit without a word.
    const { seen, deps } = scripted([null], { agreed: ['spare'], codes: [4] });

    expect(await runWithContinuation('work', [], true, deps)).toBe(4);
    expect(seen.launches).toHaveLength(1);
    expect(seen.said.join('\n')).toContain('aimux run spare --resume s0');
  });

  it('says so and stops when no other subscription has room', async () => {
    const { seen, deps } = scripted([{ sessionId: 'abc', hit: HIT, next: null }]);
    await runWithContinuation('work', [], true, deps);

    expect(seen.said.join('\n')).toContain('no other claude subscription has room right now');
    expect(seen.launches).toHaveLength(1);
    expect(seen.asked).toEqual([]);
  });

  it('keeps moving when the next subscription runs out too', async () => {
    const { seen, deps } = scripted([
      { sessionId: 'abc', hit: HIT, next: room('spare') },
      { sessionId: 'abc', hit: HIT, next: room('third') },
      null,
    ]);
    await runWithContinuation('work', ['-c'], true, deps);

    // Whatever picked the old session is dropped each time; only the new --resume decides.
    expect(seen.launches).toEqual([['work', ['-c']], ['spare', ['--resume', 'abc']], ['third', ['--resume', 'abc']]]);
  });

  it('never looks for a limit when the launch has no conversation to carry on', async () => {
    let planned = 0;
    const { seen, deps } = scripted([]);
    deps.plan = async () => { planned++; return null; };

    expect(await runWithContinuation('work', ['-p', 'hi'], false, deps)).toBe(0);
    expect(planned).toBe(0);
    expect(seen.launches).toHaveLength(1);
  });
});
