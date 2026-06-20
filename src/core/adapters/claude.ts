import { looksLikeSubcommand } from '../subcommand.js';
import type { CliAdapter } from './types.js';

export const claudeAdapter: CliAdapter = {
  id: 'claude',

  modelArgs({ model, fallbackModel, isSubcommand, userPassedModel, userPassedFallback }) {
    const args: string[] = [];
    if (model && !isSubcommand && !userPassedModel) {
      args.push('--model', model);
    }
    if (fallbackModel && !isSubcommand && !userPassedFallback) {
      args.push('--fallback-model', fallbackModel);
    }
    return args;
  },

  configDirEnv(profilePath, isSource): Record<string, string> {
    return isSource ? {} : { CLAUDE_CONFIG_DIR: profilePath };
  },

  isSubcommand(firstArg) {
    return looksLikeSubcommand(firstArg);
  },

  isShared(entry, configPrivate) {
    return !configPrivate.has(entry);
  },

  authArgs() {
    return ['auth', 'login'];
  },

  credentialsFile() {
    return '.credentials.json';
  },

  defaultSource() {
    return '~/.claude';
  },
};
