#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { Command } from 'commander';
import { getContext } from './context.js';
import { doctor } from './doctor.js';
import { updateInstall, uninstallAll, listInstall, serviceStatus } from './lifecycle.js';
import { installService, stopService, uninstallService } from './service-installer.js';
import { verify } from './verify.js';

function parseYesArgs(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--components=')) opts['components'] = arg.split('=')[1];
    if (arg.startsWith('--mcp-clients=')) opts['mcpClients'] = arg.split('=')[1];
    if (arg.startsWith('--patch-files=')) opts['patchFiles'] = arg.split('=')[1];
    if (arg.startsWith('--skill-roots=')) opts['skillRoots'] = arg.split('=')[1];
    if (arg === '--local') opts['local'] = 'true';
    if (arg === '--recover') opts['recover'] = 'true';
    if (arg === '--yes' || arg === '-y') opts['yes'] = 'true';
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
  .option('--purge', 'Also remove settings and data (.env, orcy.db, credentials)')
  .action(async (opts) => {
    const ctx = getContext();
    if (!opts.yes) {
      const { confirm } = await import('@clack/prompts');
      const confirmed = await confirm({ message: 'Remove all orcy components?' });
      if (!confirmed) { console.log('Aborted'); return; }
    }
    await uninstallAll(ctx, { purge: opts.purge ?? false, yes: opts.yes ?? false });
  });

program.command('list')
  .description('Show installed components and files')
  .action(() => { listInstall(getContext()); });

program.command('verify')
  .description('Audit installation consistency')
  .action(() => {
    const r = verify(getContext());
    process.exitCode = r.ok ? 0 : 1;
  });

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

const KNOWN_COMMANDS = new Set(['doctor', 'update', 'uninstall', 'list', 'service', 'help', 'verify']);

const BUILTIN_FLAGS = new Set(['--help', '-h', '--version', '-V']);
const WIZARD_FLAG_PREFIXES = ['--components=', '--mcp-clients=', '--patch-files=', '--skill-roots='];
const WIZARD_FLAG_EXACT = new Set(['--local', '--yes', '-y', '--recover']);

export type Action =
  | { kind: 'interactive-wizard' }
  | { kind: 'noninteractive-wizard'; opts: Record<string, string> }
  | { kind: 'command' }
  | { kind: 'error'; message: string };

/** Determine the CLI dispatch action from raw argv (pure, testable without spawning). */
export function resolveAction(rawArgs: string[]): Action {
  if (!rawArgs.length) return { kind: 'interactive-wizard' };

  const first = rawArgs[0];

  if (KNOWN_COMMANDS.has(first)) return { kind: 'command' };
  if (BUILTIN_FLAGS.has(first)) return { kind: 'command' };
  if (isWizardArg(first)) return { kind: 'noninteractive-wizard', opts: parseYesArgs(rawArgs) };

  return {
    kind: 'error',
    message: `Unknown command or flag: ${first}\nRun 'orcy-install --help' for usage.`,
  };
}

function isWizardArg(arg: string): boolean {
  return WIZARD_FLAG_EXACT.has(arg) || WIZARD_FLAG_PREFIXES.some(p => arg.startsWith(p));
}

async function main() {
  const action = resolveAction(process.argv.slice(2));

  switch (action.kind) {
    case 'interactive-wizard': {
      const { wizard } = await import('./wizard.js');
      await wizard({ interactive: true });
      return;
    }
    case 'noninteractive-wizard': {
      const { wizard } = await import('./wizard.js');
      const opts = action.opts;
      await wizard({
        components: opts['components'] ? opts['components'].split(',') : ['cli', 'api', 'mcp'],
        mcpClients: opts['mcpClients'] ? opts['mcpClients'].split(',') : [],
        patchFiles: opts['patchFiles'] ? opts['patchFiles'].split(',') : [],
        skillRoots: opts['skillRoots'] ? opts['skillRoots'].split(',') : [],
        local: opts['local'] === 'true',
        interactive: false,
        recover: opts['recover'] === 'true',
      });
      return;
    }
    case 'command': {
      program.parse(process.argv);
      return;
    }
    case 'error': {
      console.error(action.message);
      process.exit(1);
    }
  }
}

main().catch(console.error);
