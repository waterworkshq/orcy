#!/usr/bin/env node
import { Command } from 'commander';
import { registerHabitatCommands } from './commands/habitat.js';
import { registerMissionCommands } from './commands/mission.js';
import { registerTaskCommands } from './commands/task.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerMessageCommands } from './commands/message.js';
import { registerPulseCommands } from './commands/pulse.js';
import { registerAdminCommands } from './commands/admin.js';
import { registerSuggestCommands } from './commands/suggest.js';
import { registerSubscriptionCommands } from './commands/subscription.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { registerServeCommands } from './commands/serve.js';

const program = new Command();

program
  .name('orcy')
  .description('Orcy — orchestrate your AI fleet')
  .version('1.0.0');

registerHabitatCommands(program);
registerMissionCommands(program);
registerTaskCommands(program);
registerAgentCommands(program);
registerMessageCommands(program);
registerPulseCommands(program);
registerAdminCommands(program);
registerSuggestCommands(program);
registerSubscriptionCommands(program);
registerWorktreeCommands(program);
registerServeCommands(program);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
