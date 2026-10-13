import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAimuxDir, setAimuxDir } from './paths.js';
import { codexCalls, openScanNotes, usageRows } from './transcriptIndex.js';

let root: string;
let originalAimuxDir: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aimux-index-'));
  originalAimuxDir = getAimuxDir();
  setAimuxDir(join(root, '.aimux'));
  mkdirSync(join(root, '.aimux'), { recursive: true });
  file = join(root, 'session-a.jsonl');
});
afterEach(() => {
  setAimuxDir(originalAimuxDir);
  rmSync(root, { recursive: true, force: true });
});

const reply = (requestId: string, output: number) => JSON.stringify({
  type: 'assistant',
  requestId,
  timestamp: '2026-05-14T00:00:00.000Z',
  cwd: '/srv/shop',
  message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: output } },
});
const noise = (size: number) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(size) } });

describe('usageRows', () => {
  it('finds each request, with what it cost and where it ran', () => {
    writeFileSync(file, `${noise(50)}\n${reply('r1', 5)}\n`);

    expect(usageRows(file, 0)).toEqual([{
      key: 'request:r1',
      at: Date.parse('2026-05-14T00:00:00.000Z'),
      sessionId: 'session-a',
      model: 'claude-opus-4-7',
      cwd: '/srv/shop',
      usage: [10, 0, 0, 5, 0],
    }]);
  });

  it('reads only what was appended since last time', () => {
    writeFileSync(file, `${noise(2000)}\n${reply('r1', 1)}\n`);
    usageRows(file, 0);

    // Scribble over the old request (past the head that identifies the file) and add a new
    // one: the old one is still there, because it was not read again.
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.from('#'.repeat(40)), 0, 40, 2100);
    closeSync(fd);
    appendFileSync(file, `${reply('r2', 2)}\n`);

    expect(usageRows(file, 0).map((r) => r.key)).toEqual(['request:r1', 'request:r2']);
  });

  it('starts over when the file is a different one under the same name', () => {
    writeFileSync(file, `${reply('r1', 1)}\n`);
    usageRows(file, 0);

    writeFileSync(file, `${reply('other', 9)}\n`);
    expect(usageRows(file, 0).map((r) => r.key)).toEqual(['request:other']);
  });

  it('starts over when the file got shorter than what was read', () => {
    writeFileSync(file, `${reply('r1', 5)}\n${reply('r2', 6)}\n`);
    usageRows(file, 0);

    writeFileSync(file, `${reply('r1', 5)}\n`);
    expect(usageRows(file, 0).map((row) => row.key)).toEqual(['request:r1']);
  });

  it('leaves a line that is still being written for the next read', () => {
    const whole = reply('r2', 2);
    writeFileSync(file, `${reply('r1', 1)}\n${whole.slice(0, 40)}`);
    expect(usageRows(file, 0).map((r) => r.key)).toEqual(['request:r1']);

    appendFileSync(file, `${whole.slice(40)}\n`);
    expect(usageRows(file, 0).map((r) => r.key)).toEqual(['request:r1', 'request:r2']);
  });

  it('counts a whole last line that has no newline yet, once', () => {
    writeFileSync(file, `${reply('r1', 1)}\n${reply('r2', 2)}`);
    expect(usageRows(file, 0)).toHaveLength(2);

    appendFileSync(file, `\n${reply('r3', 3)}\n`);
    expect(usageRows(file, 0).map((r) => r.key)).toEqual(['request:r1', 'request:r2', 'request:r3']);
  });

  it('handles lines that run across the chunks it reads in', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push(noise(700_000), reply(`r${i}`, i));
    writeFileSync(file, `${lines.join('\n')}\n`);

    expect(usageRows(file, 0).map((r) => r.key)).toEqual(['request:r0', 'request:r1', 'request:r2', 'request:r3', 'request:r4']);
  });

  it('keeps a request once when the transcript repeats it, across reads too', () => {
    writeFileSync(file, `${reply('r1', 5)}\n${reply('r1', 5)}\n`);
    expect(usageRows(file, 0)).toHaveLength(1);

    appendFileSync(file, `${reply('r1', 5)}\n${reply('r2', 6)}\n`);
    expect(usageRows(file, 0).map((row) => row.key)).toEqual(['request:r1', 'request:r2']);
  });

  it('reads from the top when what was kept is not an index', () => {
    writeFileSync(file, `${reply('r1', 5)}\n`);
    usageRows(file, 0);

    const kept = join(root, '.aimux', 'usage-index');
    for (const name of readdirSync(kept)) writeFileSync(join(kept, name), '{"v":2}');

    expect(usageRows(file, 0).map((row) => row.key)).toEqual(['request:r1']);
  });

  it('keeps what it knows to this user alone', () => {
    writeFileSync(file, `${reply('r1', 5)}\n`);
    usageRows(file, 0);

    const kept = join(root, '.aimux', 'usage-index');
    expect(statSync(kept).mode & 0o077).toBe(0);
    expect(statSync(join(kept, readdirSync(kept)[0])).mode & 0o077).toBe(0);
  });

  it('answers nothing for a file that is not there', () => {
    expect(usageRows(join(root, 'missing.jsonl'), 0)).toEqual([]);
  });
});

