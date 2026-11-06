import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Claude's auto-memory: one note per file in projects/<project>/memory/, plus a
// MEMORY.md index it loads at the start of each session. Every aimux profile shares
// `projects`, so this is one memory for all of them. It lives outside the repo, with
// no history, and claude sometimes saves the same thing twice.

const INDEX = 'MEMORY.md';

export interface MemoryNote {
  file: string;
  name: string;
  description: string;
  type: string | null;
  updatedAt: number;
}

export interface MemoryReport {
  notes: MemoryNote[];
  /** Files saved twice: groups sharing a name, or a description in other words of case
   *  and spacing. */
  duplicates: string[][];
  /** Notes the index does not list, so a session never learns of them. */
  unindexed: string[];
  /** Index lines that point at a note no longer there. */
  missing: string[];
}

/** The folder claude keeps a project under: its path with every non-alphanumeric a dash. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function frontmatter(text: string): Record<string, string> {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const fields: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^\s*(name|description|type):\s*(.*)$/.exec(line);
    if (!m || m[1] in fields) continue;

    const value = m[2].trim();
    fields[m[1]] = /^".*"$/.test(value) ? value.slice(1, -1).replace(/\\"/g, '"') : value.replace(/^'(.*)'$/, '$1');
  }

  return fields;
}

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Groups of more than one file that share a key, in the order they were met. */
function sharing(notes: MemoryNote[], key: (n: MemoryNote) => string): string[][] {
  const groups = new Map<string, string[]>();
  for (const n of notes) {
    const k = key(n);
    if (k) groups.set(k, [...(groups.get(k) ?? []), n.file]);
  }

  return [...groups.values()].filter((g) => g.length > 1);
}

export function readMemory(dir: string): MemoryReport {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return { notes: [], duplicates: [], unindexed: [], missing: [] };
  }

  const notes = files.filter((f) => f !== INDEX).map((file): MemoryNote => {
    const path = join(dir, file);
    const fields = frontmatter(readFileSync(path, 'utf-8'));
    return {
      file,
      name: fields.name ?? file.replace(/\.md$/, ''),
      description: fields.description ?? '',
      type: fields.type ?? null,
      updatedAt: statSync(path).mtimeMs,
    };
  });

  const seen = new Set<string>();
  const duplicates = [...sharing(notes, (n) => normal(n.name)), ...sharing(notes, (n) => normal(n.description))]
    .filter((g) => !seen.has(g.join('\n')) && seen.add(g.join('\n')));

  const index = files.includes(INDEX) ? readFileSync(join(dir, INDEX), 'utf-8') : '';
  const linked = [...index.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1]);

  return {
    notes,
    duplicates,
    unindexed: notes.map((n) => n.file).filter((f) => !linked.includes(f)),
    missing: linked.filter((f) => !existsSync(join(dir, f))),
  };
}

/** Copy the notes and their index into `target`, a folder inside the repo at `repo`. A
 *  file already there with other content is left alone and named, never overwritten, and
 *  nothing is written through a link: a cloned repo could plant one where a note goes. */
export function exportMemory(dir: string, target: string, repo: string): { copied: string[]; same: string[]; differs: string[] } {
  const result = { copied: [] as string[], same: [] as string[], differs: [] as string[] };
  const root = realpathSync(repo);
  const isInside = (path: string) => path.startsWith(root + sep);

  // Checked before anything is made, and again once made, for a link on the way.
  if (!isInside(resolve(root, target))) throw new Error(`${target} is outside this repo`);
  mkdirSync(target, { recursive: true });
  const inside = realpathSync(target);
  if (!isInside(inside)) throw new Error(`${target} leads outside this repo, to ${inside}`);

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const from = join(dir, file);
    if (!lstatSync(from).isFile()) continue;

    const to = join(inside, file);
    const there = lstatSync(to, { throwIfNoEntry: false });
    if (!there) {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      result.copied.push(file);
    } else {
      result[there.isFile() && readFileSync(to).equals(readFileSync(from)) ? 'same' : 'differs'].push(file);
    }
  }

  return result;
}

/** Every project that has notes, with how many and how many were saved twice. */
export function memoryOverview(projectsRoot: string): Array<{ project: string; notes: number; duplicates: number }> {
  let projects: string[];
  try {
    projects = readdirSync(projectsRoot).sort();
  } catch {
    return [];
  }

  return projects.flatMap((project) => {
    const report = readMemory(join(projectsRoot, project, 'memory'));
    return report.notes.length > 0 ? [{ project, notes: report.notes.length, duplicates: report.duplicates.length }] : [];
  });
}
