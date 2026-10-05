export type Usage = {
  fiveHourPct: number | null;
  weeklyPct: number | null;
  /** When each window resets, in epoch milliseconds, where known. */
  fiveHourResetsAt?: number;
  weeklyResetsAt?: number;
};
export type Probe = { cli: string; status: Usage | null; error?: string };

/** What the band above the prompt draws: this session's subscription and the rest,
 *  as of `now` (which the reset times are counted from). */
export type View = { current: string; others: Record<string, Probe>; live: Usage | null; now: number };

declare module 'claude-code' {
  interface PluginState {
    aimux: { view: View | null };
  }
}
