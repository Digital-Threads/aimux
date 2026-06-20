import { looksLikeSubcommand } from '../subcommand.js';
import type { CliAdapter } from './types.js';

// Codex keeps creds/state in many top-level files (auth.json, config.toml, sessions/,
// sqlite DBs, …). Sharing is an ALLOWLIST of knowledge dirs, not a denylist — so new
// codex state files are never accidentally shared. Plugins are added in a later PR.
const CODEX_SHARED_DIRS = new Set(['skills', 'rules', 'memories']);

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
    return CODEX_SHARED_DIRS.has(entry);
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
