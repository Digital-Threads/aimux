import { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { AimuxConfig } from '../types/index.js';

interface Props {
  config: AimuxConfig;
  lastProfile?: string | null;
  onSelect: (profileName: string) => void;
}

export function ProfilePicker({ config, lastProfile, onSelect }: Props) {
  const profiles = Object.entries(config.profiles);
  const initialIndex = lastProfile
    ? Math.max(0, profiles.findIndex(([name]) => name === lastProfile))
    : 0;
  const [cursor, setCursor] = useState(initialIndex);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor(prev => (prev > 0 ? prev - 1 : profiles.length - 1));
    } else if (key.downArrow) {
      setCursor(prev => (prev < profiles.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      onSelect(profiles[cursor][0]);
    } else if (input === 'q' || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Select profile:</Text>
      <Text dimColor>(↑↓ navigate, Enter select, q quit)</Text>
      <Text> </Text>
      {profiles.map(([name, profile], i) => {
        const isSelected = i === cursor;
        const tag = profile.is_source ? ' (source)' : '';
        const model = profile.model ? ` [${profile.model}]` : '';
        const hint = name === lastProfile ? ' ← last used' : '';

        return (
          <Box key={name}>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {isSelected ? '❯ ' : '  '}{name}{model}{tag}
              {hint && <Text dimColor>{hint}</Text>}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
