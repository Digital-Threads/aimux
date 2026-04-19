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
