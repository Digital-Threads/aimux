import { Box, Text } from 'ink';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { expandHome } from '../core/paths.js';
import { getSharedElements, checkAllProfiles } from '../core/symlinks.js';

interface Props {
  config: AimuxConfig;
}

function checkAuth(profile: ProfileConfig): boolean {
  const profilePath = expandHome(profile.path);
  if (existsSync(join(profilePath, '.credentials.json'))) return true;
  const env: Record<string, string> = {};
  if (!profile.is_source) {
    env.CLAUDE_CONFIG_DIR = profilePath;
  }
  try {
    const result = spawnSync(profile.cli, ['auth', 'status'], {
      env: { ...process.env, ...env },
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = result.stdout?.toString() ?? '';
    return output.includes('"loggedIn": true') || output.includes('"loggedIn":true');
  } catch {
    return false;
  }
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
  const authCount = Array.from(authStatuses.values()).filter(Boolean).length;
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
            <Box width={14}><Text bold underline>AUTH</Text></Box>
            <Box width={20}><Text bold underline>MODEL</Text></Box>
            <Box width={18}><Text bold underline>SHARED</Text></Box>
          </Box>

          {profiles.map(([name, profile]) => {
            const authed = authStatuses.get(name) ?? false;
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
                <Box width={14}>
                  <Text color={authed ? 'green' : 'red'}>
                    {authed ? '✓ active' : '✗ no auth'}
                  </Text>
                </Box>
                <Box width={20}>
                  <Text dimColor>{profile.model ?? 'default'}</Text>
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
