import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeProfileDotEnv, mergeProfileDotEnv, checkDotenvPermissions } from './apiProfile.js';
import { parseDotenv } from './run.js';

describe('writeProfileDotEnv', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aimux-write-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes a parseable .env round-trip', () => {
    writeProfileDotEnv(dir, { ANTHROPIC_BASE_URL: 'https://api.example.com/v1', ANTHROPIC_AUTH_TOKEN: 'sk-123' });
    const parsed = parseDotenv(readFileSync(join(dir, '.env'), 'utf-8'));
    expect(parsed.ANTHROPIC_BASE_URL).toBe('https://api.example.com/v1');
    expect(parsed.ANTHROPIC_AUTH_TOKEN).toBe('sk-123');
  });

  it('writes the file with 0600 permissions', () => {
    writeProfileDotEnv(dir, { FOO: 'bar' });
    const mode = statSync(join(dir, '.env')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('quotes and round-trips values containing spaces or hashes', () => {
    writeProfileDotEnv(dir, { MSG: 'hello world # ok' });
    const parsed = parseDotenv(readFileSync(join(dir, '.env'), 'utf-8'));
    expect(parsed.MSG).toBe('hello world # ok');
  });

  it('round-trips values containing CR and LF', () => {
    writeProfileDotEnv(dir, { MULTI: 'line1\r\nline2' });
    const parsed = parseDotenv(readFileSync(join(dir, '.env'), 'utf-8'));
    expect(parsed.MULTI).toBe('line1\r\nline2');
  });
});

describe('mergeProfileDotEnv', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aimux-merge-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('sets new keys while preserving existing ones', () => {
    writeProfileDotEnv(dir, { A: '1' });
    const change = mergeProfileDotEnv(dir, ['B=2'], []);
    const parsed = parseDotenv(readFileSync(join(dir, '.env'), 'utf-8'));
    expect(parsed).toEqual({ A: '1', B: '2' });
    expect(change.set).toEqual(['B']);
  });

  it('unsets keys', () => {
    writeProfileDotEnv(dir, { A: '1', B: '2' });
    mergeProfileDotEnv(dir, [], ['A']);
    const parsed = parseDotenv(readFileSync(join(dir, '.env'), 'utf-8'));
    expect(parsed).toEqual({ B: '2' });
  });

  it('rejects malformed assignments', () => {
    expect(() => mergeProfileDotEnv(dir, ['NOEQUALS'], [])).toThrow('expected KEY=VALUE');
  });

  it('tightens permissions to 0600 when overwriting a looser existing .env', () => {
    // Simulate a hand-written / #3-style 0644 file, then merge into it.
    writeFileSync(join(dir, '.env'), 'A=1\n', { mode: 0o644 });
    chmodSync(join(dir, '.env'), 0o644);
    mergeProfileDotEnv(dir, ['B=2'], []);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  });
});

describe('checkDotenvPermissions', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aimux-perm-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null when there is no .env', () => {
    expect(checkDotenvPermissions(dir)).toBeNull();
  });

  it('returns null for 0600', () => {
    writeProfileDotEnv(dir, { A: '1' });
    expect(checkDotenvPermissions(dir)).toBeNull();
  });

  it('warns when group/other can read the file', () => {
    writeFileSync(join(dir, '.env'), 'A=1\n');
    chmodSync(join(dir, '.env'), 0o644);
    const warning = checkDotenvPermissions(dir);
    expect(warning).toContain('chmod 600');
  });
});
