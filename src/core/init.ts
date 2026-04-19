import {
  readdirSync, lstatSync, existsSync, copyFileSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { DEFAULT_PRIVATE_ELEMENTS } from '../types/index.js';
import { expandHome, getProfilesDir } from './paths.js';
import { saveConfig, ensureAimuxDir, configExists } from './config.js';
import { syncProfile } from './symlinks.js';
import type { SyncResult } from './symlinks.js';

export interface DetectedDir {
  name: string;
  path: string;
  isSource: boolean;
  realFileCount: number;
  symlinkCount: number;
  hasCredentials: boolean;
}

export interface InitResult {
  configCreated: boolean;
  source: string;
  profiles: Array<{ name: string; sync: SyncResult; privatesCopied: string[] }>;
}

export function detectClaudeDirs(): DetectedDir[] {
  const home = homedir();
  const entries = readdirSync(home);
  const claudeDirs: DetectedDir[] = [];

  const CLAUDE_MARKERS = ['.credentials.json', '.claude.json', 'CLAUDE.md', 'agents', 'skills', 'commands', 'projects'];

  for (const entry of entries) {
    if (entry !== '.claude' && !entry.startsWith('.claude-')) continue;
    const fullPath = join(home, entry);
    if (!lstatSync(fullPath).isDirectory()) continue;

    const contents = readdirSync(fullPath);
    const hasMarker = contents.some(item => CLAUDE_MARKERS.includes(item));
    if (!hasMarker) continue;

    let realFiles = 0;
    let symlinks = 0;

    for (const item of contents) {
      const stat = lstatSync(join(fullPath, item));
      if (stat.isSymbolicLink()) symlinks++;
      else realFiles++;
    }

    const name = entry === '.claude' ? 'main' : entry.replace(/^\.claude-/, '');

    claudeDirs.push({
      name,
      path: fullPath,
      isSource: symlinks === 0 && realFiles > 0,
      realFileCount: realFiles,
      symlinkCount: symlinks,
      hasCredentials: existsSync(join(fullPath, '.credentials.json')),
    });
  }

  if (claudeDirs.length > 0 && !claudeDirs.some(d => d.isSource)) {
    claudeDirs.sort((a, b) => b.realFileCount - a.realFileCount);
    claudeDirs[0].isSource = true;
  }

  return claudeDirs;
}

export function initFromSource(
  sourcePath: string,
  extraProfiles?: Array<{ name: string; existingPath?: string; model?: string }>,
): InitResult {
  if (configExists()) {
    throw new Error('aimux already initialized. Use "aimux profile add" to add profiles.');
  }

  const resolvedSource = expandHome(sourcePath);
  if (!existsSync(resolvedSource)) {
    throw new Error(`Source directory not found: ${sourcePath}`);
  }

  ensureAimuxDir();

  const config: AimuxConfig = {
    version: 1,
    shared_source: resolvedSource,
    profiles: {
      main: {
        cli: 'claude',
        path: resolvedSource,
        is_source: true,
      },
    },
    private: [...DEFAULT_PRIVATE_ELEMENTS],
  };

  const result: InitResult = {
    configCreated: true,
    source: resolvedSource,
    profiles: [],
  };

  if (extraProfiles) {
    for (const ep of extraProfiles) {
      const profileDir = join(getProfilesDir(), ep.name);
      const profile: ProfileConfig = {
        cli: 'claude',
        model: ep.model,
        path: profileDir,
      };
      config.profiles[ep.name] = profile;

      mkdirSync(profileDir, { recursive: true });

      const privatesCopied = copyPrivateFiles(
        ep.existingPath ? expandHome(ep.existingPath) : null,
        profileDir,
        config.private,
      );

      saveConfig(config);
      const sync = syncProfile(config, ep.name);

      result.profiles.push({ name: ep.name, sync, privatesCopied });
    }
  }

  saveConfig(config);
  return result;
}

export function initAutoDetect(): InitResult {
  const dirs = detectClaudeDirs();
  if (dirs.length === 0) {
    throw new Error(
      'No Claude directories found. Use "aimux init --source <path>" to specify manually.',
    );
  }

  const source = dirs.find(d => d.isSource)!;
  const extra = dirs
    .filter(d => !d.isSource)
    .map(d => ({ name: d.name, existingPath: d.path }));

  return initFromSource(source.path, extra);
}

function copyPrivateFiles(
  existingDir: string | null,
  profileDir: string,
  privateList: string[],
): string[] {
  const copied: string[] = [];
  if (!existingDir || !existsSync(existingDir)) return copied;

  for (const item of privateList) {
    const src = join(existingDir, item);
    const dest = join(profileDir, item);

    if (!existsSync(src)) continue;

    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) continue;

    if (stat.isFile()) {
      copyFileSync(src, dest);
      copied.push(item);
    } else if (stat.isDirectory()) {
      copyDirRecursive(src, dest);
      copied.push(item);
    }
  }

  return copied;
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = lstatSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (stat.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}
