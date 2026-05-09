import { describe, it, expect, vi } from 'vitest';
import {
  createDispatchTool,
  createDispatchHandler,
  type Handler,
  type DispatchToolConfig,
} from '../../tools/dispatch-utils.js';
import { createMockClient } from '../__fixtures__/mock-client.js';

describe('createDispatchTool', () => {
  it('produces a Tool with the correct name and description', () => {
    const config: DispatchToolConfig = {
      name: 'board_task',
      description: 'Task operations',
      actions: ['claim', 'submit'],
    };

    const tool = createDispatchTool(config);

    expect(tool.name).toBe('board_task');
    expect(tool.description).toBe('Task operations');
  });

  it('produces a Tool with an action enum in inputSchema', () => {
    const config: DispatchToolConfig = {
      name: 'board_task',
      description: 'Task operations',
      actions: ['claim', 'submit', 'complete'],
    };

    const tool = createDispatchTool(config);

    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.properties).toBeDefined();
    expect(tool.inputSchema.properties.action).toEqual({
      type: 'string',
      enum: ['claim', 'submit', 'complete'],
      description: 'The operation to perform',
    });
    expect(tool.inputSchema.required).toEqual(['action']);
  });

  it('includes shared params when provided', () => {
    const config: DispatchToolConfig = {
      name: 'board_task',
      description: 'Task operations',
      actions: ['claim', 'submit'],
      sharedParams: {
        taskId: { type: 'string', description: 'Task UUID' },
        boardId: { type: 'string', description: 'Board UUID' },
      },
    };

    const tool = createDispatchTool(config);

    expect(tool.inputSchema.properties.taskId).toEqual({
      type: 'string',
      description: 'Task UUID',
    });
    expect(tool.inputSchema.properties.boardId).toEqual({
      type: 'string',
      description: 'Board UUID',
    });
  });

  it('has no shared params when none are provided', () => {
    const config: DispatchToolConfig = {
      name: 'board_suggest',
      description: 'Suggest next task',
      actions: ['suggest-next-task'],
    };

    const tool = createDispatchTool(config);

    expect(Object.keys(tool.inputSchema.properties)).toEqual(['action']);
  });

  it('requires action when no shared params', () => {
    const config: DispatchToolConfig = {
      name: 'board_suggest',
      description: 'Suggest next task',
      actions: ['suggest-next-task'],
    };

    const tool = createDispatchTool(config);

    expect(tool.inputSchema.required).toEqual(['action']);
  });
});

describe('createDispatchHandler', () => {
  it('routes known actions to the correct handler', async () => {
    const client = createMockClient();
    const claimHandler = vi.fn().mockResolvedValue({ success: true });
    const submitHandler = vi.fn().mockResolvedValue({ success: true });

    const actions: Record<string, Handler> = {
      claim: claimHandler,
      submit: submitHandler,
    };

    const handler = createDispatchHandler(actions);

    await handler(client, { action: 'claim', taskId: 'task-1' });

    expect(claimHandler).toHaveBeenCalledTimes(1);
    expect(submitHandler).not.toHaveBeenCalled();
  });

  it('passes args through to the handler', async () => {
    const client = createMockClient();
    const mockHandler = vi.fn().mockResolvedValue({ success: true });

    const actions: Record<string, Handler> = {
      claim: mockHandler,
    };

    const handler = createDispatchHandler(actions);

    const args = { action: 'claim', taskId: 'task-1', boardId: 'board-1' };
    await handler(client, args);

    expect(mockHandler).toHaveBeenCalledWith(client, args);
  });

  it('returns formatted result via formatResult pattern', async () => {
    const client = createMockClient();
    const resultData = { id: 'task-1', status: 'done' };
    const mockHandler = vi.fn().mockResolvedValue(resultData);

    const actions: Record<string, Handler> = {
      claim: mockHandler,
    };

    const handler = createDispatchHandler(actions);
    const result = await handler(client, { action: 'claim' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(resultData);
  });

  it('throws descriptive error for unknown actions', () => {
    const client = createMockClient();
    const actions: Record<string, Handler> = {
      claim: vi.fn(),
    };

    const handler = createDispatchHandler(actions);

    expect(() =>
      handler(client, { action: 'nonexistent' })
    ).toThrow('Unknown action: nonexistent');
  });

  it('routes to the right handler when multiple actions exist', async () => {
    const client = createMockClient();
    const claimHandler = vi.fn().mockResolvedValue({ action: 'claim' });
    const submitHandler = vi.fn().mockResolvedValue({ action: 'submit' });
    const completeHandler = vi.fn().mockResolvedValue({ action: 'complete' });

    const actions: Record<string, Handler> = {
      claim: claimHandler,
      submit: submitHandler,
      complete: completeHandler,
    };

    const handler = createDispatchHandler(actions);

    const submitResult = await handler(client, { action: 'submit' });
    expect(JSON.parse(submitResult.content[0].text)).toEqual({ action: 'submit' });
    expect(claimHandler).not.toHaveBeenCalled();
    expect(submitHandler).toHaveBeenCalledTimes(1);
    expect(completeHandler).not.toHaveBeenCalled();
  });
});
