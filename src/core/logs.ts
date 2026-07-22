export function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

/** Render a raw JSONL transcript as `[Role] text` lines (claude + codex formats).
 *  `color` adds ANSI codes — pass false when stdout is not a TTY, otherwise piping
 *  `aimux logs` into a file or grep embeds escape sequences in the output. */
export function formatTranscript(rawTranscript: string, opts: { color?: boolean } = {}): string[] {
  const color = opts.color ?? true;
  const paint = (code: string, s: string) => (color ? `${code}${s}\x1b[0m` : s);
  const lines = rawTranscript.split('\n');
  const formatted: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      let role = '';
      let text = '';

      // Claude Format
      if (obj.type === 'user' && obj.message?.role === 'user') {
        role = 'User';
        text = extractText(obj.message.content);
      } else if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
        role = 'Assistant';
        text = extractText(obj.message.content);
      }
      // Codex Format
      else if (obj.type === 'response_item') {
        role = obj.payload?.role === 'user' ? 'User' : 'Assistant';
        text = contentText(obj.payload?.content);
      } else if (obj.type === 'session_meta' && obj.payload?.cwd) {
        formatted.push(`${paint('\x1b[90m', '[CWD]')} ${obj.payload.cwd}`);
        continue;
      }

      if (role && text.trim()) {
        formatted.push(`${paint(role === 'User' ? '\x1b[32m' : '\x1b[36m', `[${role}]`)} ${text.trim()}`);
      }
    } catch {
      // ignore parsing error for malformed lines
    }
  }

  return formatted;
}
