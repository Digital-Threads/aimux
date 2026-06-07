import { describe, it, expect } from 'vitest';
import { isMetaPrompt } from './sessionScanner.js';
import { deriveName } from './unifiedSessions.js';

describe('isMetaPrompt', () => {
  it('treats empty text as meta', () => {
    expect(isMetaPrompt('')).toBe(true);
  });

  it('flags existing command/system wrappers', () => {
    expect(isMetaPrompt('<command-name>foo')).toBe(true);
    expect(isMetaPrompt('<command-message>foo')).toBe(true);
    expect(isMetaPrompt('<system-reminder>foo')).toBe(true);
    expect(isMetaPrompt('<local-command-caveat>foo')).toBe(true);
  });

  it('flags local-command stdout/stderr leaks', () => {
    expect(isMetaPrompt('<local-command-stdout>Set model to Opus')).toBe(true);
    expect(isMetaPrompt('<local-command-stderr>boom')).toBe(true);
  });

  it('flags compaction-continuation summaries', () => {
    expect(
      isMetaPrompt('This session is being continued from a previous conversation that ran out of context.'),
    ).toBe(true);
  });

  it('keeps a real human prompt', () => {
    expect(isMetaPrompt('проанализируй флоу autowithdrawal')).toBe(false);
    expect(isMetaPrompt('Fix the login bug')).toBe(false);
  });
});

describe('deriveName', () => {
  it('uses the first line of the intent', () => {
    expect(deriveName('Fix the login bug\nmore details', 'abcd1234ef')).toBe('Fix the login bug');
  });

  it('truncates long intents', () => {
    const long = 'x'.repeat(80);
    const name = deriveName(long, 'abcd1234ef');
    expect(name.length).toBe(61);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back to a short session id when intent is empty', () => {
    expect(deriveName('', 'abcd1234efgh')).toBe('session-abcd1234');
  });
});
