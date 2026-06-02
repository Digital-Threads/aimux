import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProfileAutoMode } from './autoMode.js';

describe('readProfileAutoMode', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aimux-automode-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeSettings(value: unknown): void {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(value));
  }

  it('reports not-configured when settings.json is missing', () => {
    expect(readProfileAutoMode(dir)).toEqual({ configured: false, allowCount: 0, softDenyCount: 0 });
  });

  it('reports not-configured when there is no autoMode block', () => {
    writeSettings({ model: 'claude-opus-4-6' });
    expect(readProfileAutoMode(dir)).toEqual({ configured: false, allowCount: 0, softDenyCount: 0 });
  });

  it('counts allow and soft_deny rules', () => {
    writeSettings({
      autoMode: {
        allow: ['Bash(npm test)', 'Read', 'Grep'],
        soft_deny: ['Bash(git push )', 'Write(.env)'],
        environment: ['local dev machine'],
      },
    });
    expect(readProfileAutoMode(dir)).toEqual({ configured: true, allowCount: 3, softDenyCount: 2 });
  });

  it('treats an empty autoMode object as configured with zero rules', () => {
    writeSettings({ autoMode: {} });
    expect(readProfileAutoMode(dir)).toEqual({ configured: true, allowCount: 0, softDenyCount: 0 });
  });

  it('ignores non-array allow / soft_deny values', () => {
    writeSettings({ autoMode: { allow: 'oops', soft_deny: 42 } });
    expect(readProfileAutoMode(dir)).toEqual({ configured: true, allowCount: 0, softDenyCount: 0 });
  });

  it('recovers from malformed JSON', () => {
    writeFileSync(join(dir, 'settings.json'), '{ not valid json');
    expect(readProfileAutoMode(dir)).toEqual({ configured: false, allowCount: 0, softDenyCount: 0 });
  });
});
