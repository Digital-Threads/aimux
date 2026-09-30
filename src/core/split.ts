import { posixQuote } from './shellSwitch.js';

/**
 * Wrap a pane command so a failure stays on screen: a tmux pane closes the instant its
 * command exits, taking the error with it. Runs through `sh` explicitly, so it works
 * whatever tmux's default shell is (fish has no `{ …; }`).
 */
export function keepOpenOnFailure(command: string): string {
  const script = `( ${command} ) || { status=$?; echo; echo "aimux: this pane exited with an error (status $status). Press Enter to close."; read -r _; exit $status; }`;
  return `sh -c ${posixQuote(script)}`;
}

export interface SplitOptions {
  profiles: string[];
  cwd: string;
  /** The shell command one pane runs for a profile. */
  command: (profile: string) => string;
  /** Already inside tmux: open a window of the current session instead of nesting. */
  insideTmux: boolean;
  sessionName: string;
}

export interface SplitDeps {
  /** Run one tmux command and return its stdout. */
  tmux(args: string[]): string;
  /** Hand the terminal over to tmux. */
  attach(args: string[]): void;
}

/**
 * Open one tmux pane per subscription, side by side in the current terminal.
 *
 * tmux does the multiplexing: each pane runs a full `aimux run <profile>`, so claude
 * keeps its own fullscreen UI and everything `run` does — sync, the profile model,
 * continuing on another subscription when one runs out — comes along per pane.
 */
export function openSplit(opts: SplitOptions, deps: SplitDeps): void {
  const [first, ...rest] = opts.profiles;
  const printPaneId = ['-P', '-F', '#{pane_id}'];
  let firstPane: string | undefined;

  try {
    firstPane = deps.tmux(opts.insideTmux
      ? ['new-window', ...printPaneId, '-n', 'aimux', '-c', opts.cwd, opts.command(first)]
      : ['new-session', '-d', ...printPaneId, '-s', opts.sessionName, '-n', 'aimux', '-c', opts.cwd, opts.command(first)],
    ).trim();
    const panes: Array<[string, string]> = [[firstPane, first]];

    for (const profile of rest) {
      const pane = deps.tmux(['split-window', ...printPaneId, '-t', firstPane, '-c', opts.cwd, opts.command(profile)]).trim();
      panes.push([pane, profile]);
      // Re-tile after every split: splitting the same pane again and again halves it
      // until tmux refuses with "no space for new pane".
      deps.tmux(['select-layout', '-t', firstPane, 'tiled']);
    }

    // The label lives in a pane option, not the pane title: claude sets the terminal
    // title itself and would overwrite a title-based label as soon as it starts.
    for (const [pane, profile] of panes) {
      deps.tmux(['set-option', '-p', '-t', pane, '@aimux_profile', profile]);
    }
    deps.tmux(['set-option', '-w', '-t', firstPane, 'pane-border-status', 'top']);
    deps.tmux(['set-option', '-w', '-t', firstPane, 'pane-border-format', ' #{@aimux_profile} ']);
    deps.tmux(['select-pane', '-t', firstPane]);
  } catch (err) {
    // Leave nothing half-built behind: a detached session nobody is attached to, or a
    // stray window in the user's own tmux.
    try {
      if (!opts.insideTmux) deps.tmux(['kill-session', '-t', opts.sessionName]);
      else if (firstPane) deps.tmux(['kill-window', '-t', firstPane]);
    } catch {
      // already gone
    }
    throw err;
  }

  if (!opts.insideTmux) deps.attach(['attach-session', '-t', opts.sessionName]);
}
