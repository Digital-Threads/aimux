import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { expandHome } from '../core/paths.js';
import { loadProfileEnv } from '../core/run.js';
import { readProfileAutoMode } from '../core/autoMode.js';
import { getSharedElements, checkAllProfiles } from '../core/symlinks.js';
import { adapterFor } from '../core/adapters/index.js';
import type { RateLimitProbe } from '../core/limits.js';
import { windowPct, probeFallback } from './rateLimitCell.js';

interface Props {
  config: AimuxConfig;
  /** Live 5h/7d subscription windows, probed by the caller before render (the
   *  probe is a network round-trip, so the view stays synchronous and just
   *  displays what it is given). Omit to hide the column entirely — that is
   *  what `--no-limits` does. */
  limits?: Map<string, RateLimitProbe>;
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
      env: { ...process.env, ...probeEnv },
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

/** One profile's rate-limit cell: the two windows, or whatever the probe has to
 *  say instead (never probed / stale token / network failure). */
function limitCell(probe: RateLimitProbe | undefined) {
  if (!probe?.status) return probeFallback(probe);
  return (
    <Text>
      {windowPct(probe.status.fiveHourPct)}
      <Text dimColor> / </Text>
      {windowPct(probe.status.weeklyPct)}
    </Text>
  );
}

function safeGetSharedElements(config: AimuxConfig): string[] {
  try {
    return getSharedElements(config);
  } catch {
    return [];
  }
}

export function StatusView({ config, limits }: Props) {
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
          <Box gap={2}>
            <Box width={12}><Text bold underline>{'  NAME'}</Text></Box>
            <Box width={16}><Text bold underline>AUTH</Text></Box>
            <Box width={20}><Text bold underline>MODEL</Text></Box>
            <Box width={16}><Text bold underline>AUTOMODE</Text></Box>
            <Box width={18}><Text bold underline>SHARED</Text></Box>
            {limits ? <Box width={16}><Text bold underline>USED 5H/7D</Text></Box> : null}
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
              <Box key={name} gap={2}>
                <Box width={12}>
                  <Text color={isActive ? 'green' : isSource ? 'yellow' : 'white'} bold={isActive}>
                    {isActive ? '▸ ' : '  '}{name}
                  </Text>
                </Box>
                <Box width={16}>
                  {auth.kind === 'api'
                    ? <Text color="cyan">✓ api ({auth.varCount} vars)</Text>
                    : <Text color={authed ? 'green' : 'red'}>{authed ? '✓ oauth' : '✗ no auth'}</Text>
                  }
                </Box>
                <Box width={20}>
                  <Text dimColor>{profile.model ?? 'default'}</Text>
                </Box>
                <Box width={16}>
                  {autoMode.configured
                    ? <Text color="cyan">✓{capCount(autoMode.allowCount)} ✗{capCount(autoMode.softDenyCount)}</Text>
                    : <Text dimColor>—</Text>
                  }
                </Box>
                <Box width={18}>
                  <Text color={sharedColor}>
                    {sharedStatus}
                  </Text>
                </Box>
                {limits ? <Box width={16}>{limitCell(limits.get(name))}</Box> : null}
              </Box>
            );
          })}

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
