export type { AimuxConfig, ProfileConfig } from './config.js';
export { DEFAULT_CONFIG, DEFAULT_PRIVATE_ELEMENTS } from './config.js';

export interface ProfileStatus {
  name: string;
  authenticated: boolean;
  model?: string;
  isSource: boolean;
  symlinkCount: number;
  symlinkTotal: number;
  path: string;
}

export interface HistoryEntry {
  dir: string;
  profile: string;
  timestamp: string;
}