describe('codexCalls', () => {
  const ID = '0f2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'sess-1', cwd: '/srv/shop' } });
  const turn = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
  // One model call: the running total after it, and what the call itself spent.
  const call = (second: number, total: number, input: number, cached: number, output: number) => JSON.stringify({
    timestamp: `2026-06-28T10:00:0${second}.000Z`,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
  });
  const rollout = () => join(root, `rollout-2026-06-28T10-00-00-${ID}.jsonl`);
  const outputs = () => codexCalls(rollout(), 0).rows.map((row) => row.usage[3]);

  it('counts each call at its own time, the cached part of the input apart', () => {
    writeFileSync(rollout(), [meta, turn('gpt-6'), call(1, 110, 100, 40, 10), call(2, 330, 200, 150, 20)].join('\n') + '\n');

    expect(codexCalls(rollout(), 0).rows).toEqual([
      { key: 'codex:110:100:40:10', at: Date.parse('2026-06-28T10:00:01.000Z'), sessionId: 'sess-1', model: 'gpt-6', cwd: '/srv/shop', usage: [60, 0, 40, 10, 0] },
      { key: 'codex:330:200:150:20', at: Date.parse('2026-06-28T10:00:02.000Z'), sessionId: 'sess-1', model: 'gpt-6', cwd: '/srv/shop', usage: [50, 0, 150, 20, 0] },
    ]);
  });

  it('counts a call once when codex states its figures again', () => {
    const noUsage = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } });
    writeFileSync(rollout(), [meta, noUsage, call(1, 110, 100, 40, 10), call(2, 110, 100, 40, 10), call(3, 330, 200, 150, 20)].join('\n') + '\n');

    expect(outputs()).toEqual([10, 20]);
  });

  it('keeps counting when a resumed session starts its total over', () => {
    writeFileSync(rollout(), [meta, call(1, 110, 100, 40, 10), call(2, 330, 200, 150, 20), call(3, 55, 50, 0, 5)].join('\n') + '\n');

    expect(outputs()).toEqual([10, 20, 5]);
  });

  it('picks up where it stopped: the model in use and the last total', () => {
    writeFileSync(rollout(), [meta, turn('gpt-6'), call(1, 110, 100, 40, 10)].join('\n') + '\n');
    codexCalls(rollout(), 0).rows;

    appendFileSync(rollout(), [call(2, 110, 100, 40, 10), call(3, 330, 200, 150, 20)].join('\n') + '\n');

    const rows = codexCalls(rollout(), 0).rows;
    expect(rows.map((row) => [row.model, row.usage[3]])).toEqual([['gpt-6', 10], ['gpt-6', 20]]);
  });

  it('names the session by the file when the rollout does not, and prices an unnamed model as the flagship', () => {
    writeFileSync(rollout(), `${call(1, 110, 100, 40, 10)}\n`);

    expect(codexCalls(rollout(), 0).rows[0]).toMatchObject({ sessionId: ID, model: 'gpt-5-codex', cwd: null });
  });

  it('says where the session came from: a fork names its parent, and is not renamed by the parent\'s header that follows', () => {
    const own = JSON.stringify({ type: 'session_meta', payload: { id: 'fork-1', forked_from_id: 'root-1', cwd: '/srv/fork' } });
    const parents = JSON.stringify({ type: 'session_meta', payload: { id: 'root-1', cwd: '/srv/root' } });
    writeFileSync(rollout(), [own, parents, call(1, 110, 100, 40, 10)].join('\n') + '\n');

    expect(codexCalls(rollout(), 0)).toMatchObject({ sessionId: 'fork-1', forkedFrom: 'root-1', parent: 'root-1', rows: [{ sessionId: 'fork-1', cwd: '/srv/fork' }] });
  });

  it('names the thread a subagent was started from', () => {
    const nested = JSON.stringify({ type: 'session_meta', payload: { id: 'sub-1', source: { subagent: { thread_spawn: { parent_thread_id: 'main-1' } } } } });
    writeFileSync(rollout(), `${nested}\n`);
    expect(codexCalls(rollout(), 0)).toMatchObject({ sessionId: 'sub-1', parent: 'main-1' });
    expect(codexCalls(rollout(), 0).forkedFrom).toBeUndefined();
  });

  it('keeps two calls with the same figures: within a session they are two calls', () => {
    writeFileSync(rollout(), [meta, call(1, 110, 100, 40, 10), call(2, 330, 200, 150, 20), call(3, 110, 100, 40, 10)].join('\n') + '\n');

    expect(outputs()).toEqual([10, 20, 10]);
  });
});

describe('openScanNotes', () => {
  it('remembers what a scan learned about a file', () => {
    const first = openScanNotes();
    expect(first.get('/t/a.jsonl')).toBeUndefined();
    first.put('/t/a.jsonl', { size: 10, mtimeMs: 5, skip: true });
    first.save();

    expect(openScanNotes().get('/t/a.jsonl')).toEqual({ size: 10, mtimeMs: 5, skip: true });
  });

  it('starts empty when what was kept is not notes', () => {
    mkdirSync(join(root, '.aimux', 'usage-index'), { recursive: true });
    writeFileSync(join(root, '.aimux', 'usage-index', 'files.json'), '{"v":1}');

    expect(openScanNotes().get('/t/a.jsonl')).toBeUndefined();
  });

  it('forgets the files a full scan did not meet, and their indexes', () => {
    const gone = join(root, 'gone.jsonl');
    writeFileSync(file, `${reply('r1', 5)}\n`);
    writeFileSync(gone, `${reply('r2', 5)}\n`);
    usageRows(file, 0);
    usageRows(gone, 0);

    const notes = openScanNotes();
    notes.put(file, { size: 1, mtimeMs: 1 });
    notes.put(gone, { size: 1, mtimeMs: 1 });
    notes.prune(new Set([file]));
    notes.save();

    expect(openScanNotes().get(gone)).toBeUndefined();
    expect(openScanNotes().get(file)).toBeDefined();
    expect(readdirSync(join(root, '.aimux', 'usage-index')).sort()).toHaveLength(2); // one index, and the notes
  });
});
