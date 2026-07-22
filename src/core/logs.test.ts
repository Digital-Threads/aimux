import { describe, it, expect } from 'vitest';
import { formatTranscript } from './logs.js';

describe('formatTranscript', () => {
  it('formats Claude user and assistant messages', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ text: 'hi there' }] } }),
    ].join('\n');

    const formatted = formatTranscript(raw);
    expect(formatted).toHaveLength(2);
    expect(formatted[0]).toContain('[User]');
    expect(formatted[0]).toContain('hello');
    expect(formatted[1]).toContain('[Assistant]');
    expect(formatted[1]).toContain('hi there');
  });

  it('formats Codex session meta and response items', () => {
    const raw = [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/user/project' } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'tell me a joke' } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: ['joke response'] } }),
    ].join('\n');

    const formatted = formatTranscript(raw);
    expect(formatted).toHaveLength(3);
    expect(formatted[0]).toContain('[CWD]');
    expect(formatted[0]).toContain('/home/user/project');
    expect(formatted[1]).toContain('[User]');
    expect(formatted[1]).toContain('tell me a joke');
    expect(formatted[2]).toContain('[Assistant]');
    expect(formatted[2]).toContain('joke response');
  });

  it('emits no ANSI escapes when color is off (piping `aimux logs` to a file or grep)', () => {
    const raw = [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/user/project' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    ].join('\n');

    const plain = formatTranscript(raw, { color: false });
    expect(plain.join('\n')).not.toContain('\x1b[');
    // content is still there, just uncolored
    expect(plain[0]).toContain('[CWD]');
    expect(plain[1]).toContain('[User]');
    expect(plain[1]).toContain('hello');

    // default stays colored for interactive use
    expect(formatTranscript(raw).join('\n')).toContain('\x1b[');
  });
});
