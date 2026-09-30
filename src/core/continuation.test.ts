import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import type { RateLimitProbe } from './limits.js';
import { planContinuation } from './continuation.js';

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

    const plan = await planContinuation(config(), 'work', 0, probe);

    expect(plan?.sessionId).toBe('sess-1');
    expect(plan?.hit.rateLimitType).toBe('five_hour');
    expect(plan?.next?.profile).toBe('spare');
    // Never the profile that just ran out, and never a different CLI.
    expect(probed.some((p) => p.endsWith('work') || p.endsWith('cx'))).toBe(false);
  });

  it('says so when no other subscription has room', async () => {
    sessionEndingWith(quotaHit);
    const plan = await planContinuation(config(), 'work', 0, async () => status(100, 50));
    expect(plan?.sessionId).toBe('sess-1');
    expect(plan?.next).toBeNull();
  });

  it('offers nothing when the window already reset while the session sat idle', async () => {
    // The same subscription has room again — there is nothing to move.
    sessionEndingWith({ ...quotaHit, quotaLimits: { ...quotaHit.quotaLimits, resetsAt: 1_000_000 } });
    let calls = 0;
    const plan = await planContinuation(config(), 'work', 0, async () => { calls++; return status(0, 0); });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });

  it('offers nothing — and probes nothing — for a session that did not hit a limit', async () => {
    sessionEndingWith({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } });
    let calls = 0;
    const plan = await planContinuation(config(), 'work', 0, async () => { calls++; return status(0, 0); });
    expect(plan).toBeNull();
    expect(calls).toBe(0);
  });
});
