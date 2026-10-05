import { Box, Text, useStdout } from 'ink';
import { useMemo, type ReactNode } from 'react';
import stringWidth from 'string-width';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { expandHome } from '../core/paths.js';
import { baseEnvFor, loadProfileEnv } from '../core/run.js';
import { readProfileAutoMode, type AutoModeStatus } from '../core/autoMode.js';
import { getSharedElements, checkAllProfiles } from '../core/symlinks.js';
import { adapterFor } from '../core/adapters/index.js';
import type { RateLimitProbe } from '../core/limits.js';
import { windowPct, probeFallback, resetCell } from './rateLimitCell.js';

interface Props {
  config: AimuxConfig;
  /** Live 5h/7d subscription windows, probed by the caller before render (the
   *  probe is a network round-trip, so the view stays synchronous and just
   *  displays what it is given). Omit to hide the column entirely — that is
   *  what `--no-limits` does. */
  limits?: Map<string, RateLimitProbe>;
  /** A dim line under the table — `status --watch` says when it last read and how often. */
  footer?: string;
}

type AuthStatus =
  | { kind: 'oauth'; active: boolean }
  | { kind: 'api'; varCount: number }
  | { kind: 'none' };

function isAuthenticated(status: AuthStatus): boolean {
  return status.kind === 'api' || (status.kind === 'oauth' && status.active);
}

