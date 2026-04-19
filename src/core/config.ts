import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import type { AimuxConfig } from '../types/index.js';
import { CONFIG_PATH, AIMUX_DIR } from './paths.js';

export function loadConfig(): AimuxConfig | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return parse(raw) as AimuxConfig;
}

export function saveConfig(config: AimuxConfig): void {
  if (!existsSync(AIMUX_DIR)) {
    mkdirSync(AIMUX_DIR, { recursive: true });
  }
  const yamlStr = stringify(config, { lineWidth: 120 });
  writeFileSync(CONFIG_PATH, yamlStr, 'utf-8');
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function ensureAimuxDir(): void {
  if (!existsSync(AIMUX_DIR)) {
    mkdirSync(AIMUX_DIR, { recursive: true });
  }
  const profilesDir = `${AIMUX_DIR}/profiles`;
  if (!existsSync(profilesDir)) {
    mkdirSync(profilesDir, { recursive: true });
  }
}
