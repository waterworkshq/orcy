import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(__dirname, '..', '..', 'drizzle', '0000_schema.sql'), 'utf-8');
const statements = schemaSql
  .split('--> statement-breakpoint')
  .map(s => s.trim())
  .filter(s => s.length > 0);

const createTables = statements.filter(s => s.toUpperCase().startsWith('CREATE TABLE'));
const tableNames = createTables
  .map(s => s.match(/CREATE TABLE [`"]?(\w+)[`"]?/i)?.[1])
  .filter(Boolean) as string[];

const createIndexes = statements.filter(s => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s));

describe('Unified schema (0000_schema.sql)', () => {
  it('contains exactly 33 tables', () => {
    expect(createTables.length).toBe(33);
  });

  it('has all core tables', () => {
    const core = ['users', 'boards', 'columns', 'features', 'tasks', 'agents'];
    for (const name of core) {
      expect(tableNames).toContain(name);
    }
  });

  it('has feature-related tables', () => {
    const feat = ['feature_dependencies', 'feature_events', 'feature_watchers', 'feature_templates'];
    for (const name of feat) {
      expect(tableNames).toContain(name);
    }
  });

  it('has quality and time tables', () => {
    const ql = ['quality_checklist_templates', 'quality_checklist_items',
                 'task_quality_checklists', 'task_quality_checklist_items',
                 'task_time_records'];
    for (const name of ql) {
      expect(tableNames).toContain(name);
    }
  });

  it('has feature_templates, NOT task_templates', () => {
    expect(tableNames).toContain('feature_templates');
    expect(tableNames).not.toContain('task_templates');
  });

  it('tasks table has feature_id, not legacy columns', () => {
    const tasksCreate = createTables.find(s => s.includes('`tasks`'))!;
    expect(tasksCreate).toBeDefined();
    expect(tasksCreate).toContain('`feature_id`');
    expect(tasksCreate).toContain('`order`');
    expect(tasksCreate).toContain('`actual_minutes`');
    expect(tasksCreate).toContain('`cycle_time_minutes`');
    expect(tasksCreate).not.toContain('`board_id`');
    expect(tasksCreate).not.toContain('`column_id`');
    expect(tasksCreate).not.toContain('`display_order`');
    expect(tasksCreate).not.toContain('`labels`');
    expect(tasksCreate).not.toContain('`depends_on`');
    expect(tasksCreate).not.toContain('`blocks`');
  });

  it('features table has archive and time columns', () => {
    const featuresCreate = createTables.find(s => s.includes('`features`'))!;
    expect(featuresCreate).toContain('`is_archived`');
    expect(featuresCreate).toContain('`actual_minutes`');
    expect(featuresCreate).toContain('`planned_minutes`');
    expect(featuresCreate).toContain('`planning_accuracy`');
    expect(featuresCreate).toContain('`completed_at`');
    expect(featuresCreate).toContain('`acceptance_criteria`');
  });

  it('feature_templates has tasks_template column', () => {
    const tmplCreate = createTables.find(s => s.includes('`feature_templates`'))!;
    expect(tmplCreate).toContain('`tasks_template`');
  });

  it('has no migration SQL (ALTER, INSERT, UPDATE, DROP, RENAME) as standalone statements', () => {
    for (const stmt of statements) {
      const upper = stmt.trim().toUpperCase();
      // Only flag statements that START with these keywords
      const isMigrationStatement =
        upper.startsWith('ALTER TABLE') ||
        upper.startsWith('INSERT INTO') ||
        upper.startsWith('UPDATE ') ||
        upper.startsWith('DROP TABLE') ||
        upper.startsWith('DROP INDEX') ||
        upper.startsWith('RENAME TO');
      expect(isMigrationStatement).toBe(false);
    }
  });

  it('has 72 indexes including unique indexes', () => {
    expect(createIndexes.length).toBe(72);
  });

  it('features table created before tasks (FK ordering)', () => {
    const featIdx = tableNames.indexOf('features');
    const taskIdx = tableNames.indexOf('tasks');
    expect(featIdx).toBeLessThan(taskIdx);
  });

  it('users table created before boards (FK ordering)', () => {
    const usersIdx = tableNames.indexOf('users');
    const boardsIdx = tableNames.indexOf('boards');
    expect(usersIdx).toBeLessThan(boardsIdx);
  });
});
