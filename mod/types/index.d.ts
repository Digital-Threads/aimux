export type Usage = { fiveHourPct: number | null; weeklyPct: number | null };
export type Probe = { cli: string; status: Usage | null; error?: string };

/** What the band above the prompt draws: this session's subscription and the rest. */
export type View = { current: string; others: Record<string, Probe>; live: Usage | null };

declare module 'claude-code' {
  interface PluginState {
    aimux: { view: View | null };
  }
}
