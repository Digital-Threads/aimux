import { describe, it, expect } from 'vitest';
import { detectShell, parseShell, renderShellExports, renderShellInit } from './shellSwitch.js';

describe('detectShell', () => {
  it('detects zsh, fish, and falls back to bash', () => {
    expect(detectShell('/bin/zsh')).toBe('zsh');
    expect(detectShell('/usr/local/bin/fish')).toBe('fish');
    expect(detectShell('/bin/bash')).toBe('bash');
    expect(detectShell(undefined)).toBe('bash');
    expect(detectShell('/usr/bin/sh')).toBe('bash');
  });
});

describe('parseShell', () => {
  it('returns an explicit valid shell', () => {
    expect(parseShell('fish', '/bin/zsh')).toBe('fish');
    expect(parseShell('bash', undefined)).toBe('bash');
  });

  it('falls back to detection from the shell path when no explicit value', () => {
    expect(parseShell(undefined, '/usr/local/bin/fish')).toBe('fish');
    expect(parseShell(undefined, undefined)).toBe('bash');
  });

  it('throws on an unsupported shell', () => {
    expect(() => parseShell('powershell', '/bin/zsh')).toThrow(/Unsupported --shell/);
  });
});

describe('renderShellExports', () => {
  const env = { CLAUDE_CONFIG_DIR: '/home/u/.aimux/profiles/work', ANTHROPIC_BASE_URL: 'https://x.test' };

  it('exports each var plus the profile + managed markers (posix)', () => {
    const out = renderShellExports({ env, profileName: 'work', shell: 'zsh' });
    expect(out).toContain(`export CLAUDE_CONFIG_DIR='/home/u/.aimux/profiles/work'`);
    expect(out).toContain(`export ANTHROPIC_BASE_URL='https://x.test'`);
    expect(out).toContain(`export AIMUX_PROFILE='work'`);
    expect(out).toContain('export AIMUX_MANAGED=');
    expect(out).toContain('CLAUDE_CONFIG_DIR ANTHROPIC_BASE_URL AIMUX_PROFILE');
  });

  it('unsets previously-managed vars that the new profile does not set', () => {
    const out = renderShellExports({
      env,
      profileName: 'work',
      previousManaged: 'ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDE_CONFIG_DIR AIMUX_PROFILE',
      shell: 'zsh',
    });
    // ANTHROPIC_AUTH_TOKEN is stale (not in the new env) -> unset; the rest are re-set.
    expect(out).toMatch(/^unset ANTHROPIC_AUTH_TOKEN$/m);
    expect(out).not.toMatch(/unset.*CLAUDE_CONFIG_DIR/);
  });

  it('escapes single quotes in values (posix)', () => {
    const out = renderShellExports({ env: { K: "a'b" }, profileName: 'p', shell: 'bash' });
    expect(out).toContain(`export K='a'\\''b'`);
  });

  it('uses fish syntax when targeting fish', () => {
    const out = renderShellExports({ env, profileName: 'work', previousManaged: 'OLD_VAR', shell: 'fish' });
    expect(out).toContain(`set -gx CLAUDE_CONFIG_DIR '/home/u/.aimux/profiles/work'`);
    expect(out).toContain(`set -e OLD_VAR`);
    expect(out).toContain(`set -gx AIMUX_PROFILE 'work'`);
  });
});

describe('renderShellInit', () => {
  it('emits a posix function that evals `use` and passes everything else through', () => {
    const out = renderShellInit('zsh');
    expect(out).toContain('aimux() {');
    expect(out).toContain('if [ "$1" = "use" ]; then');
    expect(out).toContain('command aimux use "$@" --export');
    expect(out).toContain('command aimux "$@"');
  });

  it('emits a fish function', () => {
    const out = renderShellInit('fish');
    expect(out).toContain('function aimux');
    expect(out).toContain('--export --shell fish');
    expect(out).toContain('command aimux $argv');
  });
});
