import { Text } from 'ink';
import type { ReactNode } from 'react';
import { pctColor, type RateLimitProbe } from '../core/limits.js';

/** One window's utilization. A window the provider did not report is unknown,
 *  not empty — printing 0% there would claim the user has a full allowance they
 *  may not have. */
export function windowPct(pct: number | null): ReactNode {
  if (pct === null) return <Text dimColor>—</Text>;
  return <Text color={pctColor(pct)}>{pct}%</Text>;
}

/**
 * What to render instead of the numbers, or null when the probe has numbers.
 *
 * A stale token is called out as `login?` because that is the one case the user
 * can act on — running the CLI once refreshes it. Everything else (never probed,
 * network hiccup) stays a quiet em-dash: a status table should not raise an
 * alarm about its own connectivity.
 */
export function probeFallback(probe: RateLimitProbe | undefined, loading = false): ReactNode | null {
  if (probe === undefined) return <Text dimColor>{loading ? '…' : '—'}</Text>;
  if (probe.status) return null;
  if (probe.error === 'auth') return <Text color="yellow">login?</Text>;
  return <Text dimColor>—</Text>;
}
