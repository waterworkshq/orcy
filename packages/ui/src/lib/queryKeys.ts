export const queryKeys = {
  habitats: {
    all: ["habitats"] as const,
    list: () => [...queryKeys.habitats.all, "list"] as const,
    detail: (habitatId: string) => [...queryKeys.habitats.all, "detail", habitatId] as const,
    stats: (habitatId: string) => [...queryKeys.habitats.all, "stats", habitatId] as const,
    events: (habitatId: string) => [...queryKeys.habitats.all, "events", habitatId] as const,
    predictions: (habitatId: string) =>
      [...queryKeys.habitats.all, "predictions", habitatId] as const,
    burndown: (habitatId: string) => [...queryKeys.habitats.all, "burndown", habitatId] as const,
    cumulativeFlow: (habitatId: string) =>
      [...queryKeys.habitats.all, "cumulativeFlow", habitatId] as const,
    bottlenecks: (habitatId: string) =>
      [...queryKeys.habitats.all, "bottlenecks", habitatId] as const,
    agentQuality: (habitatId: string) =>
      [...queryKeys.habitats.all, "agentQuality", habitatId] as const,
    anomalies: (habitatId: string) => [...queryKeys.habitats.all, "anomalies", habitatId] as const,
    capacity: (habitatId: string) => [...queryKeys.habitats.all, "capacity", habitatId] as const,
    metrics: (habitatId: string) => [...queryKeys.habitats.all, "metrics", habitatId] as const,
    tasks: (
      habitatId: string,
      filters?: {
        status?: string;
        priority?: string;
        search?: string;
        assignedAgentId?: string;
        isArchived?: boolean;
        limit?: number;
        offset?: number;
        sortBy?: string;
        sortDir?: "asc" | "desc";
      },
    ) => [...queryKeys.habitats.all, "tasks", habitatId, filters] as const,
  },
  missions: {
    all: ["missions"] as const,
    list: (boardId: string) => [...queryKeys.missions.all, "list", boardId] as const,
    detail: (missionId: string) => [...queryKeys.missions.all, "detail", missionId] as const,
    details: (missionId: string) => [...queryKeys.missions.all, "details", missionId] as const,
    tasks: (missionId: string) => [...queryKeys.missions.all, "tasks", missionId] as const,
    progress: (missionId: string) => [...queryKeys.missions.all, "progress", missionId] as const,
  },
  tasks: {
    all: ["tasks"] as const,
    detail: (taskId: string) => [...queryKeys.tasks.all, "detail", taskId] as const,
    details: (taskId: string) => [...queryKeys.tasks.all, "details", taskId] as const,
    events: (taskId: string) => [...queryKeys.tasks.all, "events", taskId] as const,
    watchers: (taskId: string) => [...queryKeys.tasks.all, "watchers", taskId] as const,
    subtasks: (taskId: string) => [...queryKeys.tasks.all, "subtasks", taskId] as const,
    pullRequests: (taskId: string) => [...queryKeys.tasks.all, "pullRequests", taskId] as const,
    pipelineEvents: (taskId: string) => [...queryKeys.tasks.all, "pipelineEvents", taskId] as const,
    comments: (taskId: string) => [...queryKeys.tasks.all, "comments", taskId] as const,
    quality: (taskId: string) => [...queryKeys.tasks.all, "quality", taskId] as const,
    reviewers: (taskId: string) => [...queryKeys.tasks.all, "reviewers", taskId] as const,
    approvalStatus: (taskId: string) => [...queryKeys.tasks.all, "approvalStatus", taskId] as const,
  },
  agents: {
    all: ["agents"] as const,
    list: () => [...queryKeys.agents.all, "list"] as const,
    detail: (agentId: string) => [...queryKeys.agents.all, "detail", agentId] as const,
    stats: (agentId: string) => [...queryKeys.agents.all, "stats", agentId] as const,
    listWithTasks: () => [...queryKeys.agents.all, "listWithTasks"] as const,
  },
  dashboard: {
    all: ["dashboard"] as const,
    stats: () => [...queryKeys.dashboard.all, "stats"] as const,
  },
  teams: {
    all: ["teams"] as const,
    list: () => [...queryKeys.teams.all, "list"] as const,
    myTeams: () => [...queryKeys.teams.all, "myTeams"] as const,
  },
  comments: {
    all: ["comments"] as const,
    list: (taskId: string) => [...queryKeys.comments.all, "list", taskId] as const,
  },
  attachments: {
    all: ["attachments"] as const,
    list: (taskId: string) => [...queryKeys.attachments.all, "list", taskId] as const,
  },
  pulse: {
    all: ["pulses"] as const,
    byMission: (missionId: string) => [...queryKeys.pulse.all, missionId] as const,
    byBoard: (boardId: string) => [...queryKeys.pulse.all, "byBoard", boardId] as const,
    replies: (pulseId: string) => [...queryKeys.pulse.all, "replies", pulseId] as const,
  },
  insights: {
    all: ["insights"] as const,
    byBoard: (boardId: string) => [...queryKeys.insights.all, boardId] as const,
  },
  organizations: {
    all: ["organizations"] as const,
    list: () => [...queryKeys.organizations.all, "list"] as const,
    teams: (orgId: string) => [...queryKeys.organizations.all, "teams", orgId] as const,
    members: (teamId: string) => [...queryKeys.organizations.all, "members", teamId] as const,
  },
  savedFilters: {
    all: ["savedFilters"] as const,
    list: (boardId: string) => [...queryKeys.savedFilters.all, boardId] as const,
  },
  health: {
    all: ["health"] as const,
    current: (boardId: string) => [...queryKeys.health.all, boardId] as const,
    history: (boardId: string) => [...queryKeys.health.all, "history", boardId] as const,
  },
  audit: {
    all: ["audit"] as const,
    summary: (boardId: string) => [...queryKeys.audit.all, "summary", boardId] as const,
  },
  missionComments: {
    all: ["missionComments"] as const,
    list: (missionId: string) => [...queryKeys.missionComments.all, missionId] as const,
  },
  user: {
    all: ["user"] as const,
    profile: () => [...queryKeys.user.all, "profile"] as const,
  },
  scheduledTasks: {
    all: ["scheduledTasks"] as const,
    list: (boardId: string) => [...queryKeys.scheduledTasks.all, boardId] as const,
    detail: (id: string) => [...queryKeys.scheduledTasks.all, "detail", id] as const,
  },
  templates: {
    all: ["templates"] as const,
    list: (boardId: string) => [...queryKeys.templates.all, boardId] as const,
  },
  chatIntegrations: {
    all: ["chatIntegrations"] as const,
    list: (boardId: string) => [...queryKeys.chatIntegrations.all, boardId] as const,
  },
  notificationPrefs: {
    all: ["notificationPrefs"] as const,
    board: (boardId: string) => [...queryKeys.notificationPrefs.all, boardId] as const,
  },
  sprints: {
    all: ["sprints"] as const,
    list: (habitatId: string) => [...queryKeys.sprints.all, "list", habitatId] as const,
    active: (habitatId: string) => [...queryKeys.sprints.all, "active", habitatId] as const,
    detail: (sprintId: string) => [...queryKeys.sprints.all, "detail", sprintId] as const,
    metrics: (sprintId: string) => [...queryKeys.sprints.all, "metrics", sprintId] as const,
    burndown: (sprintId: string) => [...queryKeys.sprints.all, "burndown", sprintId] as const,
    carryOver: (sprintId: string) => [...queryKeys.sprints.all, "carryOver", sprintId] as const,
  },
  reviewRules: {
    all: ["reviewRules"] as const,
    list: (habitatId: string) => [...queryKeys.reviewRules.all, "list", habitatId] as const,
  },
  integrations: {
    all: ["integrations"] as const,
    list: (habitatId: string) => [...queryKeys.integrations.all, "list", habitatId] as const,
    syncRuns: (connectionId: string) =>
      [...queryKeys.integrations.all, "syncRuns", connectionId] as const,
    missionLinks: (missionId: string) =>
      [...queryKeys.integrations.all, "missionLinks", missionId] as const,
    intakeCandidates: (habitatId: string, filters?: Record<string, string>) =>
      [...queryKeys.integrations.all, "intakeCandidates", habitatId, filters ?? {}] as const,
  },
  daemons: {
    all: ["daemons"] as const,
    list: () => [...queryKeys.daemons.all, "list"] as const,
    detail: (id: string) => [...queryKeys.daemons.all, "detail", id] as const,
  },
  skill: {
    all: ["skill"] as const,
    detail: (habitatId: string) => [...queryKeys.skill.all, habitatId] as const,
    signals: (habitatId: string, params?: Record<string, unknown>) =>
      [...queryKeys.skill.all, "signals", habitatId, params] as const,
  },
  codeEvidence: {
    all: ["codeEvidence"] as const,
    task: (taskId: string) => [...queryKeys.codeEvidence.all, "task", taskId] as const,
    mission: (missionId: string) => [...queryKeys.codeEvidence.all, "mission", missionId] as const,
    repository: (habitatId: string) =>
      [...queryKeys.codeEvidence.all, "repository", habitatId] as const,
  },
  effort: {
    all: ["effort"] as const,
    task: (taskId: string) => [...queryKeys.effort.all, "task", taskId] as const,
    entriesForTask: (taskId: string) => [...queryKeys.effort.all, "entries", taskId] as const,
    entries: (taskId: string, includeCorrections?: boolean) =>
      [...queryKeys.effort.entriesForTask(taskId), includeCorrections] as const,
  },
  notificationsV2: {
    all: ["notificationsV2"] as const,
    inbox: (habitatId: string) => [...queryKeys.notificationsV2.all, "inbox", habitatId] as const,
    history: (habitatId: string) =>
      [...queryKeys.notificationsV2.all, "history", habitatId] as const,
    subscriptions: (habitatId: string) =>
      [...queryKeys.notificationsV2.all, "subscriptions", habitatId] as const,
    adminSubscriptions: (habitatId: string) =>
      [...queryKeys.notificationsV2.all, "admin", "subscriptions", habitatId] as const,
    retention: (habitatId: string) =>
      [...queryKeys.notificationsV2.all, "admin", "retention", habitatId] as const,
  },
  automation: {
    all: ["automation"] as const,
    rules: (habitatId: string) => [...queryKeys.automation.all, "rules", habitatId] as const,
    rule: (ruleId: string) => [...queryKeys.automation.all, "rule", ruleId] as const,
    runsForRule: (ruleId: string) => [...queryKeys.automation.all, "runs", "rule", ruleId] as const,
    runsForHabitat: (habitatId: string) =>
      [...queryKeys.automation.all, "runs", "habitat", habitatId] as const,
  },
};
