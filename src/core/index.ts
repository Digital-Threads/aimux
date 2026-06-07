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

export { buildRunParams, launchProfile, looksLikeSubcommand, parseDotenv, loadProfileEnv } from './run.js';
export type { RunOptions, RunParams } from './run.js';

export {
  collectApiCredentials,
  writeProfileDotEnv,
  mergeProfileDotEnv,
  checkDotenvPermissions,
  seedApiClaudeJson,
  API_MODEL_DEFAULTS,
} from './apiProfile.js';

export { summarizeUsage, parseSinceDuration, totalTokens } from './usage.js';
export type { ProfileUsageSummary, UsageOptions, UsageTotals } from './usage.js';

export { readProfileAutoMode } from './autoMode.js';
export type { AutoModeStatus } from './autoMode.js';

export { fetchRateLimits, parseRateLimitHeaders, classifyProfile } from './limits.js';
export type { RateLimitStatus, ProfileKind } from './limits.js';

export { estimateCost, resolvePricing, hasPricing } from './pricing.js';
export type { ModelPricing } from './pricing.js';

export { unifyAllSessions, cachedUnifiedSessions, deriveName } from './unifiedSessions.js';
export type { UnifiedSession } from './unifiedSessions.js';
