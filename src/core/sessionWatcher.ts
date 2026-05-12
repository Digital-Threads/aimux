import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FSWatcher } from 'node:fs';
import type { AimuxConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';

export function watchSessions(
  config: AimuxConfig,
  onChange: () => void,
  debounceMs = 500,
): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch {
        // ignore
      }
    }, debounceMs);
  };

  for (const profileName of Object.keys(config.profiles)) {
    try {
      const profile = getProfile(config, profileName);
      const profilePath = expandHome(profile.path);
      const jobsDir = join(profilePath, 'jobs');
      const rosterPath = join(profilePath, 'daemon', 'roster.json');

      if (existsSync(jobsDir)) {
        try {
          watchers.push(watch(jobsDir, { recursive: true }, trigger));
        } catch {
          // recursive may be unsupported on some platforms
          watchers.push(watch(jobsDir, trigger));
        }
      }
      if (existsSync(rosterPath)) {
        watchers.push(watch(rosterPath, trigger));
      }
    } catch {
      // ignore per-profile watcher errors
    }
  }

  const projectsRoot = join(expandHome(config.shared_source), 'projects');
  if (existsSync(projectsRoot)) {
    try {
      watchers.push(watch(projectsRoot, { recursive: true }, trigger));
    } catch {
      watchers.push(watch(projectsRoot, trigger));
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
  };
}
