import { join, dirname } from 'node:path';
import { looksLikeSubcommand } from '../subcommand.js';
import type { CliAdapter } from './types.js';

// Gemini keeps auth + per-machine state in ~/.gemini (oauth_creds.json,
// google_accounts.json, history/, projects.json, state.json, settings.json, …).
// Sharing is an ALLOWLIST, like codex — only portable knowledge crosses profiles:
//   - GEMINI.md   : the project/user instructions (analogue of CLAUDE.md / AGENTS.md)
//   - skills      : `gemini skills`
//   - commands    : custom slash commands
//   - extensions  : `gemini extensions`
//   - memories    : saved memories
// Auth, history, projects.json, settings.json (carries the selected auth method) stay
// PRIVATE so profiles don't leak credentials or fight over per-profile state.
const GEMINI_SHARED_ENTRIES = new Set(['GEMINI.md', 'skills', 'commands', 'extensions', 'memories']);

export const geminiAdapter: CliAdapter = {
  id: 'gemini',

  modelArgs({ model, isSubcommand, userPassedModel }) {
    // gemini takes the model via `-m`; it has no `--fallback-model`, so fallbackModel
    // is intentionally ignored.
    if (!model || isSubcommand || userPassedModel) return [];
    return ['-m', model];
  },

  configDirEnv(profilePath, isSource): Record<string, string> {
    // gemini has no direct config-dir override: it reads `homedir()/.gemini`, where
    // homedir() is `GEMINI_CLI_HOME || os.homedir()`. configPathFor makes the profile
    // dir BE that `.gemini`, so pointing GEMINI_CLI_HOME one level up lands gemini's
    // config exactly on the profile dir (where the shared symlinks live).
    return isSource ? {} : { GEMINI_CLI_HOME: dirname(profilePath) };
  },

  configPathFor(baseDir) {
    return join(baseDir, '.gemini');
  },

  isSubcommand(firstArg) {
    return looksLikeSubcommand(firstArg);
  },

  isShared(entry) {
    return GEMINI_SHARED_ENTRIES.has(entry);
  },

  authArgs() {
    // gemini has no login subcommand; first interactive run drives the OAuth flow
    // (or set GEMINI_API_KEY). Launch interactively and let the user authenticate.
    return [];
  },

  credentialsFile() {
    return 'oauth_creds.json';
  },

  defaultSource() {
    return '~/.gemini';
  },

  resumeArgs(sessionId) {
    // gemini resumes by per-project index or "latest" (`-r <index|latest>`), NOT by a
    // session id — so id-based resume is best-effort and not wired into aimux's session
    // list yet. Kept for interface completeness.
    return ['-r', sessionId];
  },

  headlessArgs(prompt) {
    // gemini -p prints the answer to stdout, like claude.
    return ['-p', prompt];
  },

  headlessCaptureToFile: false,

  globalArgs() {
    return [];
  },

  extraLinks() {
    return [];
  },
};
