#!/usr/bin/env node
import { Command } from 'commander';
import { render } from 'ink';
import { StatusView } from './components/StatusView.js';
import type { AimuxConfig } from './types/index.js';
import { loadConfig } from './core/index.js';

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
  .action(() => {
    console.log('aimux init — coming soon (aimux-g2w)');
  });

program
  .command('run [profile]')
  .description('Launch AI CLI with the specified profile')
  .option('-m, --model <model>', 'Override default model')
  .action((profile: string | undefined, options: { model?: string }) => {
    console.log(`aimux run — coming soon (aimux-viq) [profile=${profile}, model=${options.model}]`);
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
      .action((name: string, _options: { auth: boolean; model?: string }) => {
        console.log(`aimux profile add — coming soon (aimux-9yg) [name=${name}]`);
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
      .description('Remove a profile')
      .action((name: string) => {
        console.log(`aimux profile remove — coming soon (aimux-9yg) [name=${name}]`);
      })
  );

program
  .command('rebuild')
  .description('Rebuild symlinks for all profiles')
  .argument('[profile]', 'Specific profile to rebuild')
  .action((profile?: string) => {
    console.log(`aimux rebuild — coming soon (aimux-0g6) [profile=${profile ?? 'all'}]`);
  });

program
  .command('doctor')
  .description('Health check — find broken symlinks, missing credentials, conflicts')
  .action(() => {
    console.log('aimux doctor — coming soon (aimux-q9n)');
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
