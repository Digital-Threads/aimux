import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FSWatcher } from 'node:fs';
import type { AimuxConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';

export function watchSessions(
  config: AimuxConfig,
  onChange: () => void,
  debounceMs = 2000,
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

  // Watch only the small, low-traffic state files. The shared projects/
  // tree intentionally is NOT watched — active sessions append to their
  // transcripts constantly, which used to fire fs.watch many times per
  // second and starve the Ink render loop (visible as cursor lag).
  for (const profileName of Object.keys(config.profiles)) {
    try {
      const profile = getProfile(config, profileName);
      const profilePath = expandHome(profile.path);
      const jobsDir = join(profilePath, 'jobs');
      const rosterPath = join(profilePath, 'daemon', 'roster.json');

      if (existsSync(jobsDir)) {
        try {
          watchers.push(watch(jobsDir, trigger));
        } catch {
          // some platforms reject non-recursive watch on dirs that
          // disappear — best-effort.
        }
      }
      if (existsSync(rosterPath)) {
        try {
          watchers.push(watch(rosterPath, trigger));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore per-profile watcher errors
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
