#!/usr/bin/env node
import { Command } from 'commander';
import type { AimuxConfig } from './types/index.js';
import { rmSync, existsSync, cpSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, saveConfig, addProfile, removeProfile, expandHome,
  ensureProfileDir, initAutoDetect, initFromSource, detectClaudeDirs,
  syncProfile, syncAllProfiles, checkAllProfiles,
  launchProfile, getLastProfile, recordHistory, getProfile,
  looksLikeSubcommand,
} from './core/index.js';

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
  .command('init')
  .description('Initialize aimux — detect and migrate existing Claude directories')
  .option('-s, --source <path>', 'Path to shared source directory (default: auto-detect)')
  .action((options: { source?: string }) => {
    try {
      if (options.source) {
        const result = initFromSource(options.source);
        console.log(`✓ Initialized with source: ${result.source}`);
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
      const {
        attachSession,
        resumeSession,
        dispatchSession,
        stopSession,
      } = await import('./core/sessionActions.js');
      const { recordSessionUsage } = await import('./core/sessionHistory.js');

      type PendingAction =
        | { type: 'exit' }
        | {
            type: 'attach';
            profile: string;
            sessionId: string;
            cwd: string;
            isBackground: boolean;
            bgShort?: string;
          }
        | { type: 'dispatch'; profile: string; prompt: string }
        | { type: 'stop'; profile: string; short: string };

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
            // Always use `claude --resume <id>` with the chosen profile's
            // CLAUDE_CONFIG_DIR. Reads transcript from the shared projects/
            // folder, bills the chosen profile — works cross-profile.
            //
            // Trade-off: if a background supervisor in another profile
            // already has this session live, we spawn a second reader
            // process. For interactive resume of a Ctrl+C'd session that's
            // exactly what we want. Background-only sessions are still
            // best handled by attaching via their owning profile.
            void attachSession; // kept exported for future per-profile attach
            const cwdForSession =
              action.cwd && existsSyncFn(action.cwd) ? action.cwd : undefined;
            const code = await resumeSession(
              config,
              action.profile,
              action.sessionId,
              { cwd: cwdForSession },
            );
            recordSessionUsage(action.sessionId, action.profile);
            if (code !== 0) console.error(`Resume exited with code ${code}`);
            break;
          }
          case 'dispatch': {
            const result = dispatchSession(config, action.profile, action.prompt);
            if (result.stdout) process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            break;
          }
          case 'stop': {
            const result = stopSession(config, action.profile, action.short);
            if (result.stderr) process.stderr.write(result.stderr);
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
      .description('Add a new profile')
      .action((name: string, options: { auth: boolean; model?: string }) => {
        try {
          let config = requireConfig();
          config = addProfile(config, name, { model: options.model });
          saveConfig(config);
          ensureProfileDir(config, name);
          const sync = syncProfile(config, name);
          console.log(`✓ Profile '${name}' created`);
          if (sync.created.length > 0) {
            console.log(`  ${sync.created.length} symlinks created`);
          }
          if (sync.conflicts.length > 0) {
            console.log(`  conflicts left unchanged: ${sync.conflicts.join(', ')}`);
          }
          if (!options.auth) {
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
      .option('--cli <cli>', 'Set CLI command')
      .description('Update profile settings')
      .action((name: string, options: { model?: string; cli?: string }) => {
        try {
          let config = requireConfig();
          const resolved = resolveProfile(config, name);
          const profile = config.profiles[resolved];
          if (options.model) profile.model = options.model;
          if (options.cli) profile.cli = options.cli;
          config.profiles[resolved] = profile;
          saveConfig(config);
          console.log(`✓ Profile '${resolved}' updated`);
          if (options.model) console.log(`  model: ${options.model}`);
          if (options.cli) console.log(`  cli: ${options.cli}`);
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
          const profilePath = expandHome(p.path);
          const env: Record<string, string> = {};
          if (!p.is_source) {
            env.CLAUDE_CONFIG_DIR = profilePath;
          }
          console.log(`Launching auth for profile '${resolved}'...`);
          const result = spawnSync(p.cli, ['auth', 'login'], {
            stdio: 'inherit',
            env: { ...process.env, ...env },
          });
          if (result.error) {
            throw new Error(`Failed to launch ${p.cli}: ${result.error.message}`);
          }
          const hasAuth = existsSync(join(profilePath, '.credentials.json'));
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
          const authFiles = ['.credentials.json', '.claude.json', 'policy-limits.json', 'mcp-needs-auth-cache.json', 'remote-settings.json'];

          for (const [name, profile] of Object.entries(config.profiles)) {
            const pPath = expandHome(profile.path);
            const tag = profile.is_source ? ' (source)' : '';
            console.log(`${name}${tag}:`);
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
  commands="init run status profile rebuild doctor auth completions"

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
  commands=(init run status profile rebuild doctor auth completions)
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
      console.log(`complete -c aimux -n '__fish_use_subcommand' -a 'init run status profile rebuild doctor auth completions'
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
