#!/usr/bin/env node
import { Command } from 'commander';
import { render } from 'ink';
import { StatusView } from './components/StatusView.js';
import type { AimuxConfig } from './types/index.js';
import { rmSync } from 'node:fs';
import {
  loadConfig, saveConfig, addProfile, removeProfile, expandHome,
  ensureProfileDir, initAutoDetect, initFromSource, detectClaudeDirs,
  syncProfile, syncAllProfiles, checkAllProfiles,
  launchProfile, getLastProfile, recordHistory,
} from './core/index.js';

function requireConfig(): AimuxConfig {
  const config = loadConfig();
  if (!config) {
    console.error('aimux not initialized. Run: aimux init');
    process.exit(1);
  }
  return config;
}

const program = new Command();

program
  .name('aimux')
  .description('Local AI workspace orchestrator — manage multiple AI CLI subscriptions')
  .version('0.1.0');

program
  .command('status')
  .description('Show overview of profiles and shared source')
  .action(() => {
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
  .command('run [profile]')
  .description('Launch AI CLI with the specified profile')
  .option('-m, --model <model>', 'Override default model')
  .action((profile: string | undefined, options: { model?: string }) => {
    try {
      const config = requireConfig();
      let profileName = profile;

      if (!profileName) {
        const cwd = process.cwd();
        const last = getLastProfile(cwd);
        if (last && config.profiles[last]) {
          console.log(`Using last profile for this directory: ${last}`);
          profileName = last;
        } else {
          const names = Object.keys(config.profiles);
          if (names.length === 1) {
            profileName = names[0];
          } else {
            console.log('Available profiles:');
            for (const [i, name] of names.entries()) {
              const p = config.profiles[name];
              const tag = p.is_source ? ' (source)' : '';
              const model = p.model ? ` [${p.model}]` : '';
              console.log(`  ${i + 1}. ${name}${model}${tag}`);
            }
            console.log(`\nUsage: aimux run <profile>`);
            process.exit(0);
          }
        }
      }

      if (!config.profiles[profileName]) {
        console.error(`Profile '${profileName}' not found`);
        process.exit(1);
      }

      recordHistory(process.cwd(), profileName);
      const exitCode = launchProfile(config, profileName, { model: options.model });
      process.exit(exitCode);
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
      .action(() => {
        render(<StatusView config={requireConfig()} />);
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
          const profile = config.profiles[name];
          if (!profile) {
            console.error(`Profile '${name}' not found`);
            process.exit(1);
          }
          const profilePath = profile.path;
          config = removeProfile(config, name);
          saveConfig(config);
          if (!options.keepDir) {
            const fullPath = expandHome(profilePath);
            rmSync(fullPath, { recursive: true, force: true });
            console.log(`✓ Profile '${name}' removed (directory deleted)`);
          } else {
            console.log(`✓ Profile '${name}' removed (directory kept)`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  );

program
  .command('rebuild')
  .description('Rebuild symlinks for all profiles')
  .argument('[profile]', 'Specific profile to rebuild')
  .action((profile?: string) => {
    try {
      const config = requireConfig();
      if (profile) {
        const result = syncProfile(config, profile);
        console.log(`Profile '${profile}':`);
        console.log(`  created: ${result.created.length}, skipped: ${result.skipped.length}, repaired: ${result.repaired.length}, private: ${result.private.length}`);
      } else {
        const results = syncAllProfiles(config);
        for (const [name, result] of results) {
          const src = config.profiles[name]?.is_source ? ' (source)' : '';
          console.log(`${name}${src}: created=${result.created.length} skipped=${result.skipped.length} repaired=${result.repaired.length}`);
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
  .description('Health check — find broken symlinks, missing credentials, conflicts')
  .action(() => {
    try {
      const config = requireConfig();
      const reports = checkAllProfiles(config);
      let healthy = true;

      for (const [name, report] of reports) {
        const src = config.profiles[name]?.is_source ? ' (source)' : '';
        const issues = report.broken.length + report.missing.length + report.orphaned.length;

        if (issues === 0) {
          console.log(`✓ ${name}${src}: ${report.valid.length} valid`);
        } else {
          healthy = false;
          console.log(`✗ ${name}${src}:`);
          if (report.broken.length > 0) console.log(`    broken: ${report.broken.join(', ')}`);
          if (report.missing.length > 0) console.log(`    missing: ${report.missing.join(', ')}`);
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
        console.log(`aimux auth login — coming soon (aimux-205) [profile=${profile}]`);
      })
  )
  .addCommand(
    new Command('status')
      .description('Show auth status for all profiles')
      .action(() => {
        console.log('aimux auth status — coming soon (aimux-205)');
      })
  );

program.parse();
