import { initDb, getDb } from '../packages/api/src/db/index.js';
import { createBoard } from '../packages/api/src/services/boardService.js';
import { createTask } from '../packages/api/src/services/taskService.js';
import { createAgent } from '../packages/api/src/services/agentService.js';

async function seed() {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error('ERROR: DB_PATH must be set to prevent accidental production DB overwrite.');
    console.error('Usage: DB_PATH=/path/to/test.db tsx scripts/seed.ts');
    process.exit(1);
  }
  await initDb(dbPath);
  getDb();

  const { board, columns } = createBoard({
    name: 'Sprint 24',
    description: 'Q2 2026 Sprint - Agent Kanban development',
    defaultColumns: true,
  });

  console.log(`Created board: ${board.name} (${board.id})`);
  console.log(`Created ${columns.length} columns:`);
  columns.forEach(c => console.log(`  - ${c.name} (${c.id})`));

  const todoColumn = columns.find(c => c.name === 'Todo')!;
  const inProgressColumn = columns.find(c => c.name === 'In Progress')!;

  const tasks = [
    {
      title: 'Set up project monorepo structure',
      description: 'Initialize pnpm workspaces with api, ui, and mcp packages. Configure TypeScript, ESLint, and build tooling.',
      priority: 'high' as const,
      labels: ['setup', 'devops'],
      requiredDomain: 'devops',
    },
    {
      title: 'Implement task state machine',
      description: 'Build the core task lifecycle state machine with all transitions: pending→claimed→in_progress→submitted→approved→done. Include rejection handling.',
      priority: 'critical' as const,
      labels: ['backend', 'core'],
      requiredDomain: 'backend',
    },
    {
      title: 'Build atomic task claiming with SQLite',
      description: 'Implement transaction-based atomic claiming using BEGIN IMMEDIATE + SELECT FOR UPDATE. Ensure zero double-claims under concurrent load.',
      priority: 'critical' as const,
      labels: ['backend', 'database'],
      requiredDomain: 'backend',
    },
    {
      title: 'Create MCP server with all 6 tools',
      description: 'Build the MCP stdio server with board_list_tasks, board_claim_task, board_update_task_status, board_submit_task, board_get_task_context, board_release_task, and board_heartbeat tools.',
      priority: 'high' as const,
      labels: ['backend', 'mcp'],
      requiredDomain: 'backend',
    },
    {
      title: 'Design database schema for all entities',
      description: 'Design SQLite schema for boards, columns, tasks, agents, task_events, and task_dependencies. Include all indexes and foreign keys.',
      priority: 'high' as const,
      labels: ['backend', 'database'],
      requiredDomain: 'backend',
    },
    {
      title: 'Implement SSE real-time board updates',
      description: 'Add Server-Sent Events endpoint for real-time board updates. Publish task.created, task.moved, task.claimed, task.updated events.',
      priority: 'medium' as const,
      labels: ['backend', 'frontend'],
      requiredDomain: 'frontend',
    },
    {
      title: 'Build React kanban board UI',
      description: 'Create the React kanban board with drag-and-drop using dnd-kit. Columns, task cards, task detail panel, and agent status indicators.',
      priority: 'high' as const,
      labels: ['frontend', 'ui'],
      requiredDomain: 'frontend',
    },
    {
      title: 'Write Phase 1 unit tests',
      description: 'Write vitest unit tests for: state machine transitions, atomic claim race conditions, invalid transition rejection, event audit logging.',
      priority: 'medium' as const,
      labels: ['testing', 'backend'],
      requiredDomain: 'backend',
    },
    {
      title: 'Create agent skill template (SKILL.md)',
      description: 'Write the SKILL.md template for Claude Code / Codex / OpenCode agents. Include startup sequence, task claiming rules, MCP tool usage examples.',
      priority: 'low' as const,
      labels: ['docs'],
      requiredDomain: null,
    },
  ];

  const createdTasks: Array<{ id: string; title: string }> = [];
  for (const taskInput of tasks) {
    const task = createTask({
      boardId: board.id,
      columnId: todoColumn.id,
      ...taskInput,
      createdBy: 'system',
    });
    createdTasks.push({ id: task.id, title: task.title });
    console.log(`Created task: ${task.title} (${task.priority})`);
  }

  createTask({
    boardId: board.id,
    columnId: inProgressColumn.id,
    title: 'Implement stale task detection background job',
    description: 'Build background job that runs every 60 seconds to detect and release tasks that have been idle for more than 30 minutes.',
    priority: 'high',
    labels: ['backend', 'core'],
    requiredDomain: 'backend',
    createdBy: 'system',
  });

  const { agent: agent1, plainApiKey: key1 } = createAgent({
    name: 'claude-dev',
    type: 'claude-code',
    domain: 'backend',
    capabilities: ['typescript', 'nodejs', 'react', 'sql'],
  });

  const { agent: agent2, plainApiKey: key2 } = createAgent({
    name: 'codex-dev',
    type: 'codex',
    domain: 'frontend',
    capabilities: ['typescript', 'react', 'css', 'html'],
  });

  console.log('\nAgents created:');
  console.log(`  ${agent1.name} (${agent1.type}) - domain: ${agent1.domain}`);
  console.log(`  ${agent2.name} (${agent2.type}) - domain: ${agent2.domain}`);

  console.log('\nAPI Keys (save these - shown only once):');
  console.log(`  ${agent1.name}: ${key1}`);
  console.log(`  ${agent2.name}: ${key2}`);

  console.log('\nSeed complete!');
  console.log(`Board ID: ${board.id}`);
  console.log(`API running at: http://127.0.0.1:${process.env.PORT ?? '3000'}`);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});