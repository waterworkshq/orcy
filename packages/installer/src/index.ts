#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { Command } from 'commander';
import { getContext } from './context.js';
import { doctor } from './doctor.js';
import { updateInstall, uninstallAll, listInstall, serviceStatus } from './lifecycle.js';
import { installService, stopService, uninstallService } from './service-installer.js';

function parseYesArgs(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--components=')) opts['components'] = arg.split('=')[1];
    if (arg.startsWith('--mcp-clients=')) opts['mcpClients'] = arg.split('=')[1];
    if (arg.startsWith('--patch-files=')) opts['patchFiles'] = arg.split('=')[1];
    if (arg.startsWith('--skill-roots=')) opts['skillRoots'] = arg.split('=')[1];
    if (arg === '--local') opts['local'] = 'true';
  }
  return opts;
}

const program = new Command();
program
  .name('orcy-install')
  .description('Install and configure orcy on your machine')
  .version('1.0.0');

program.command('doctor')
  .description('Verify installation health')
  .action(async () => { await doctor(); });

program.command('update')
  .description('Update to the latest version')
  .action(async () => {
    const ctx = getContext();
    await updateInstall(ctx);
  });

program.command('uninstall')
  .description('Remove all installed components')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (opts) => {
    const ctx = getContext();
    if (!opts.yes) {
      const { confirm } = await import('@clack/prompts');
      const confirmed = await confirm({ message: 'Remove all orcy components?' });
      if (!confirmed) { console.log('Aborted'); return; }
    }
    await uninstallAll(ctx);
  });

program.command('list')
  .description('Show installed components and files')
  .action(() => { listInstall(getContext()); });

const service = program.command('service')
  .description('Manage the API systemd/launchd service');

function getDefaultServiceAction(platform: string) {
  if (platform === 'linux') return () => {
    execSync('systemctl --user start orcy-api', { stdio: 'inherit' });
  };
  if (platform === 'darwin') return () => {
    execSync('launchctl kickstart -k gui/$(/usr/bin/id -u)/ai.orcy.api', { stdio: 'inherit' });
  };
  return () => { console.log('Service management not available on this platform'); };
}

service.command('install')
  .description('Install and enable the service')
  .action(() => {
    const ctx = getContext();
    installService(ctx);
  });

service.command('start')
  .description('Start the service')
  .action(() => { getDefaultServiceAction(getContext().platform)(); });

service.command('stop')
  .description('Stop the service')
  .action(() => {
    const ctx = getContext();
    stopService(ctx);
  });

service.command('status')
  .description('Check if the service is running')
  .action(() => { serviceStatus(getContext()); });

service.command('uninstall')
  .description('Remove the service')
  .action(() => {
    const ctx = getContext();
    uninstallService(ctx);
    console.log('Service removed.');
  });

const KNOWN_COMMANDS = new Set(['doctor', 'update', 'uninstall', 'list', 'service', 'help']);

async function main() {
  const rawArgs = process.argv.slice(2);

  // No arguments: run interactive wizard
  if (!rawArgs.length) {
    const { wizard } = await import('./wizard.js');
    await wizard({ interactive: true });
    return;
  }

  const first = rawArgs[0];

  // Known subcommand: let commander handle it
  if (KNOWN_COMMANDS.has(first)) {
    program.parse(process.argv);
    return;
  }

  // Commander built-in flags
  if (first === '--help' || first === '-h' || first === '--version' || first === '-V') {
    program.parse(process.argv);
    return;
  }

  // Non-interactive wizard mode (--yes, --components=...)
  const { wizard } = await import('./wizard.js');
  const opts = parseYesArgs(rawArgs);
  await wizard({
    components: opts['components'] ? opts['components'].split(',') : ['cli', 'api', 'mcp'],
    mcpClients: opts['mcpClients'] ? opts['mcpClients'].split(',') : [],
    patchFiles: opts['patchFiles'] ? opts['patchFiles'].split(',') : [],
    skillRoots: opts['skillRoots'] ? opts['skillRoots'].split(',') : [],
    local: opts['local'] === 'true',
    interactive: false,
  });
}

main().catch(console.error);
