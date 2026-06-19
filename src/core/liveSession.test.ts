import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildSessionArgs, openSession, type SessionEvent } from './liveSession.js';
import type { AimuxConfig } from '../types/index.js';

function makeConfig(): AimuxConfig {
  return {
    version: 1,
    shared_source: '/home/user/.claude',
    profiles: {
      main: { cli: 'claude', path: '/home/user/.claude', is_source: true },
      work: { cli: 'claude', path: '/home/user/.aimux/profiles/work', model: 'claude-opus-4-6' },
      backup: { cli: 'claude', path: '/home/user/.aimux/profiles/backup', model: 'claude-sonnet-4-6' },
    },
    private: ['.credentials.json'],
  } as AimuxConfig;
}

// A fake `claude` process: lets the test push stream-json lines and observe stdin.
class FakeProc extends EventEmitter {
  stdinWrites: string[] = [];
  stdin = { write: (s: string) => { this.stdinWrites.push(s); }, end: () => {} };
  stdout = new EventEmitter();
  killed = false;
  kill() { this.killed = true; }
  line(obj: unknown) { this.stdout.emit('data', JSON.stringify(obj) + '\n'); }
}

function spy() {
  const calls: { cli: string; args: string[]; env: Record<string, string> }[] = [];
  const procs: FakeProc[] = [];
  const spawnFn = ((cli: string, args: string[], o: { env?: Record<string, string> }) => {
    calls.push({ cli, args, env: o.env ?? {} });
    const p = new FakeProc();
    procs.push(p);
    return p;
  }) as unknown as typeof import('child_process').spawn;
  return { calls, procs, spawnFn };
}

describe('buildSessionArgs', () => {
  it('always includes the stream-json protocol flags + the session id on create', () => {
    const { args } = buildSessionArgs(makeConfig(), 'work', { sessionId: 'sid-1' }, false);
    for (const f of ['-p', '--input-format', 'stream-json', '--output-format']) expect(args).toContain(f);
    expect(args).toContain('--session-id');
    expect(args).toContain('sid-1');
    expect(args).not.toContain('--resume');
  });

  it('uses --resume (not --session-id) on recovery', () => {
    const { args } = buildSessionArgs(makeConfig(), 'work', { sessionId: 'sid-1' }, true);
    expect(args).toContain('--resume');
    expect(args).toContain('sid-1');
    expect(args).not.toContain('--session-id');
  });

  it('translates settings / mcp / permissions into claude flags', () => {
    const { args } = buildSessionArgs(
      makeConfig(), 'work',
      { sessionId: 's', settingsPath: '/x/settings.json', mcpConfigPath: '/x/mcp.json', allowedTools: ['Read', 'Bash'] },
      false,
    );
    expect(args).toContain('--settings');
    expect(args).toContain('/x/settings.json');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/x/mcp.json');
    expect(args).toContain('--allowedTools=Read,Bash');
  });

  it('bypassPermissions wins over allowedTools', () => {
    const { args } = buildSessionArgs(makeConfig(), 'work', { sessionId: 's', bypassPermissions: true, allowedTools: ['Read'] }, false);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args.some((a) => a.startsWith('--allowedTools'))).toBe(false);
  });

  it('carries the profile account (CLAUDE_CONFIG_DIR), model, and spine task id', () => {
    const { env, args } = buildSessionArgs(makeConfig(), 'work', { sessionId: 's', taskId: 't-1' }, false);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/user/.aimux/profiles/work');
    expect(env.LOOM_TASK_ID).toBe('t-1');
    expect(args).toContain('claude-opus-4-6'); // profile default model
  });
});

describe('openSession', () => {
  it('sends a turn and resolves with the result text, cost and denials', async () => {
    const { procs, spawnFn } = spy();
    const s = openSession(makeConfig(), 'work', { sessionId: 'sid', spawnFn });
    const events: SessionEvent[] = [];
    const p = s.send('hello', (e) => events.push(e));
    procs[0].line({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
    procs[0].line({ type: 'result', result: 'done', total_cost_usd: 0.5, permission_denials: [{ tool_name: 'WebFetch' }] });
    const r = await p;
    expect(r.text).toBe('done');
    expect(r.costUsd).toBe(0.5);
    expect(r.denials).toContain('WebFetch');
    expect(s.cost()).toBe(0.5);
    expect(s.denials()).toContain('WebFetch');
    // assistant text + a readable tool line were streamed
    const streamed = events.filter((e) => e.kind === 'assistant').map((e) => e.text).join('\n');
    expect(streamed).toContain('thinking');
    expect(streamed).toContain('Bash: ls');
    expect(procs[0].stdinWrites[0]).toContain('"hello"');
  });

  it('reuses ONE process across turns (no respawn while alive)', async () => {
    const { calls, procs, spawnFn } = spy();
    const s = openSession(makeConfig(), 'work', { sessionId: 'sid', spawnFn });
    let p = s.send('a'); procs[0].line({ type: 'result', result: '1' }); await p;
    p = s.send('b'); procs[0].line({ type: 'result', result: '2' }); await p;
    expect(calls.length).toBe(1);
  });

  it('settles a pending turn if the process dies (recoverable next send)', async () => {
    const { procs, spawnFn } = spy();
    const s = openSession(makeConfig(), 'work', { sessionId: 'sid', spawnFn });
    const p = s.send('x');
    procs[0].emit('close');
    const r = await p;
    expect(r.text).toContain('ended before replying');
  });

  it('relocate moves the next turn to another profile via --resume (same session id)', async () => {
    const { calls, procs, spawnFn } = spy();
    const s = openSession(makeConfig(), 'work', { sessionId: 'sid', spawnFn });
    let p = s.send('a'); procs[0].line({ type: 'result', result: '1' }); await p;
    expect(calls[0].args).toContain('--session-id');
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe('/home/user/.aimux/profiles/work');

    s.relocate('backup');
    p = s.send('b'); procs[1].line({ type: 'result', result: '2' }); await p;
    expect(calls[1].args).toContain('--resume');
    expect(calls[1].args).toContain('sid');
    expect(calls[1].env.CLAUDE_CONFIG_DIR).toBe('/home/user/.aimux/profiles/backup');
    expect(calls[1].args).toContain('claude-sonnet-4-6'); // backup profile's model
    expect(procs[0].killed).toBe(true);
  });

  it('times out a stuck turn, kills the process, and surfaces it', async () => {
    const { procs, spawnFn } = spy();
    const s = openSession(makeConfig(), 'work', { sessionId: 'sid', spawnFn, replyTimeoutMs: 5 });
    const r = await s.send('hang'); // no result emitted → watchdog fires
    expect(r.text).toContain('did not respond within the time limit');
    expect(procs[0].killed).toBe(true);
  });

  it('a session opened with resume:true recovers on the FIRST send (host-restart)', async () => {
    const { calls, procs, spawnFn } = spy();
    const s = openSession(makeConfig(), 'work', { sessionId: 'sid', resume: true, spawnFn });
    const p = s.send('a'); procs[0].line({ type: 'result', result: '1' }); await p;
    expect(calls[0].args).toContain('--resume');
    expect(calls[0].args).not.toContain('--session-id');
  });
});
