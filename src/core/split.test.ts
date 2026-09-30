import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { keepOpenOnFailure, openSplit } from './split.js';

/** Records tmux calls and hands out pane ids the way `-P -F '#{pane_id}'` would. */
function fakeTmux() {
  const calls: string[][] = [];
  const attached: string[][] = [];
  let pane = 0;
  return {
    calls,
    attached,
    deps: {
      tmux(args: string[]) {
        calls.push(args);
        return args.includes('-P') ? `%${pane++}\n` : '';
      },
      attach(args: string[]) { attached.push(args); },
    },
  };
}

const run = (profile: string) => `aimux run ${profile}`;

describe('openSplit', () => {
  it('opens one pane per subscription in a new tmux session and attaches to it', () => {
    const t = fakeTmux();
    openSplit({ profiles: ['dt', 'pl', 'plat'], cwd: '/work', command: run, insideTmux: false, sessionName: 'aimux-x' }, t.deps);

    const verbs = t.calls.map((c) => c[0]);
    expect(verbs[0]).toBe('new-session');
    expect(t.calls[0]).toContain('aimux run dt');
    expect(t.calls.filter((c) => c[0] === 'split-window').map((c) => c.at(-1))).toEqual(['aimux run pl', 'aimux run plat']);
    expect(t.attached).toEqual([
      ['attach-session', '-t', 'aimux-x', ';', 'set-option', '-t', 'aimux-x', 'destroy-unattached', 'on'],
    ]);
  });

  it('ends its session when the window closes, like any other terminal', () => {
    // Set only once attached: tmux destroys an unattached session with the option at once.
    const t = fakeTmux();
    openSplit({ profiles: ['dt'], cwd: '/work', command: run, insideTmux: false, sessionName: 's' }, t.deps);
    expect(t.calls.some((c) => c.includes('destroy-unattached'))).toBe(false);
    expect(t.attached[0].slice(-2)).toEqual(['destroy-unattached', 'on']);
  });

  it('labels every pane with its subscription, so you can tell them apart', () => {
    const t = fakeTmux();
    openSplit({ profiles: ['dt', 'pl'], cwd: '/work', command: run, insideTmux: false, sessionName: 's' }, t.deps);

    // A pane option, not the pane title: claude sets the terminal title itself and
    // would overwrite a title-based label the moment it starts.
    const labels = t.calls.filter((c) => c.includes('@aimux_profile'));
    expect(labels).toEqual([
      ['set-option', '-p', '-t', '%0', '@aimux_profile', 'dt'],
      ['set-option', '-p', '-t', '%1', '@aimux_profile', 'pl'],
    ]);
    expect(t.calls).toContainEqual(['set-option', '-w', '-t', '%0', 'pane-border-status', 'top']);
    expect(t.calls).toContainEqual(['set-option', '-w', '-t', '%0', 'pane-border-format', ' #{@aimux_profile} ']);
  });

  it('starts every pane in the current directory', () => {
    const t = fakeTmux();
    openSplit({ profiles: ['dt', 'pl'], cwd: '/work/app', command: run, insideTmux: false, sessionName: 's' }, t.deps);
    for (const c of t.calls.filter((c) => c[0] === 'new-session' || c[0] === 'split-window')) {
      expect(c[c.indexOf('-c') + 1]).toBe('/work/app');
    }
  });

  it('opens a new window instead of a nested session when already inside tmux', () => {
    const t = fakeTmux();
    openSplit({ profiles: ['dt', 'pl'], cwd: '/work', command: run, insideTmux: true, sessionName: 's' }, t.deps);

    expect(t.calls[0][0]).toBe('new-window');
    expect(t.calls.some((c) => c[0] === 'new-session')).toBe(false);
    expect(t.attached).toEqual([]);
  });
});

describe('openSplit when tmux fails half way', () => {
  const failingOn = (verb: string) => {
    const t = fakeTmux();
    const tmux = t.deps.tmux;
    t.deps.tmux = (args: string[]) => {
      if (args[0] === verb) {
        t.calls.push(args);
        throw new Error(`can't find pane`);
      }
      return tmux(args);
    };
    return t;
  };

  it('kills the half-built session instead of leaving it running detached', () => {
    const t = failingOn('split-window');
    expect(() => openSplit({ profiles: ['a', 'b'], cwd: '/w', command: run, insideTmux: false, sessionName: 's' }, t.deps)).toThrow();
    expect(t.calls).toContainEqual(['kill-session', '-t', 's']);
    expect(t.attached).toEqual([]);
  });

  it('closes the half-built window when it was opened inside tmux', () => {
    const t = failingOn('split-window');
    expect(() => openSplit({ profiles: ['a', 'b'], cwd: '/w', command: run, insideTmux: true, sessionName: 's' }, t.deps)).toThrow();
    expect(t.calls).toContainEqual(['kill-window', '-t', '%0']);
  });
});

describe('keepOpenOnFailure', () => {
  // A pane closes the moment its command exits, taking any error message with it.
  it('keeps a failed pane open with a note until Enter is pressed, and still reports the failure', () => {
    const run = spawnSync('sh', ['-c', keepOpenOnFailure("echo 'Error: profile not logged in'; exit 3")], { input: '\n', encoding: 'utf-8' });
    expect(run.stdout).toContain('Error: profile not logged in');
    expect(run.stdout).toContain('Press Enter to close');
    expect(run.status).toBe(3);
  });

  it('lets a pane that ended normally close without waiting', () => {
    const out = execFileSync('sh', ['-c', keepOpenOnFailure('echo done')], { input: '', encoding: 'utf-8' });
    expect(out).toBe('done\n');
  });
});
