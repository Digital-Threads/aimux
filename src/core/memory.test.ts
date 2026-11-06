import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportMemory, memoryOverview, projectDirName, readMemory } from './memory.js';

let root: string;
let dir: string;

const note = (file: string, name: string, description: string, type = 'feedback', body = 'body') =>
  writeFileSync(join(dir, file), `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aimux-memory-'));
  dir = join(root, 'projects', '-srv-shop', 'memory');
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('projectDirName', () => {
  it("names a project's folder the way claude does: every non-alphanumeric becomes a dash", () => {
    expect(projectDirName('/home/u/www/loom/aimux')).toBe('-home-u-www-loom-aimux');
    expect(projectDirName('/srv/my.app_v2')).toBe('-srv-my-app-v2');
  });
});

describe('readMemory', () => {
  it('lists the notes with their name, type and description, the index left out', () => {
    note('a.md', 'deploy-steps', 'How we deploy', 'project');
    writeFileSync(join(dir, 'MEMORY.md'), '- [Deploy](a.md) — steps\n');

    expect(readMemory(dir).notes).toMatchObject([{ file: 'a.md', name: 'deploy-steps', description: 'How we deploy', type: 'project' }]);
  });

  it('reads a quoted description with the quotes inside it unescaped', () => {
    writeFileSync(join(dir, 'q.md'), '---\nname: q\ndescription: "keep its \\"merged\\" badge"\n---\nx\n');

    expect(readMemory(dir).notes[0]?.description).toBe('keep its "merged" badge');
  });

  it('reads a type kept at the top level, as older notes have it', () => {
    writeFileSync(join(dir, 'old.md'), '---\nname: old\ndescription: d\ntype: user\n---\nx\n');

    expect(readMemory(dir).notes[0]?.type).toBe('user');
  });

  it('flags notes saved twice: the same name, or the same description in other words of case and spacing', () => {
    note('a.md', 'no-push', 'Never push without asking');
    note('b.md', 'no-push', 'Something else');
    note('c.md', 'ask-first', 'never  push without asking.');
    note('d.md', 'unrelated', 'Use pnpm');

    expect(readMemory(dir).duplicates).toEqual([['a.md', 'b.md'], ['a.md', 'c.md']]);
  });

  it('says which notes the index leaves out and which index lines point at nothing', () => {
    note('a.md', 'a', 'A');
    note('b.md', 'b', 'B');
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — a\n- [Gone](gone.md) — deleted\n');

    expect(readMemory(dir)).toMatchObject({ unindexed: ['b.md'], missing: ['gone.md'] });
  });

  it('reads a project with no memory as empty', () => {
    expect(readMemory(join(root, 'nope'))).toMatchObject({ notes: [], duplicates: [], unindexed: [], missing: [] });
  });
});

describe('exportMemory', () => {
  it('copies notes and the index into the repo, leaves equal ones, and never overwrites one that differs', () => {
    note('a.md', 'a', 'A');
    note('b.md', 'b', 'B');
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md)\n');
    const target = join(root, 'repo', '.claude', 'memory');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.md'), readFileSync(join(dir, 'a.md')));
    writeFileSync(join(target, 'b.md'), 'edited in the repo');

    expect(exportMemory(dir, target)).toEqual({ copied: ['MEMORY.md'], same: ['a.md'], differs: ['b.md'] });
    expect(readFileSync(join(target, 'b.md'), 'utf-8')).toBe('edited in the repo');
    expect(readFileSync(join(target, 'MEMORY.md'), 'utf-8')).toBe('- [A](a.md)\n');
  });
});

describe('memoryOverview', () => {
  it('counts notes and duplicates per project, skipping projects with none', () => {
    note('a.md', 'x', 'same');
    note('b.md', 'y', 'same');
    mkdirSync(join(root, 'projects', '-empty'), { recursive: true });

    expect(memoryOverview(join(root, 'projects'))).toEqual([{ project: '-srv-shop', notes: 2, duplicates: 1 }]);
  });
});
