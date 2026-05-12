export const queryKeys = {
  boards: {
    all: ['boards'] as const,
    list: () => [...queryKeys.boards.all, 'list'] as const,
    detail: (boardId: string) => [...queryKeys.boards.all, 'detail', boardId] as const,
    stats: (boardId: string) => [...queryKeys.boards.all, 'stats', boardId] as const,
    events: (boardId: string) => [...queryKeys.boards.all, 'events', boardId] as const,
  },
  features: {
    all: ['features'] as const,
    list: (boardId: string) => [...queryKeys.features.all, 'list', boardId] as const,
    detail: (featureId: string) => [...queryKeys.features.all, 'detail', featureId] as const,
    details: (featureId: string) => [...queryKeys.features.all, 'details', featureId] as const,
    tasks: (featureId: string) => [...queryKeys.features.all, 'tasks', featureId] as const,
    progress: (featureId: string) => [...queryKeys.features.all, 'progress', featureId] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    detail: (taskId: string) => [...queryKeys.tasks.all, 'detail', taskId] as const,
    details: (taskId: string) => [...queryKeys.tasks.all, 'details', taskId] as const,
    events: (taskId: string) => [...queryKeys.tasks.all, 'events', taskId] as const,
    watchers: (taskId: string) => [...queryKeys.tasks.all, 'watchers', taskId] as const,
    subtasks: (taskId: string) => [...queryKeys.tasks.all, 'subtasks', taskId] as const,
    pullRequests: (taskId: string) => [...queryKeys.tasks.all, 'pullRequests', taskId] as const,
    pipelineEvents: (taskId: string) => [...queryKeys.tasks.all, 'pipelineEvents', taskId] as const,
    comments: (taskId: string) => [...queryKeys.tasks.all, 'comments', taskId] as const,
    quality: (taskId: string) => [...queryKeys.tasks.all, 'quality', taskId] as const,
  },
  agents: {
    all: ['agents'] as const,
    list: () => [...queryKeys.agents.all, 'list'] as const,
    detail: (agentId: string) => [...queryKeys.agents.all, 'detail', agentId] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
    stats: () => [...queryKeys.dashboard.all, 'stats'] as const,
  },
  teams: {
    all: ['teams'] as const,
    list: () => [...queryKeys.teams.all, 'list'] as const,
    myTeams: () => [...queryKeys.teams.all, 'myTeams'] as const,
  },
  comments: {
    list: (taskId: string) => ['comments', 'list', taskId] as const,
  },
  attachments: {
    list: (taskId: string) => ['attachments', 'list', taskId] as const,
  },
  pulse: {
    all: ['pulses'] as const,
    byMission: (missionId: string) => ['pulses', missionId] as const,
    byBoard: (boardId: string) => ['habitatPulses', boardId] as const,
    replies: (pulseId: string) => ['pulseReplies', pulseId] as const,
  },
  insights: {
    all: ['insights'] as const,
    byBoard: (boardId: string) => ['insights', boardId] as const,
  },
};
