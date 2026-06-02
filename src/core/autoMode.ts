import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AutoModeStatus {
  /** True when the profile's settings.json carries an `autoMode` object. */
  configured: boolean;
  /** Number of auto-approve `allow` patterns (0 when absent/non-array). */
  allowCount: number;
  /** Number of always-confirm `soft_deny` patterns (0 when absent/non-array). */
  softDenyCount: number;
}

const NOT_CONFIGURED: AutoModeStatus = { configured: false, allowCount: 0, softDenyCount: 0 };

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Read the auto-mode ("YOLO classifier") posture from a profile's
 * `settings.json`. Read-only and defensive: a missing file, malformed JSON, or
 * an `autoMode` that isn't an object all collapse to "not configured".
 *
 * We only surface the shape (configured + rule counts), never interpret the
 * classifier semantics — so this stays stable across Claude Code releases that
 * may rename or reshape the internal field.
 */
export function readProfileAutoMode(profilePath: string): AutoModeStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(profilePath, 'settings.json'), 'utf-8'));
  } catch {
    return NOT_CONFIGURED;
  }

  if (!parsed || typeof parsed !== 'object') return NOT_CONFIGURED;
  const autoMode = (parsed as { autoMode?: unknown }).autoMode;
  if (!autoMode || typeof autoMode !== 'object' || Array.isArray(autoMode)) return NOT_CONFIGURED;

  const block = autoMode as { allow?: unknown; soft_deny?: unknown };
  return {
    configured: true,
    allowCount: arrayLength(block.allow),
    softDenyCount: arrayLength(block.soft_deny),
  };
}
