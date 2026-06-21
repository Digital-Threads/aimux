#!/usr/bin/env node
import { Command } from 'commander';
import type { AimuxConfig } from './types/index.js';
import type { ProfileUsageSummary } from './core/index.js';
import { rmSync, existsSync, cpSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, saveConfig, addProfile, removeProfile, expandHome,
  ensureProfileDir, initAutoDetect, initFromSource, detectClaudeDirs, detectCodex,
  syncProfile, syncAllProfiles, checkAllProfiles,
  launchProfile, getLastProfile, recordHistory, getProfile,
  looksLikeSubcommand, adapterFor,
  summarizeUsage, parseSinceDuration, totalTokens,
  loadProfileEnv, collectApiCredentials, collectProviderCredentials, PROVIDER_PRESETS, writeProfileDotEnv, mergeProfileDotEnv, checkDotenvPermissions, seedApiClaudeJson,
} from './core/index.js';

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requireConfig(): AimuxConfig {
  const config = loadConfig();
  if (!config) {
    console.error('aimux not initialized. Run: aimux init');
    process.exit(1);
  }
  return config;
}

function resolveProfile(config: AimuxConfig, input: string): string {
  if (config.profiles[input]) return input;
  const matches = Object.keys(config.profiles).filter(n => n.startsWith(input));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Ambiguous profile '${input}': ${matches.join(', ')}`);
    process.exit(1);
  }
  console.error(`Profile '${input}' not found`);
  process.exit(1);
}

function getCliVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
    return packageJson.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function formatSyncSummary(result: {
  created: string[];
  repaired: string[];
  conflicts: string[];
}): string {
  const parts = [`${result.created.length} created`, `${result.repaired.length} repaired`];
  if (result.conflicts.length > 0) {
    parts.push(`${result.conflicts.length} conflicts`);
  }
  return parts.join(', ');
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function topModels(models: Map<string, number>): string {
  const entries = Array.from(models.entries()).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '-';
  return entries.slice(0, 2).map(([model]) => model).join(', ');
}

function printUsageTable(summaries: ProfileUsageSummary[]): void {
  const headers = ['PROFILE', 'SESS', 'REQ', 'INPUT', 'CACHE+', 'CACHE', 'OUTPUT', 'TOTAL', 'COST', 'MODELS'];
  const rows = summaries.map((s) => [
    s.profile,
    formatInteger(s.sessions),
    formatInteger(s.requests),
    formatInteger(s.inputTokens),
    formatInteger(s.cacheCreationInputTokens),
    formatInteger(s.cacheReadInputTokens),
    formatInteger(s.outputTokens),
    formatInteger(totalTokens(s)),
    formatUsd(s.estimatedCostUsd),
    topModels(s.models),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  '));
  }
}


const program = new Command();

program
  .name('aimux')
  .description('Local AI workspace orchestrator — manage multiple AI CLI subscriptions')
  .version(getCliVersion())
  .enablePositionalOptions();

program
  .command('status')
  .description('Show overview of profiles and shared source')
  .action(async () => {
    const { render } = await import('ink');
    const { StatusView } = await import('./components/StatusView.js');
    render(<StatusView config={requireConfig()} />);
  });

program
  .command('usage')
  .description('Show token usage by profile from Claude transcript metadata')
  .option('-p, --profile <profile>', 'Only show one profile (supports prefix matching)')
  .option('--since <duration>', 'Only include usage since duration: 24h, 7d, 4w', '7d')
  .option('--all', 'Include all known transcript usage')
  .action(async (options: { profile?: string; since: string; all?: boolean }) => {
    try {
      const config = requireConfig();
      const profile = options.profile ? resolveProfile(config, options.profile) : undefined;
      const sinceMs = options.all ? undefined : parseSinceDuration(options.since);
      const summaries = summarizeUsage(config, { profile, sinceMs });
      printUsageTable(summaries);
      if (!options.all) {
        console.log(`\nWindow: ${options.since}`);
      }
      console.log('Source: shared projects/*.jsonl transcript usage metadata; duplicate requestIds counted once.');
      if (summaries.some((s) => s.profile === 'unknown')) {
        console.log('Note: unknown means aimux could not map a transcript session to a profile.');
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Initialize aimux — detect and migrate existing Claude directories')
  .option('-s, --source <path>', 'Path to shared source directory (default: auto-detect)')
  .action((options: { source?: string }) => {
    try {
      const codexHint = () => {
        if (detectCodex()) {
          console.log('\nCodex detected (~/.codex). Add a Codex profile with:');
          console.log('  aimux profile add codework --cli codex');
        }
      };

      if (options.source) {
        const result = initFromSource(options.source);
        console.log(`✓ Initialized with source: ${result.source}`);
        codexHint();
        return;
      }

      const dirs = detectClaudeDirs();
      if (dirs.length === 0) {
        console.error('No Claude directories found. Use --source <path> to specify.');
        process.exit(1);
      }

      console.log(`Found ${dirs.length} Claude director${dirs.length === 1 ? 'y' : 'ies'}:`);
      for (const d of dirs) {
        const tag = d.isSource ? ' (source)' : '';
        const auth = d.hasCredentials ? '✓ auth' : '✗ no auth';
        console.log(`  ${d.name}: ${d.path} — ${d.realFileCount} files, ${d.symlinkCount} symlinks [${auth}]${tag}`);
      }

      const result = initAutoDetect();
      console.log(`\n✓ Config created: source=${result.source}`);
      for (const p of result.profiles) {
        const copied = p.privatesCopied.length > 0 ? `, private: ${p.privatesCopied.join(', ')}` : '';
        console.log(`  ${p.name}: ${p.sync.created.length} symlinks created${copied}`);
      }
      codexHint();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('run [profile] [cliArgs...]')
  .description('Launch AI CLI with the specified profile (extra flags forwarded to CLI)')
  .option('-m, --model <model>', 'Override default model')
  .allowUnknownOption()
  .action(async (profile: string | undefined, cliArgs: string[], options: { model?: string }) => {
    try {
      const config = requireConfig();
      let profileName = profile;
      const launchingSubcommand = looksLikeSubcommand(cliArgs[0]);

      if (!profileName) {
        const cwd = process.cwd();
        const last = getLastProfile(cwd);
        const names = Object.keys(config.profiles);

        if (names.length === 1) {
          profileName = names[0];
        } else {
          const { render } = await import('ink');
          const { ProfilePicker } = await import('./components/ProfilePicker.js');
          let selectedProfile: string | undefined;
          const { waitUntilExit } = render(
            <ProfilePicker
              config={config}
              lastProfile={last}
              onSelect={(selected: string) => {
                selectedProfile = selected;
              }}
            />
          );
          await waitUntilExit();
          if (!selectedProfile) return;
          profileName = selectedProfile;
        }
      }

      profileName = resolveProfile(config, profileName);

      if (!config.profiles[profileName].is_source && !launchingSubcommand) {
        const sync = syncProfile(config, profileName);
        const hasChanges = sync.created.length > 0 || sync.repaired.length > 0 || sync.conflicts.length > 0;
        if (hasChanges) {
          console.log(`Auto-sync: ${formatSyncSummary(sync)}`);
        }
      }

      if (!launchingSubcommand) {
        recordHistory(process.cwd(), profileName);
      }
      const permWarning = checkDotenvPermissions(expandHome(config.profiles[profileName].path));
      if (permWarning) {
        console.error(`\x1b[33m⚠ ${permWarning}\x1b[0m`);
      }
      const exitCode = await launchProfile(config, profileName, { model: options.model, extraArgs: cliArgs });
      process.exit(exitCode);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('migrate')
  .description('Migration utilities')
  .addCommand(
    new Command('isolate')
      .description('Convert per-profile jobs/daemon/projects symlinks into real private dirs so each profile gets its own supervisor + sessions (one-time, safe — no data is deleted)')
      .option('--dry-run', 'Show what would change without touching the filesystem')
      .action(async (options: { dryRun?: boolean }) => {
        try {
          const config = requireConfig();
          const { isolateProfile } = await import('./core/migration.js');
          const { lstatSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');

          const nonSource = Object.entries(config.profiles).filter(([, p]) => !p.is_source);
          if (nonSource.length === 0) {
            console.log('No non-source profiles to isolate.');
            return;
          }

          let totalUnlinked = 0;
          for (const [name, profile] of nonSource) {
            if (options.dryRun) {
              const profilePath = expandHome(profile.path);
              const wouldUnlink: string[] = [];
              for (const element of config.private) {
                const target = join(profilePath, element);
                try {
                  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
                    wouldUnlink.push(element);
                  }
                } catch {
                  // ignore
                }
              }
              if (wouldUnlink.length === 0) {
                console.log(`✓ ${name}: already isolated`);
              } else {
                console.log(`• ${name}: would convert ${wouldUnlink.length} symlink(s): ${wouldUnlink.join(', ')}`);
                totalUnlinked += wouldUnlink.length;
              }
              continue;
            }

            const result = isolateProfile(config, name);
            if (result.unlinkedSymlinks.length === 0) {
              console.log(`✓ ${name}: already isolated`);
            } else {
              totalUnlinked += result.unlinkedSymlinks.length;
              console.log(`✓ ${name}: converted ${result.unlinkedSymlinks.join(', ')} to private dirs`);
            }
          }

          // Persist the merged private list so future syncs respect it.
          if (!options.dryRun) {
            saveConfig(config);
          }

          if (totalUnlinked === 0) {
            console.log('\nAll profiles already isolated.');
          } else {
            console.log(`\nDone. ${totalUnlinked} symlink(s) converted. Each non-source profile now has its own supervisor and sessions.`);
            console.log('Existing sessions in the source profile (~/.claude/jobs/) remain accessible from the source profile only.');
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('share-projects')
      .description('Re-share <profile>/projects/ with the source so interactive session transcripts work across profiles (resume the same session from another subscription when limits hit). Earlier 0.3.0 migrate isolate over-isolated projects/ — this reverts that subset.')
      .action(async () => {
        try {
          const config = requireConfig();
          const { shareProjectsForAllProfiles } = await import('./core/migration.js');
          const result = shareProjectsForAllProfiles(config);
          let symlinked = 0;
          let conflicts = 0;
          for (const r of result.perProfile) {
            if (r.status === 'symlinked') {
              symlinked++;
              console.log(`✓ ${r.profile}: projects/ re-symlinked to source`);
            } else if (r.status === 'already-shared') {
              console.log(`• ${r.profile}: already shared`);
            } else if (r.status === 'skipped-missing-source') {
              console.log(`⚠ ${r.profile}: source projects/ missing — skipped`);
            } else if (r.status === 'skipped-non-empty') {
              conflicts++;
              console.log(`⚠ ${r.profile}: projects/ is non-empty (${r.contents?.length ?? 0} entries) — skipped to avoid losing data`);
              console.log(`  Manual: merge contents into ${expandHome(config.shared_source)}/projects/ then remove ${expandHome(config.profiles[r.profile].path)}/projects/ and re-run.`);
            }
          }
          console.log(
            `\nDone. ${symlinked} profile(s) re-shared.` +
            (conflicts > 0 ? ` ${conflicts} need manual merge.` : ''),
          );
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      }),
  );

program
  .command('agents')
  .description('Multi-profile agent view — manage claude background sessions across all profiles')
  .action(async () => {
    try {
      const config = requireConfig();
      // Warn once at startup if any non-source profile still has its
      // session-state dirs symlinked to the source — without isolation
      // every profile shares the same sessions.
      const { lstatSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const sharedProfiles: string[] = [];
      for (const [pname, pcfg] of Object.entries(config.profiles)) {
        if (pcfg.is_source) continue;
        const ppath = expandHome(pcfg.path);
        for (const element of ['jobs', 'daemon']) {
          const target = join(ppath, element);
          try {
            if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
              sharedProfiles.push(pname);
              break;
            }
          } catch {
            // ignore per-profile errors
          }
        }
      }
      if (sharedProfiles.length > 0) {
        console.error(
          `\x1b[33m⚠ Profiles still share sessions with the source: ${sharedProfiles.join(', ')}\n` +
          `  Run \`aimux migrate isolate\` so each profile gets its own supervisor.\n\x1b[0m`,
        );
      }

      const { render } = await import('ink');
      const { AgentsView } = await import('./components/AgentsView.js');
      const { resumeSession } = await import('./core/sessionActions.js');
      const { recordSessionUsage } = await import('./core/sessionHistory.js');

      type PendingAction =
        | { type: 'exit' }
        | { type: 'attach'; profile: string; sessionId: string; cwd: string; live: boolean; cli: string };

      const { existsSync: existsSyncFn } = await import('node:fs');

      let running = true;
      while (running) {
        const actionRef: { value: PendingAction } = { value: { type: 'exit' } };

        const { waitUntilExit, unmount } = render(
          <AgentsView
            config={config}
            onAction={(action) => {
              actionRef.value = action;
            }}
          />
        );
        await waitUntilExit();
        unmount();

        const action = actionRef.value;
        switch (action.type) {
          case 'exit':
            running = false;
            break;
          case 'attach': {
            // Cross-CLI attach (e.g. a claude session under a codex profile) is NOT a
            // native resume — the transcripts are mutually unreadable. That is the
            // summary-handoff path (`aimux handoff`), shipped separately. Guard it here.
            const targetCli = getProfile(config, action.profile).cli;
            if (targetCli !== action.cli) {
              console.error(
                `Cannot resume a ${action.cli} session under a ${targetCli} profile — ` +
                `cross-CLI continuation uses summary handoff (coming via 'aimux handoff'). ` +
                `Attach via a ${action.cli} profile instead.`,
              );
              break;
            }
            // Same as `aimux run <profile> --resume <id>`: resume the shared
            // transcript under the chosen profile. A live session needs
            // --fork-session (claude refuses to resume a running one otherwise).
            const cwd = action.cwd && existsSyncFn(action.cwd) ? action.cwd : undefined;
            const code = await resumeSession(config, action.profile, action.sessionId, {
              cwd,
              forkSession: action.live,
            });
            recordSessionUsage(action.sessionId, action.profile);
            if (code !== 0) console.error(`Resume exited with code ${code}`);
            break;
          }
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('profile')
  .description('Manage profiles')
  .addCommand(
    new Command('add')
      .argument('<name>', 'Profile name')
      .option('--no-auth', 'Skip authentication')
      .option('-m, --model <model>', 'Default model for this profile')
      .option('--fallback-model <model>', 'Fallback model when the primary is overloaded/unavailable')
      .option('--api', 'Configure a 3rd-party API endpoint instead of a Claude subscription')
      .option('--provider <name>', 'Anthropic-compatible provider preset (deepseek, kimi, glm, qwen, minimax, mimo)')
      .option('--cli <cli>', 'CLI for this profile (claude, codex, …)', 'claude')
      .description('Add a new profile')
      .action(async (name: string, options: { auth: boolean; model?: string; fallbackModel?: string; api?: boolean; provider?: string; cli?: string }) => {
        try {
          const config = requireConfig();

          // Reject a duplicate name up front so the user isn't asked to type a
          // token blind only to hit "already exists" after the prompts.
          if (config.profiles[name]) {
            throw new Error(`Profile '${name}' already exists`);
          }

          // Collect credentials BEFORE mutating config/disk so a Ctrl+C
          // mid-prompt leaves no half-created profile behind.
          let apiVars: Record<string, string> | undefined;
          if (options.provider) {
            // Provider presets are Anthropic-compatible endpoints — they run on the claude
            // CLI. A non-claude --cli would ignore the ANTHROPIC_* env entirely.
            if ((options.cli ?? 'claude') !== 'claude') {
              throw new Error(`--provider works only with the claude CLI, not --cli ${options.cli}`);
            }
            const preset = PROVIDER_PRESETS[options.provider.toLowerCase()];
            if (!preset) {
              throw new Error(
                `Unknown provider '${options.provider}'. Available: ${Object.keys(PROVIDER_PRESETS).join(', ')}`,
              );
            }
            console.log(`Configure ${preset.label} (${preset.baseUrl}) — enter your API token:`);
            apiVars = await collectProviderCredentials(preset);
          } else if (options.api) {
            console.log('Configure API endpoint (leave blank to use default):');
            apiVars = await collectApiCredentials();
          }

          const updated = addProfile(config, name, { cli: options.cli, model: options.model, fallbackModel: options.fallbackModel });
          saveConfig(updated);
          const profilePath = ensureProfileDir(updated, name);
          const sync = syncProfile(updated, name);
          console.log(`✓ Profile '${name}' created`);
          if (sync.created.length > 0) {
            console.log(`  ${sync.created.length} symlinks created`);
          }
          if (sync.conflicts.length > 0) {
            console.log(`  conflicts left unchanged: ${sync.conflicts.join(', ')}`);
          }

          if (apiVars) {
            writeProfileDotEnv(profilePath, apiVars);
            console.log(`  Credentials saved to ${join(profilePath, '.env')} (chmod 600)`);
            if (seedApiClaudeJson(profilePath)) {
              console.log('  Seeded .claude.json (skips Claude Code onboarding)');
            }
            console.log(`  Run: aimux run ${name}`);
          } else if (!options.auth) {
            console.log('  Auth skipped (--no-auth). Run: aimux auth login ' + name);
          } else {
            console.log('  Run: aimux auth login ' + name);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('list')
      .description('List all profiles')
      .action(async () => {
        const { render } = await import('ink');
        const { StatusView } = await import('./components/StatusView.js');
        render(<StatusView config={requireConfig()} />);
      })
  )
  .addCommand(
    new Command('update')
      .argument('<name>', 'Profile name')
      .option('-m, --model <model>', 'Set default model')
      .option('--fallback-model <model>', 'Set fallback model (used when primary is overloaded/unavailable)')
      .option('--unset-fallback-model', 'Remove the fallback model')
      .option('--cli <cli>', 'Set CLI command')
      .option('-e, --env <KEY=VALUE>', 'Set an env var in the profile .env file (repeatable)', collectRepeatable, [])
      .option('--unset-env <KEY>', 'Remove an env var from the profile .env file (repeatable)', collectRepeatable, [])
      .description('Update profile settings')
      .action((name: string, options: { model?: string; fallbackModel?: string; unsetFallbackModel?: boolean; cli?: string; env: string[]; unsetEnv: string[] }) => {
        try {
          const config = requireConfig();
          const resolved = resolveProfile(config, name);
          const profile = config.profiles[resolved];
          if (options.model) profile.model = options.model;
          if (options.fallbackModel) profile.fallback_model = options.fallbackModel;
          if (options.unsetFallbackModel) delete profile.fallback_model;
          if (options.cli) profile.cli = options.cli;
          config.profiles[resolved] = profile;
          saveConfig(config);

          let envChange: { set: string[]; unset: string[] } | undefined;
          if (options.env.length > 0 || options.unsetEnv.length > 0) {
            envChange = mergeProfileDotEnv(expandHome(profile.path), options.env, options.unsetEnv);
          }

          console.log(`✓ Profile '${resolved}' updated`);
          if (options.model) console.log(`  model: ${options.model}`);
          if (options.fallbackModel) console.log(`  fallback model: ${options.fallbackModel}`);
          if (options.unsetFallbackModel) console.log('  fallback model removed');
          if (options.cli) console.log(`  cli: ${options.cli}`);
          if (envChange?.set.length) console.log(`  .env set: ${envChange.set.join(', ')}`);
          if (envChange?.unset.length) console.log(`  .env unset: ${envChange.unset.join(', ')}`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('remove')
      .argument('<name>', 'Profile name')
      .option('--keep-dir', 'Keep profile directory on disk')
      .description('Remove a profile')
      .action((name: string, options: { keepDir?: boolean }) => {
        try {
          let config = requireConfig();
          const resolved = resolveProfile(config, name);
          const profile = config.profiles[resolved];
          const profilePath = profile.path;
          config = removeProfile(config, resolved);
          saveConfig(config);
          if (!options.keepDir) {
            const fullPath = expandHome(profilePath);
            rmSync(fullPath, { recursive: true, force: true });
            console.log(`✓ Profile '${resolved}' removed (directory deleted)`);
          } else {
            console.log(`✓ Profile '${resolved}' removed (directory kept)`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('clone')
      .argument('<source>', 'Source profile to clone')
      .argument('<name>', 'New profile name')
      .option('-m, --model <model>', 'Override model for new profile')
      .description('Clone a profile with its private files')
      .action((source: string, name: string, options: { model?: string }) => {
        try {
          let config = requireConfig();
          const resolvedSrc = resolveProfile(config, source);
          const srcProfile = config.profiles[resolvedSrc];
          if (config.profiles[name]) {
            console.error(`Profile '${name}' already exists`);
            process.exit(1);
          }

          config = addProfile(config, name, {
            cli: srcProfile.cli,
            model: options.model ?? srcProfile.model,
            fallbackModel: srcProfile.fallback_model,
          });
          saveConfig(config);

          const newDir = expandHome(config.profiles[name].path);
          mkdirSync(newDir, { recursive: true });

          const srcDir = expandHome(srcProfile.path);
          for (const item of config.private) {
            const srcPath = join(srcDir, item);
            if (existsSync(srcPath)) {
              cpSync(srcPath, join(newDir, item), { recursive: true });
            }
          }

          const sync = syncProfile(config, name);
          console.log(`✓ Profile '${name}' cloned from '${source}'`);
          console.log(`  ${sync.created.length} symlinks, ${config.private.filter(p => existsSync(join(newDir, p))).length} private files copied`);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  );

program
  .command('rebuild')
  .description('Rebuild symlinks for all profiles and surface local conflicts')
  .argument('[profile]', 'Specific profile to rebuild')
  .action((profile?: string) => {
    try {
      const config = requireConfig();
      if (profile) {
        const resolved = resolveProfile(config, profile);
        const result = syncProfile(config, resolved);
        console.log(`Profile '${resolved}':`);
        console.log(`  created: ${result.created.length}, skipped: ${result.skipped.length}, repaired: ${result.repaired.length}, conflicts: ${result.conflicts.length}, private: ${result.private.length}`);
      } else {
        const results = syncAllProfiles(config);
        for (const [name, result] of results) {
          const src = config.profiles[name]?.is_source ? ' (source)' : '';
          console.log(`${name}${src}: created=${result.created.length} skipped=${result.skipped.length} repaired=${result.repaired.length} conflicts=${result.conflicts.length}`);
        }
        console.log(`\n✓ Rebuilt ${results.size} profiles`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('handoff <sessionId>')
  .description('Continue a session under another profile/CLI via summary handoff')
  .requiredOption('--to <profile>', 'Target profile to continue the session under')
  .action(async (sessionId: string, options: { to: string }) => {
    try {
      const config = requireConfig();
      const toProfile = resolveProfile(config, options.to);
      const { handoffSession } = await import('./core/handoff.js');
      console.log(`Summarizing session '${sessionId}' and handing off to '${toProfile}'…`);
      const res = await handoffSession(config, sessionId, toProfile);
      if (res.exitCode !== 0) console.error(`Handoff target exited with code ${res.exitCode}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Health check — find broken symlinks, missing shared entries, and local conflicts')
  .action(() => {
    try {
      const config = requireConfig();
      const reports = checkAllProfiles(config);
      let healthy = true;

      for (const [name, report] of reports) {
        const src = config.profiles[name]?.is_source ? ' (source)' : '';
        const issues = report.broken.length + report.missing.length + report.orphaned.length + report.conflicts.length;

        if (issues === 0) {
          console.log(`✓ ${name}${src}: ${report.valid.length} valid`);
        } else {
          healthy = false;
          console.log(`✗ ${name}${src}:`);
          if (report.broken.length > 0) console.log(`    broken: ${report.broken.join(', ')}`);
          if (report.missing.length > 0) console.log(`    missing: ${report.missing.join(', ')}`);
          if (report.conflicts.length > 0) console.log(`    conflicts: ${report.conflicts.join(', ')}`);
          if (report.orphaned.length > 0) console.log(`    orphaned: ${report.orphaned.join(', ')}`);
        }
      }

      if (healthy) {
        console.log('\n✓ All profiles healthy');
      } else {
        console.log('\nRun "aimux rebuild" to fix symlink issues');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('auth')
  .description('Manage authentication')
  .addCommand(
    new Command('login')
      .argument('<profile>', 'Profile to authenticate')
      .description('Launch auth flow for a profile')
      .action((profile: string) => {
        try {
          const config = requireConfig();
          const resolved = resolveProfile(config, profile);
          const p = getProfile(config, resolved);
          const adapter = adapterFor(p.cli);
          const profilePath = expandHome(p.path);
          const env: Record<string, string> = loadProfileEnv(p, profilePath);
          Object.assign(env, adapter.configDirEnv(profilePath, p.is_source === true));
          const permWarning = checkDotenvPermissions(profilePath);
          if (permWarning) {
            console.error(`\x1b[33m⚠ ${permWarning}\x1b[0m`);
          }
          console.log(`Launching auth for profile '${resolved}'...`);
          const result = spawnSync(p.cli, adapter.authArgs(), {
            stdio: 'inherit',
            env: { ...process.env, ...env },
          });
          if (result.error) {
            throw new Error(`Failed to launch ${p.cli}: ${result.error.message}`);
          }
          const hasAuth = existsSync(join(profilePath, adapter.credentialsFile()));
          if (hasAuth) {
            console.log(`✓ Profile '${resolved}' authenticated`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command('status')
      .description('Show auth status for all profiles')
      .action(() => {
        try {
          const config = requireConfig();

          for (const [name, profile] of Object.entries(config.profiles)) {
            const pPath = expandHome(profile.path);
            const tag = profile.is_source ? ' (source)' : '';
            const credFile = adapterFor(profile.cli).credentialsFile();
            // The credential file is the auth signal; claude has extra state files worth surfacing.
            const authFiles = profile.cli === 'claude'
              ? [credFile, '.claude.json', 'policy-limits.json', 'mcp-needs-auth-cache.json', 'remote-settings.json']
              : [credFile];
            console.log(`${name} [${profile.cli}]${tag}:`);
            for (const file of authFiles) {
              const exists = existsSync(join(pPath, file));
              console.log(`  ${exists ? '✓' : '✗'} ${file}`);
            }
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  );

program
  .command('completions')
  .argument('<shell>', 'Shell type: bash, zsh, or fish')
  .description('Generate shell completion script')
  .action((shell: string) => {
    const config = loadConfig();
    const profiles = config ? Object.keys(config.profiles).join(' ') : '';

    if (shell === 'bash') {
      console.log(`_aimux() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="init run status usage profile rebuild doctor auth completions"

  case "\${prev}" in
    run|auth)
      COMPREPLY=( $(compgen -W "${profiles}" -- "\${cur}") )
      return 0;;
    profile)
      COMPREPLY=( $(compgen -W "add list update remove clone" -- "\${cur}") )
      return 0;;
    aimux)
      COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      return 0;;
  esac
}
complete -F _aimux aimux
# Add to ~/.bashrc: eval "$(aimux completions bash)"`);
    } else if (shell === 'zsh') {
      console.log(`#compdef aimux
_aimux() {
  local -a commands profiles
  commands=(init run status usage profile rebuild doctor auth completions)
  profiles=(${profiles})

  _arguments '1:command:($commands)' '*::arg:->args'

  case $state in
    args)
      case \${words[1]} in
        run) _arguments '1:profile:($profiles)';;
        profile) _arguments '1:action:(add list update remove clone)';;
        auth) _arguments '1:action:(login status)' '2:profile:($profiles)';;
      esac;;
  esac
}
_aimux
# Add to ~/.zshrc: eval "$(aimux completions zsh)"`);
    } else if (shell === 'fish') {
      console.log(`complete -c aimux -n '__fish_use_subcommand' -a 'init run status usage profile rebuild doctor auth completions'
complete -c aimux -n '__fish_seen_subcommand_from run' -a '${profiles}'
complete -c aimux -n '__fish_seen_subcommand_from profile' -a 'add list update remove clone'
complete -c aimux -n '__fish_seen_subcommand_from auth' -a 'login status'
# Add to config.fish: aimux completions fish | source`);
    } else {
      console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
      process.exit(1);
    }
  });

program
  .command('setup-shell')
  .description('Install shell completions into your shell config')
  .action(async () => {
    const home = (await import('node:os')).homedir();
    const shell = process.env.SHELL ?? '/bin/bash';
    const shellType = shell.includes('fish')
      ? 'fish'
      : shell.includes('zsh')
        ? 'zsh'
        : 'bash';
    const line = shellType === 'fish'
      ? '\naimux completions fish | source'
      : `\neval "$(aimux completions ${shellType})"`;

    const rcFile = shellType === 'fish'
      ? join(home, '.config', 'fish', 'config.fish')
      : shellType === 'zsh'
        ? join(home, '.zshrc')
        : join(home, '.bashrc');
    mkdirSync(dirname(rcFile), { recursive: true });

    const existing = existsSync(rcFile) ? readFileSync(rcFile, 'utf-8') : '';
    if (existing.includes('aimux completions')) {
      console.log(`✓ Completions already in ${rcFile}`);
    } else {
      appendFileSync(rcFile, `\n# aimux — AI workspace orchestrator${line}\n`);
      console.log(`✓ Completions added to ${rcFile}`);
    }

    console.log(`\nReload with: source ${rcFile}`);
  });

program.parse();
