export {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  addProfile,
  removeProfile,
  getProfile,
  getSourceProfile,
  validateConfig,
  loadHistory,
  saveHistory,
  recordHistory,
  getLastProfile,
  configExists,
  ensureAimuxDir,
  ensureProfileDir,
} from './config.js';

export {
  expandHome,
  getAimuxDir,
  getConfigPath,
  getHistoryPath,
  getProfilesDir,
  setAimuxDir,
} from './paths.js';

export {
  getSharedElements,
  getPrivateElements,
  syncProfile,
  syncAllProfiles,
  checkProfileHealth,
  checkAllProfiles,
} from './symlinks.js';

export type { SyncResult, HealthReport } from './symlinks.js';

export {
  detectClaudeDirs,
  initFromSource,
  initAutoDetect,
} from './init.js';

export type { DetectedDir, InitResult } from './init.js';

export { buildRunParams, launchProfile, looksLikeSubcommand } from './run.js';
export type { RunOptions, RunParams } from './run.js';
