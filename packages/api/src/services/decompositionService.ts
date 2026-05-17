import { getLLMConfig, callLLM, LLMMessage } from '../lib/llm.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import { badRequest, notFound, serviceUnavailable } from '../errors.js';

export interface TaskProposal {
  id: string;
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  order: number;
  estimatedMinutes?: number;
}

export interface DecompositionResult {
  proposals: TaskProposal[];
  parentMission: { id: string; title: string };
}

const SYSTEM_PROMPT = `You are a mission decomposition assistant. Your job is to break down missions into smaller, actionable tasks that agents can execute independently.

Rules:
- Generate 3-8 tasks
- Each task should be completable in 1-4 hours
- Use verb-noun format for titles (e.g., "Implement authentication middleware", "Write unit tests for API endpoints")
- Do NOT add requirements not in the original mission
- Each task title should be clear and actionable
- Tasks should be ordered logically (dependencies first)
- Assign estimated minutes for each task
- Consider the acceptance criteria when generating tasks

Output ONLY valid JSON in this exact format:
{
  "tasks": [
    { "title": "Task title here", "description": "Optional description", "priority": "medium", "estimatedMinutes": 120 }
  ]
}

priority must be one of: low, medium, high, critical`;

function buildUserMessage(missionTitle: string, missionDescription: string, acceptanceCriteria: string): string {
  let message = `Break down this feature into tasks:\n\nTitle: ${missionTitle}\n\nDescription: ${missionDescription || '(no description)'}`;

  if (acceptanceCriteria) {
    message += `\n\nAcceptance Criteria:\n${acceptanceCriteria}`;
  }

  if (missionDescription.length < 20) {
    message += '\n\nNote: The description is very short, so results may be limited.';
  }

  return message;
}

export async function decomposeMission(missionId: string): Promise<DecompositionResult> {
  const config = getLLMConfig();
  if (!config) {
    throw serviceUnavailable('AI decomposition not configured. Set LLM_API_KEY environment variable.');
  }

  const mission = missionRepo.getMissionById(missionId);
  if (!mission) {
    throw notFound('Mission not found');
  }

  if (!mission.description || mission.description.trim().length === 0) {
    throw badRequest('Add a description before decomposing');
  }

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(mission.title, mission.description, mission.acceptanceCriteria) },
  ];

  const llmResponse = await callLLM(messages, config);

  const result: DecompositionResult = { proposals: [], parentMission: { id: mission.id, title: mission.title } };

  try {
    const text = llmResponse.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw badRequest('Could not understand AI response. Try again.');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const taskList = parsed.tasks || [];

    if (!Array.isArray(taskList) || taskList.length === 0) {
      throw badRequest('AI did not return any tasks. Try again with a more detailed description.');
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];

    result.proposals = taskList.slice(0, 20).map((task: any, index: number) => ({
      id: `prop-${Date.now()}-${index}`,
      title: task.title || 'Untitled task',
      description: task.description,
      priority: validPriorities.includes(task.priority) ? task.priority : 'medium',
      order: index,
      estimatedMinutes: task.estimatedMinutes || null,
    }));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw badRequest('Could not understand AI response. Try again.');
    }
    throw error;
  }

  return result;
}

export async function decomposeTask(taskId: string): Promise<DecompositionResult> {
  const config = getLLMConfig();
  if (!config) {
    throw serviceUnavailable('AI decomposition not configured. Set LLM_API_KEY environment variable.');
  }

  const task = taskRepo.getTaskById(taskId);
  if (!task) {
    throw notFound('Task not found');
  }

  if (!task.description || task.description.trim().length === 0) {
    throw badRequest('Add a description before decomposing');
  }

  const messages: LLMMessage[] = [
    { role: 'system', content: `You are a task decomposition assistant. Break down tasks into subtasks. Output JSON with a "tasks" array containing {title, description, priority, estimatedMinutes}.` },
    { role: 'user', content: `Break down this task:\n\nTitle: ${task.title}\n\nDescription: ${task.description}` },
  ];

  const llmResponse = await callLLM(messages, config);
  const result: DecompositionResult = { proposals: [], parentMission: { id: task.missionId, title: task.title } };

  try {
    const text = llmResponse.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw badRequest('Could not understand AI response.');
    const parsed = JSON.parse(jsonMatch[0]);
    const taskList = parsed.tasks || [];
    const validPriorities = ['low', 'medium', 'high', 'critical'];
    result.proposals = taskList.slice(0, 20).map((t: any, index: number) => ({
      id: `prop-${Date.now()}-${index}`,
      title: t.title || 'Untitled',
      description: t.description,
      priority: validPriorities.includes(t.priority) ? t.priority : 'medium',
      order: index,
      estimatedMinutes: t.estimatedMinutes || null,
    }));
  } catch (error) {
    if (error instanceof SyntaxError) throw badRequest('Could not understand AI response.');
    throw error;
  }

  return result;
}
