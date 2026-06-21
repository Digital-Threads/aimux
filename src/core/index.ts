export {
  loadConfig,
  saveConfig,
  createDefaultConfig,
  addProfile,
  removeProfile,
  getProfile,
  getSourceProfile,
  sourceFor,
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
  detectCodex,
  initFromSource,
  initAutoDetect,
} from './init.js';

export type { DetectedDir, InitResult } from './init.js';

export { buildRunParams, launchProfile, runProfileHeadless, looksLikeSubcommand, parseDotenv, loadProfileEnv } from './run.js';
export type { RunOptions, RunParams, HeadlessOptions, HeadlessResult } from './run.js';
export { adapterFor } from './adapters/index.js';
export type { CliAdapter } from './adapters/index.js';
export { openSession, buildSessionArgs } from './liveSession.js';
export type { OpenSessionOptions, SessionEvent, TurnResult, LiveSession } from './liveSession.js';

export {
  collectApiCredentials,
  collectProviderCredentials,
  providerEnv,
  PROVIDER_PRESETS,
  writeProfileDotEnv,
  mergeProfileDotEnv,
  checkDotenvPermissions,
  seedApiClaudeJson,
  API_MODEL_DEFAULTS,
} from './apiProfile.js';
export type { ProviderPreset } from './apiProfile.js';

export { summarizeUsage, usageBySession, parseSinceDuration, totalTokens } from './usage.js';
export type { ProfileUsageSummary, SessionUsageSummary, UsageOptions, UsageTotals } from './usage.js';

export { readProfileAutoMode } from './autoMode.js';
export type { AutoModeStatus } from './autoMode.js';

export { fetchRateLimits, parseRateLimitHeaders, classifyProfile } from './limits.js';
export type { RateLimitStatus, ProfileKind } from './limits.js';

export { estimateCost, resolvePricing, hasPricing } from './pricing.js';
export type { ModelPricing } from './pricing.js';

export { unifyAllSessions, cachedUnifiedSessions, deriveName } from './unifiedSessions.js';
export type { UnifiedSession } from './unifiedSessions.js';

export { handoffSession, buildHandoffPrompt, buildSummarizePrompt, readTranscript } from './handoff.js';
export type { HandoffDeps, HandoffResult } from './handoff.js';

export { loadActiveProfile, saveActiveProfile, getActiveProfilePath } from './activeProfile.js';
