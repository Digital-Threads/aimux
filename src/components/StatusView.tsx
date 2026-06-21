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

interface Props {
  config: AimuxConfig;
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

function safeGetSharedElements(config: AimuxConfig): string[] {
  try {
    return getSharedElements(config);
  } catch {
    return [];
  }
}

export function StatusView({ config }: Props) {
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

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">aimux status</Text>
        <Text> </Text>
        <Text>Shared source: <Text color="green">{config.shared_source}</Text></Text>
        <Text>Profiles: <Text bold>{profiles.length}</Text> ({authCount} authenticated)</Text>
        <Text>Shared elements: <Text bold>{sharedCount}</Text></Text>
        <Text>Private elements: <Text bold>{config.private.length}</Text></Text>
        <Text> </Text>

        <Box flexDirection="column">
          <Box gap={2}>
            <Box width={12}><Text bold underline>NAME</Text></Box>
            <Box width={16}><Text bold underline>AUTH</Text></Box>
            <Box width={20}><Text bold underline>MODEL</Text></Box>
            <Box width={16}><Text bold underline>AUTOMODE</Text></Box>
            <Box width={18}><Text bold underline>SHARED</Text></Box>
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

            return (
              <Box key={name} gap={2}>
                <Box width={12}>
                  <Text color={isSource ? 'yellow' : 'white'}>{name}</Text>
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
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
