import { looksLikeSubcommand } from '../subcommand.js';
import type { CliAdapter } from './types.js';

// Codex keeps creds/state in many top-level files (auth.json, config.toml, logs, sqlite
// DBs, …). Sharing is an ALLOWLIST, not a denylist — new codex state files are never
// accidentally shared. We share:
//   - knowledge: skills, rules, memories
//   - session transcripts: sessions/ + session_index.jsonl — the codex analogue of
//     claude's shared projects/. Sharing them is what lets you switch codex
//     subscriptions and `codex resume` the SAME session under another profile.
// Plugins are added in a later PR.
const CODEX_SHARED_ENTRIES = new Set(['skills', 'rules', 'memories', 'sessions', 'session_index.jsonl']);

export const codexAdapter: CliAdapter = {
  id: 'codex',

  modelArgs({ model, isSubcommand, userPassedModel }) {
    // Codex takes the model via `-m`; it has no `--fallback-model`, so fallbackModel
    // is intentionally ignored.
    if (!model || isSubcommand || userPassedModel) return [];
    return ['-m', model];
  },

  configDirEnv(profilePath, isSource): Record<string, string> {
    return isSource ? {} : { CODEX_HOME: profilePath };
  },

  isSubcommand(firstArg) {
    return looksLikeSubcommand(firstArg);
  },

  isShared(entry) {
    return CODEX_SHARED_ENTRIES.has(entry);
  },

  authArgs() {
    return ['login'];
  },

  credentialsFile() {
    return 'auth.json';
  },

  defaultSource() {
    return '~/.codex';
  },

  resumeArgs(sessionId) {
    // codex resume <uuid>; codex has no fork-on-resume flag.
    return ['resume', sessionId];
  },

  headlessArgs(prompt, outFile) {
    // codex exec stdout is noisy (header, token counts, echo). --output-last-message
    // writes ONLY the final assistant message, so the summarizer reads a clean result.
    return outFile ? ['exec', '--output-last-message', outFile, prompt] : ['exec', prompt];
  },

  headlessCaptureToFile: true,
};
