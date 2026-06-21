import { join } from 'node:path';
import { looksLikeSubcommand } from '../subcommand.js';
import type { CliAdapter } from './types.js';

// Codex keeps creds/state in many top-level files (auth.json, config.toml, logs, sqlite
// DBs, …). Sharing is an ALLOWLIST, not a denylist — new codex state files are never
// accidentally shared. We share:
//   - knowledge: skills, rules, memories
//   - session transcripts: sessions/ + session_index.jsonl — the codex analogue of
//     claude's shared projects/. Sharing them is what lets you switch codex
//     subscriptions and `codex resume` the SAME session under another profile.
// Settings + plugins are shared via the config OVERLAY (see extraLinks/globalArgs):
// `config.toml` itself stays PRIVATE (codex churns it with trust-levels/runtime state),
// but a symlinked `aimux.config.toml` overlay — which codex only READS, never writes —
// carries the source's model/features/[plugins]/[marketplaces] when layered via `-p aimux`.
const CODEX_SHARED_ENTRIES = new Set(['skills', 'rules', 'memories', 'sessions', 'session_index.jsonl']);

// The overlay profile name: codex layers `$CODEX_HOME/<name>.config.toml` on top of the
// base config when invoked with `-p <name>`. Verified: codex reads it, never writes it.
const OVERLAY_PROFILE = 'aimux';

// Codex subcommands that accept `-p` (runtime). Management subcommands (plugin, doctor,
// login, logout, update, completion) reject it, so the overlay is skipped for them.
const CODEX_RUNTIME_SUBCOMMANDS = new Set([
  'exec', 'review', 'resume', 'archive', 'unarchive', 'fork', 'mcp', 'sandbox',
]);

function isRuntimeInvocation(firstArg: string | undefined): boolean {
  if (!firstArg) return true; // interactive
  if (firstArg.startsWith('-')) return true; // leading flag → interactive
  return CODEX_RUNTIME_SUBCOMMANDS.has(firstArg);
}

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
    // codex resume <uuid> (runtime → carries the overlay); no fork-on-resume flag.
    return ['-p', OVERLAY_PROFILE, 'resume', sessionId];
  },

  headlessArgs(prompt, outFile) {
    // codex exec stdout is noisy (header, token counts, echo). --output-last-message
    // writes ONLY the final assistant message, so the summarizer reads a clean result.
    // No `-p aimux` here: headless goes through buildRunParams, whose globalArgs() injects
    // the overlay for the runtime `exec` subcommand — adding it here would double it.
    const head = ['exec'];
    return outFile ? [...head, '--output-last-message', outFile, prompt] : [...head, prompt];
  },

  headlessCaptureToFile: true,

  globalArgs(firstArg) {
    return isRuntimeInvocation(firstArg) ? ['-p', OVERLAY_PROFILE] : [];
  },

  extraLinks(sourceDir) {
    // Overlay (settings + plugin metadata) + plugin content. config.toml is read via the
    // overlay symlink; codex never writes the overlay, so the symlink is safe.
    return [
      { link: `${OVERLAY_PROFILE}.config.toml`, target: join(sourceDir, 'config.toml') },
      { link: 'plugins', target: join(sourceDir, 'plugins') },
    ];
  },
};
