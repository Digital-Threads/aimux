import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import { findTranscript, newestSessionSince, ownerAt, sessionOwners, sessionQuotaHit } from './sessionMarkers.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aimux-markers-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const source = () => join(root, 'claude');
const profileDir = (name: string) => join(root, 'profiles', name);

function config(): AimuxConfig {
  return {
    version: 1,
    shared_source: source(),
    private: [],
    profiles: {
      main: { cli: 'claude', path: source(), is_source: true },
      work: { cli: 'claude', path: profileDir('work') },
      cx: { cli: 'codex', path: profileDir('cx') },
    },
  };
}

function marker(configDir: string, sessionId: string) {
  mkdirSync(join(configDir, 'session-env', sessionId), { recursive: true });
}

/** Birth times are real clock readings; a short pause keeps "before" and "after" apart. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('sessionOwners', () => {
  it('attributes a session to the profile whose config dir holds its session-env marker', () => {
    marker(profileDir('work'), 'sess-a');
    expect(sessionOwners(config()).get('sess-a')?.map((o) => o.profile)).toEqual(['work']);
  });

  it('ignores source markers from before any profile had its own session-env — they may be anyone\'s', async () => {
    // Until aimux made session-env private, every profile wrote into the source's copy.
    marker(source(), 'shared-era');
    await pause();
    marker(profileDir('work'), 'sess-work');
    await pause();
    marker(source(), 'main-own');

    const owners = sessionOwners(config());
    expect(owners.has('shared-era')).toBe(false);
    expect(owners.get('main-own')?.map((o) => o.profile)).toEqual(['main']);
  });

  it('ignores the source entirely while a profile still reaches it through a symlink', () => {
    marker(source(), 'ambiguous');
    mkdirSync(profileDir('work'), { recursive: true });
    symlinkSync(join(source(), 'session-env'), join(profileDir('work'), 'session-env'));

    expect(sessionOwners(config()).has('ambiguous')).toBe(false);
  });

  it('lists every profile that opened a resumed session, in the order they did', async () => {
    marker(profileDir('work'), 'moved');
    await pause();
    marker(source(), 'moved');
    expect(sessionOwners(config()).get('moved')?.map((o) => o.profile)).toEqual(['work', 'main']);
  });

  it('does not read codex profiles, which keep no session-env', () => {
    marker(profileDir('cx'), 'codex-thing');
    expect(sessionOwners(config()).has('codex-thing')).toBe(false);
  });
});

describe('newestSessionSince', () => {
  it('returns the newest session started in a config dir at or after the given time', async () => {
    marker(profileDir('work'), 'before');
    await pause();
    const since = Date.now();
    // File times come from the kernel's coarse clock and can trail Date.now() by a few
    // ms; a real session creates its marker far later than that after launch.
    await pause();
    marker(profileDir('work'), 'during');
    expect(newestSessionSince(profileDir('work'), since)).toBe('during');
  });

  it('returns null when no session started in that window', () => {
    marker(profileDir('work'), 'before');
    expect(newestSessionSince(profileDir('work'), Date.now() + 60_000)).toBeNull();
    expect(newestSessionSince(profileDir('missing'), 0)).toBeNull();
  });
});

describe('findTranscript', () => {
  it('finds a session transcript in whichever project dir holds it', () => {
    mkdirSync(join(source(), 'projects', '-home-me-app'), { recursive: true });
    writeFileSync(join(source(), 'projects', '-home-me-app', 'sess-a.jsonl'), '');
    expect(findTranscript(config(), 'sess-a')).toBe(join(source(), 'projects', '-home-me-app', 'sess-a.jsonl'));
    expect(findTranscript(config(), 'nope')).toBeNull();
  });
});

describe('sessionQuotaHit', () => {
  const file = () => join(root, 't.jsonl');
  const write = (records: unknown[]) => writeFileSync(file(), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // The exact shape Claude Code writes when a subscription window is exhausted.
  const quotaHit = {
    type: 'assistant',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789141200 },
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }] },
  };
  const reply = { type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [] } };

  it('recognizes a session that ended on an exhausted subscription', () => {
    write([reply, quotaHit]);
    expect(sessionQuotaHit(file())).toEqual({ rateLimitType: 'five_hour', resetsAt: 1789141200 * 1000 });
  });

  it('ignores a transient server 429, which carries no quota verdict', () => {
    const transient = { ...quotaHit, quotaLimits: undefined, message: { ...quotaHit.message, content: [{ type: 'text', text: 'Server is temporarily limiting requests' }] } };
    write([reply, transient]);
    expect(sessionQuotaHit(file())).toBeNull();
  });

  it('ignores a hit the session already got past', () => {
    write([quotaHit, reply]);
    expect(sessionQuotaHit(file())).toBeNull();
  });

  it('looks at the last reply, not at the user messages typed after the hit', () => {
    write([reply, quotaHit, { type: 'user', message: { role: 'user', content: 'still there?' } }]);
    expect(sessionQuotaHit(file())?.rateLimitType).toBe('five_hour');
  });
});

describe('ownerAt', () => {
  const owners = [{ profile: 'work', since: 1000 }, { profile: 'main', since: 5000 }];

  it('credits a turn to the profile that had the session at that moment', () => {
    expect(ownerAt(owners, 1000)).toBe('work');
    expect(ownerAt(owners, 4999)).toBe('work');
    expect(ownerAt(owners, 5000)).toBe('main');
  });

  it('credits nobody for a turn from before any profile opened the session', () => {
    // A session resumed here after starting elsewhere: its early turns are not ours.
    expect(ownerAt(owners, 999)).toBeUndefined();
    expect(ownerAt(undefined, 9999)).toBeUndefined();
  });
});
