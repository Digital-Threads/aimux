import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import type { RateLimitProbe } from './limits.js';
import { continuationArgs, planContinuation, sessionIdFromArgs } from './continuation.js';

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
