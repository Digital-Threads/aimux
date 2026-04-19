import { Box, Text } from 'ink';
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from '../core/paths.js';

interface Props {
  config: AimuxConfig;
}

function checkAuth(profilePath: string): boolean {
  return existsSync(join(profilePath, '.credentials.json'));
}

function countSymlinks(profilePath: string, sharedSource: string): [number, number] {
  const sourcePath = expandHome(sharedSource);
  if (!existsSync(sourcePath)) return [0, 0];

  const entries = readdirSync(sourcePath);
  let total = 0;
  let linked = 0;

  for (const entry of entries) {
    const profileEntry = join(profilePath, entry);
    total++;
    try {
      const stat = lstatSync(profileEntry);
      if (stat.isSymbolicLink()) linked++;
    } catch {
      // missing
    }
  }
  return [linked, total];
}

export function StatusView({ config }: Props) {
  const profiles = Object.entries(config.profiles);

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">aimux status</Text>
        <Text> </Text>
        <Text>Shared source: <Text color="green">{config.shared_source}</Text></Text>
        <Text>Profiles: <Text bold>{profiles.length}</Text></Text>
        <Text>Private elements: <Text bold>{config.private.length}</Text></Text>
        <Text> </Text>

        <Box flexDirection="column">
          <Box gap={2}>
            <Box width={12}><Text bold underline>NAME</Text></Box>
            <Box width={14}><Text bold underline>AUTH</Text></Box>
            <Box width={20}><Text bold underline>MODEL</Text></Box>
            <Box width={18}><Text bold underline>SYMLINKS</Text></Box>
          </Box>

          {profiles.map(([name, profile]) => {
            const pPath = expandHome(profile.path);
            const authed = checkAuth(pPath);
            const isSource = profile.is_source ?? false;
            const [linked, total] = isSource ? [0, 0] : countSymlinks(pPath, config.shared_source);

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
                  <Text dimColor>
                    {isSource ? '(source)' : `${linked}/${total}`}
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
