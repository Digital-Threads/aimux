export type Usage = {
  fiveHourPct: number | null;
  weeklyPct: number | null;
  /** When each window resets, in epoch milliseconds, where known. */
  fiveHourResetsAt?: number;
  weeklyResetsAt?: number;
  /** Weekly limits that count one model only (Fable's), from aimux's reading. */
  scoped?: { name: string; pct: number; resetsAt?: number }[];
};
/** `loginEndsAt`: when the claude.ai login itself ends, which no renewal moves. */
export type Probe = { cli: string; status: Usage | null; error?: string; loginEndsAt?: number };

/** What the band above the prompt draws: this session's subscription and the rest,
 *  as of `now` (which the reset times are counted from). */
export type View = { current: string; others: Record<string, Probe>; live: Usage | null; now: number };

declare module 'claude-code' {
  interface PluginState {
    aimux: { view: View | null };
  }
}
