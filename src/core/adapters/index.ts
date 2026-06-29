import type { CliAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';

export type { CliAdapter } from './types.js';

const REGISTRY: Record<string, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

/** Select the adapter for a profile's `cli`. Unknown/custom values fall back to the
 *  claude adapter, preserving pre-multi-CLI behavior (every profile was claude-flavored). */
export function adapterFor(cli: string): CliAdapter {
  return REGISTRY[cli] ?? claudeAdapter;
}
