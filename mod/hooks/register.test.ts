import { describe, expect, mock, test } from 'claude-code/testing';
import type { On, SessionRateLimit } from 'claude-code';

const LIMITS = {
  fetchedAt: 0,
  profiles: {
    dt: { cli: 'claude', status: { fiveHourPct: 48, weeklyPct: 12 } },
    main: { cli: 'claude', status: { fiveHourPct: 13, weeklyPct: 17 } },
    busy: { cli: 'claude', status: { fiveHourPct: 5, weeklyPct: 100 } },
    cx: { cli: 'codex', status: { fiveHourPct: null, weeklyPct: 25 } },
    old: { cli: 'claude', status: null, error: 'auth' },
  },
};

const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false });

/** The engine's own answers beneath the plugins, for the events a test raises. */
function engineBeneath(on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.measure', (_$, e) => ({ changed: e.changed }));
}

/** A session aimux launched as `dt`, with aimux answering `status --json` (or failing). */
function launchedByAimux(on: On, answer = ran(JSON.stringify(LIMITS))) {
  engineBeneath(on);
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[], runs: [] as (readonly string[])[] };

  mock.env(on, { AIMUX_RUN_PROFILE: 'dt', AIMUX_SELF: '["node","/aimux/dist/cli.js"]' });
  on('process.run', (_$, e) => {
    seen.runs.push(e.argv);
    return { value: answer };
  });
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });

  return seen;
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const;
const measure = (rateLimits: SessionRateLimit[]) => ({ context: { window: 1_000_000 }, rateLimits, changed: ['rateLimits' as const] });

describe('aimux mod', () => {
  test('shows every subscription, this one marked, without holding up the first prompt', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);

    await $.session.start(START);
    expect(seen.runs).toEqual([]);

    await clock.settle();
    expect(seen.runs).toEqual([['node', '/aimux/dist/cli.js', 'status', '--json', '--max-age', '240']]);
    expect(seen.statuses.at(-1)).toBe('5h/7d %  ▸dt 48/12 · main 13/17 · busy 5/100 · cx –/25 · old login?');
  });

  test('takes this session\'s own figures from its responses', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 61.4 }, { kind: 'seven_day', percentUsed: 14 }]));
    expect(seen.statuses.at(-1)).toContain('▸dt 61/14 · main 13/17');
  });

  test('asks aimux again only once the figures are five minutes old', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([]));
    await clock.settle();
    expect(seen.runs).toHaveLength(1);

    await clock.advance(5 * 60_000);
    await $.session.measure(measure([]));
    await clock.settle();
    expect(seen.runs).toHaveLength(2);
  });

  test('warns once per window before it runs out, naming the freest other subscription', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    const nearlySpent = { kind: 'five_hour', percentUsed: 92, resetsAt: '2026-10-04T18:00:00Z' };
    await $.session.measure(measure([nearlySpent]));
    await $.session.measure(measure([{ ...nearlySpent, percentUsed: 95 }]));

    // `busy` has the emptiest 5-hour window but a spent week; codex cannot take a claude session.
    expect(seen.toasts).toEqual([
      'dt has used 92% of its 5-hour window. Freest now: main (5h 13%, 7d 17%). '
        + 'When this one runs out, exit and aimux will offer to continue there.',
    ]);
  });

  test('names no subscription that has less room than this one', async ($, on) => {
    // main's 5-hour window is empty but its week is nearly gone: dt would outlast it.
    const clock = mock.clock(on);
    const tight = { fetchedAt: 0, profiles: { main: { cli: 'claude', status: { fiveHourPct: 5, weeklyPct: 99 } } } };
    const seen = launchedByAimux(on, ran(JSON.stringify(tight)));
    await $.session.start(START);
    await clock.settle();

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 91, resetsAt: 'r1' }, { kind: 'seven_day', percentUsed: 10 }]));
    expect(seen.toasts).toEqual(['dt has used 91% of its 5-hour window. No other claude subscription has more room right now.']);
  });

  test('waits for aimux before warning, and says so when aimux could not answer', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, ran('', 1));
    await $.session.start(START);

    // The first reply can land before the first reading: no notice yet, none lost.
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 92, resetsAt: 'r1' }]));
    expect(seen.toasts).toEqual([]);

    await clock.settle();
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 93, resetsAt: 'r1' }]));
    expect(seen.toasts).toEqual(['dt has used 93% of its 5-hour window. aimux could not read the other subscriptions.']);
  });

  test('does not start a failing aimux after every response', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on, ran('', 1));
    await $.session.start(START);
    await clock.settle();

    for (let i = 0; i < 3; i++) {
      await $.session.measure(measure([]));
      await clock.settle();
    }
    expect(seen.runs).toHaveLength(1);
  });

  test('warns again about a window with no reset time once it eased back', async ($, on) => {
    const clock = mock.clock(on);
    const seen = launchedByAimux(on);
    await $.session.start(START);
    await clock.settle();

    for (const percentUsed of [92, 80, 93]) await $.session.measure(measure([{ kind: 'seven_day', percentUsed }]));
    expect(seen.toasts).toHaveLength(2);
  });

  test('stays silent in a session aimux did not launch', async ($, on) => {
    const clock = mock.clock(on);
    engineBeneath(on);
    mock.env(on, {});
    let runs = 0;
    on('process.run', () => {
      runs++;
      return { value: ran('{}') };
    });
    const statuses: (string | undefined)[] = [];
    on('ui.status', (_$, e) => {
      statuses.push(e.text);
      return { value: undefined };
    });

    await $.session.start(START);
    await clock.settle();
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 99 }]));

    expect(runs).toBe(0);
    expect(statuses).toEqual([]);
  });
});
