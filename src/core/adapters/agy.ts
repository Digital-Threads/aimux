import { join } from 'node:path';
import { looksLikeSubcommand } from '../subcommand.js';
import { standInHome, userHome } from '../paths.js';
import type { CliAdapter } from './types.js';

// agy (Antigravity CLI, which replaced Gemini CLI for personal Google accounts) keeps
// everything in ~/.gemini/antigravity-cli: the login (antigravity-oauth-token),
// settings, conversations, brain/, history. It reads that dir from the home and has no
// variable or flag to move it, so a profile runs with a stand-in home (see homeDir).
// Its own dir is all private. Skills, plugins, rules (GEMINI.md) and MCP servers live
// in ~/.gemini/config, which the stand-in home links to, so every profile shares them.
const HOME_DIR = '.gemini/antigravity-cli';
const CONFIG_DIR = '.gemini/config';

export const agyAdapter: CliAdapter = {
  id: 'agy',

  homeDir: HOME_DIR,

  sharedHomeDirs: [CONFIG_DIR],

  modelArgs({ model, isSubcommand, userPassedModel }) {
    // agy takes the model via `--model` and has no fallback model.
    if (!model || isSubcommand || userPassedModel) return [];
    return ['--model', model];
  },

  configDirEnv(profilePath): Record<string, string> {
    // A source profile gets the real home this way too, which also undoes a stand-in
    // inherited from another agy profile. Go reads the home from USERPROFILE on Windows.
    // AIMUX_REAL_HOME lets an aimux started by the agent find the real one.
    const home = standInHome(profilePath, HOME_DIR);
    return { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: home, AIMUX_REAL_HOME: userHome() };
  },

  configPathFor(baseDir) {
    return join(baseDir, HOME_DIR);
  },

  isSubcommand(firstArg) {
    return looksLikeSubcommand(firstArg);
  },

  isShared() {
    return false;
  },

  authArgs() {
    // agy has no login subcommand; a bare interactive run asks to sign in.
    return [];
  },

  credentialsFile() {
    return 'antigravity-oauth-token';
  },

  defaultSource() {
    return `~/${HOME_DIR}`;
  },

  resumeArgs(sessionId, opts) {
    if (opts?.fork) throw new Error('agy cannot fork a conversation');
    return ['--conversation', sessionId];
  },

  headlessArgs(prompt) {
    // agy -p prints the answer to stdout, like claude.
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
