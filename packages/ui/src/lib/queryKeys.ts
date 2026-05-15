export const queryKeys = {
  boards: {
    all: ['boards'] as const,
    list: () => [...queryKeys.boards.all, 'list'] as const,
    detail: (boardId: string) => [...queryKeys.boards.all, 'detail', boardId] as const,
    stats: (boardId: string) => [...queryKeys.boards.all, 'stats', boardId] as const,
    events: (boardId: string) => [...queryKeys.boards.all, 'events', boardId] as const,
    predictions: (boardId: string) => [...queryKeys.boards.all, 'predictions', boardId] as const,
    burndown: (boardId: string) => [...queryKeys.boards.all, 'burndown', boardId] as const,
    anomalies: (boardId: string) => [...queryKeys.boards.all, 'anomalies', boardId] as const,
    capacity: (boardId: string) => [...queryKeys.boards.all, 'capacity', boardId] as const,
    metrics: (boardId: string) => [...queryKeys.boards.all, 'metrics', boardId] as const,
    tasks: (boardId: string, filters?: { status?: string; priority?: string; search?: string; assignedAgentId?: string; isArchived?: boolean; limit?: number; offset?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }) => [...queryKeys.boards.all, 'tasks', boardId, filters] as const,
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
    stats: (agentId: string) => [...queryKeys.agents.all, 'stats', agentId] as const,
    listWithTasks: () => [...queryKeys.agents.all, 'listWithTasks'] as const,
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
    all: ['comments'] as const,
    list: (taskId: string) => [...queryKeys.comments.all, 'list', taskId] as const,
  },
  attachments: {
    all: ['attachments'] as const,
    list: (taskId: string) => [...queryKeys.attachments.all, 'list', taskId] as const,
  },
  pulse: {
    all: ['pulses'] as const,
    byMission: (missionId: string) => [...queryKeys.pulse.all, missionId] as const,
    byBoard: (boardId: string) => [...queryKeys.pulse.all, 'byBoard', boardId] as const,
    replies: (pulseId: string) => [...queryKeys.pulse.all, 'replies', pulseId] as const,
  },
  insights: {
    all: ['insights'] as const,
    byBoard: (boardId: string) => [...queryKeys.insights.all, boardId] as const,
  },
  organizations: {
    all: ['organizations'] as const,
    list: () => [...queryKeys.organizations.all, 'list'] as const,
    teams: (orgId: string) => [...queryKeys.organizations.all, 'teams', orgId] as const,
    members: (teamId: string) => [...queryKeys.organizations.all, 'members', teamId] as const,
  },
  savedFilters: {
    all: ['savedFilters'] as const,
    list: (boardId: string) => [...queryKeys.savedFilters.all, boardId] as const,
  },
  health: {
    all: ['health'] as const,
    current: (boardId: string) => [...queryKeys.health.all, boardId] as const,
    history: (boardId: string) => [...queryKeys.health.all, 'history', boardId] as const,
  },
  audit: {
    all: ['audit'] as const,
    summary: (boardId: string) => [...queryKeys.audit.all, 'summary', boardId] as const,
  },
  featureComments: {
    all: ['featureComments'] as const,
    list: (featureId: string) => [...queryKeys.featureComments.all, featureId] as const,
  },
  user: {
    all: ['user'] as const,
    profile: () => [...queryKeys.user.all, 'profile'] as const,
  },
  scheduledTasks: {
    all: ['scheduledTasks'] as const,
    list: (boardId: string) => [...queryKeys.scheduledTasks.all, boardId] as const,
    detail: (id: string) => [...queryKeys.scheduledTasks.all, 'detail', id] as const,
  },
  templates: {
    all: ['templates'] as const,
    list: (boardId: string) => [...queryKeys.templates.all, boardId] as const,
  },
  chatIntegrations: {
    all: ['chatIntegrations'] as const,
    list: (boardId: string) => [...queryKeys.chatIntegrations.all, boardId] as const,
  },
  notificationPrefs: {
    all: ['notificationPrefs'] as const,
    board: (boardId: string) => [...queryKeys.notificationPrefs.all, boardId] as const,
  },
};