function checkAuth(profile: ProfileConfig): AuthStatus {
  const profilePath = expandHome(profile.path);

  // A non-source profile pointing at a 3rd-party API endpoint authenticates
  // via env (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN), not OAuth. The source
  // profile is the user's real ~/.claude and is always treated as a
  // subscription regardless of any stray .env it may carry.
  if (!profile.is_source) {
    const env = loadProfileEnv(profile, profilePath);
    if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) {
      return { kind: 'api', varCount: Object.keys(env).length };
    }
  }

  if (existsSync(join(profilePath, adapterFor(profile.cli).credentialsFile()))) {
    return { kind: 'oauth', active: true };
  }

  // The OAuth-status probe is claude-specific (`claude auth status` JSON, CLAUDE_CONFIG_DIR).
  // For other CLIs the credential-file check above is the verdict — no doomed subprocess.
  if (profile.cli !== 'claude') {
    return { kind: 'none' };
  }

  const probeEnv: Record<string, string> = {};
  if (!profile.is_source) {
    probeEnv.CLAUDE_CONFIG_DIR = profilePath;
  }
  try {
    const result = spawnSync(profile.cli, ['auth', 'status'], {
      env: { ...baseEnvFor(profile, profilePath), ...probeEnv },
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = result.stdout?.toString() ?? '';
    const active = output.includes('"loggedIn": true') || output.includes('"loggedIn":true');
    return { kind: 'oauth', active };
  } catch {
    return { kind: 'none' };
  }
}

function capCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

function authText(auth: AuthStatus): string {
  if (auth.kind === 'api') return `✓ api (${auth.varCount} vars)`;
  return isAuthenticated(auth) ? '✓ oauth' : '✗ no auth';
}

function autoModeText(mode: AutoModeStatus): string {
  return mode.configured ? `✓${capCount(mode.allowCount)} ✗${capCount(mode.softDenyCount)}` : '—';
}

/** One profile's rate-limit cell: the two windows, or whatever the probe has to
 *  say instead (never probed / stale token / network failure). */
function limitCell(probe: RateLimitProbe | undefined) {
  if (!probe?.status) return probeFallback(probe);
  return (
    <Text wrap="truncate-end">
      {windowPct(probe.status.fiveHourPct)}
      <Text dimColor> / </Text>
      {windowPct(probe.status.weeklyPct)}
    </Text>
  );
}

function Head({ children }: { children: ReactNode }) {
  return <Text bold underline wrap="truncate-end">{children}</Text>;
}

function safeGetSharedElements(config: AimuxConfig): string[] {
  try {
    return getSharedElements(config);
  } catch {
    return [];
  }
}

export function StatusView({ config, limits, footer }: Props) {
  const profiles = Object.entries(config.profiles);
  const authStatuses = new Map(profiles.map(([name, profile]) => [name, checkAuth(profile)]));
  // Memoized on config: each entry reads a settings.json synchronously, so we
  // avoid re-reading every profile's file on every Ink re-render (resize/keypress).
  const autoModes = useMemo(
    () => new Map(profiles.map(([name, profile]) => [name, readProfileAutoMode(expandHome(profile.path))])),
    [config],
  );
  const authCount = Array.from(authStatuses.values()).filter(isAuthenticated).length;
  const sharedEntries = safeGetSharedElements(config);
  const sharedCount = sharedEntries.length;
  const reports = checkAllProfiles(config);
  // The profile activated in THIS shell via `aimux use` (per-shell env var).
  // Only honored when it resolves to a real profile, so a stale var never lies.
  const envActive = process.env.AIMUX_PROFILE;
  const activeProfile = envActive && config.profiles[envActive] ? envActive : undefined;
  // Profiles whose stored token the provider rejected. Worth naming explicitly:
  // "login?" in a cell says something is wrong but not what to do about it.
  const staleAuth = limits
    ? [...limits].filter(([, probe]) => probe.error === 'auth').map(([name]) => name)
    : [];

  // Columns are as wide as their widest cell, not a fixed guess: fixed widths
  // needed ~130 columns and Ink wrapped every row in half on a normal terminal.
  // Measured in terminal cells, so a wide-glyph profile name lines up too.
  const fit = (header: string, cells: string[]) => Math.max(stringWidth(header), ...cells.map((c) => stringWidth(c)));
  const widths = {
    name: fit('  NAME', profiles.map(([name]) => `  ${name}`)),
    auth: fit('AUTH', profiles.map(([name]) => authText(authStatuses.get(name) ?? { kind: 'none' }))),
    model: fit('MODEL', profiles.map(([, p]) => p.model ?? 'default')),
    autoMode: fit('AUTOMODE', [...autoModes.values()].map(autoModeText)),
    shared: fit('SHARED', ['(source)', `${sharedCount}/${sharedCount}`]),
    used: '100% / 100%'.length,
    resets: 'Sep 30 / Oct 10'.length,
  };

  // When the table would not fit, the least urgent columns go first — reset times,
  // then auto-mode rules — rather than letting Ink wrap every row in half. Whatever
  // is still too wide after that is cut short; usage percentages never are.
  const { stdout } = useStdout();
  // COLUMNS is the fallback when stdout is not a TTY (piped output), which is
  // also how Ink itself sizes the frame — without it the two disagree.
  const columns = stdout?.columns || Number(process.env.COLUMNS) || 80;
  const GAP = 2;
  const FRAME = 8; // outer padding, border and inner padding, both sides
  const fits = (width: number) => FRAME + width <= columns;
  let tableWidth = widths.name + widths.auth + widths.model + widths.shared + 3 * GAP
    + (limits ? widths.used + GAP : 0);

  // Auto-mode rules live in the shared settings.json, so a configured-but-empty
  // block shows the same `✓0 ✗0` on every row — the column earns its space only
  // when some profile actually has rules.
  const showAutoMode = [...autoModes.values()].some((m) => m.allowCount + m.softDenyCount > 0)
    && fits(tableWidth + GAP + widths.autoMode);
  if (showAutoMode) tableWidth += GAP + widths.autoMode;
  const showResets = Boolean(limits) && fits(tableWidth + GAP + widths.resets);

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">aimux status</Text>
        <Text> </Text>
        <Text>Shared source: <Text color="green">{config.shared_source}</Text></Text>
        <Text>Profiles: <Text bold>{profiles.length}</Text> ({authCount} authenticated)</Text>
        <Text>Shared elements: <Text bold>{sharedCount}</Text></Text>
        <Text>Private elements: <Text bold>{config.private.length}</Text></Text>
        <Text>Active here: {activeProfile
          ? <Text bold color="green">{activeProfile}</Text>
          : <Text dimColor>none (run `aimux use &lt;profile&gt;`)</Text>}</Text>
        <Text> </Text>

        <Box flexDirection="column">
          <Box gap={GAP}>
            <Box width={widths.name}><Head>{'  NAME'}</Head></Box>
            <Box width={widths.auth}><Head>AUTH</Head></Box>
            <Box width={widths.model}><Head>MODEL</Head></Box>
            {showAutoMode ? <Box width={widths.autoMode}><Head>AUTOMODE</Head></Box> : null}
            <Box width={widths.shared}><Head>SHARED</Head></Box>
            {limits ? <Box width={widths.used} flexShrink={0}><Head>USED 5H/7D</Head></Box> : null}
            {showResets ? <Box width={widths.resets}><Head>RESETS</Head></Box> : null}
          </Box>

          {profiles.map(([name, profile]) => {
            const auth = authStatuses.get(name) ?? { kind: 'none' as const };
            const authed = isAuthenticated(auth);
            const autoMode = autoModes.get(name) ?? { configured: false, allowCount: 0, softDenyCount: 0 };
            const isSource = profile.is_source ?? false;
            const report = reports.get(name);
            const healthyShared = isSource ? sharedCount : report?.valid.length ?? 0;
            const issueCount = isSource
              ? 0
              : (report?.broken.length ?? 0)
                + (report?.missing.length ?? 0)
                + (report?.orphaned.length ?? 0)
                + (report?.conflicts.length ?? 0);
            const sharedStatus = isSource ? '(source)' : `${healthyShared}/${sharedCount}`;
            const sharedColor = isSource
              ? undefined
              : (report?.conflicts.length ?? 0) > 0 || (report?.broken.length ?? 0) > 0
                ? 'red'
                : issueCount === 0
                  ? 'green'
                  : 'yellow';

            const isActive = name === activeProfile;
            return (
              <Box key={name} gap={GAP}>
                <Box width={widths.name}>
                  <Text color={isActive ? 'green' : isSource ? 'yellow' : 'white'} bold={isActive} wrap="truncate-end">
                    {isActive ? '▸ ' : '  '}{name}
                  </Text>
                </Box>
                <Box width={widths.auth}>
                  <Text color={auth.kind === 'api' ? 'cyan' : authed ? 'green' : 'red'} wrap="truncate-end">{authText(auth)}</Text>
                </Box>
                <Box width={widths.model}>
                  <Text dimColor wrap="truncate-end">{profile.model ?? 'default'}</Text>
                </Box>
                {showAutoMode ? (
                  <Box width={widths.autoMode}>
                    <Text color={autoMode.configured ? 'cyan' : undefined} dimColor={!autoMode.configured} wrap="truncate-end">
                      {autoModeText(autoMode)}
                    </Text>
                  </Box>
                ) : null}
                <Box width={widths.shared}>
                  <Text color={sharedColor} wrap="truncate-end">
                    {sharedStatus}
                  </Text>
                </Box>
                {limits ? <Box width={widths.used} flexShrink={0}>{limitCell(limits.get(name))}</Box> : null}
                {showResets ? <Box width={widths.resets}>{resetCell(limits?.get(name))}</Box> : null}
              </Box>
            );
          })}

          {footer ? (
            <>
              <Text> </Text>
              <Text dimColor>{footer}</Text>
            </>
          ) : null}

          {staleAuth.length > 0 ? (
            <>
              <Text> </Text>
              <Text dimColor>
                login? — stored token expired for {staleAuth.join(', ')}. The CLI refreshes it on
                its next run: `aimux run {staleAuth[0]}`.
              </Text>
            </>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
