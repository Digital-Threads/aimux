import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';
import {
  fetchRateLimits, pickFreestProfile, rateLimitProfiles,
  type RateLimitProbe, type RateLimitStatus,
} from './limits.js';
import { findTranscript, newestSessionSince, sessionQuotaHit, type QuotaHit } from './sessionMarkers.js';

export interface ContinuationPlan {
  sessionId: string;
  hit: QuotaHit;
  /** The freest other claude subscription, or null when none has room. */
  next: { profile: string; status: RateLimitStatus } | null;
}

/**
 * After an interactive claude session exits: did it stop because its subscription ran
 * out, and if so, where can it carry on?
 *
 * The transcript is shared, so the same session resumes under any profile — only the
 * login changes. Detection is local (Claude Code records the exhausted window in the
 * transcript), so an ordinary exit costs no network; only a real hit probes the other
 * profiles to rank them.
 */
export async function planContinuation(
  config: AimuxConfig,
  profileName: string,
  sinceMs: number,
  probe: (profile: ProfileConfig, profilePath: string) => Promise<RateLimitProbe> = fetchRateLimits,
  now: number = Date.now(),
): Promise<ContinuationPlan | null> {
  const profile = getProfile(config, profileName);
  if ((profile.cli ?? 'claude') !== 'claude') return null;

  const sessionId = newestSessionSince(expandHome(profile.path), sinceMs);
  const transcript = sessionId ? findTranscript(config, sessionId) : null;
  const hit = transcript ? sessionQuotaHit(transcript) : null;
  if (!sessionId || !hit) return null;

  // The window reset while the session sat idle: this subscription has room again,
  // so there is nothing to move.
  if (hit.resetsAt !== undefined && hit.resetsAt <= now) return null;

  const others = rateLimitProfiles(config.profiles)
    .filter((name) => name !== profileName && (config.profiles[name].cli ?? 'claude') === 'claude');
  const probes = new Map(await Promise.all(others.map(async (name) => {
    const p = config.profiles[name];
    return [name, await probe(p, expandHome(p.path))] as const;
  })));

  const freest = pickFreestProfile(probes);
  const status = freest ? probes.get(freest)?.status : null;

  return { sessionId, hit, next: freest && status ? { profile: freest, status } : null };
}
