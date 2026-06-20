import { looksLikeSubcommand } from '../subcommand.js';
import type { CliAdapter } from './types.js';

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
};
