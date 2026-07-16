export const queryKeys = {
  habitats: {
    all: ["habitats"] as const,
    list: () => [...queryKeys.habitats.all, "list"] as const,
    detail: (habitatId: string) => [...queryKeys.habitats.all, "detail", habitatId] as const,
    stats: (habitatId: string) => [...queryKeys.habitats.all, "stats", habitatId] as const,
    events: (habitatId: string) => [...queryKeys.habitats.all, "events", habitatId] as const,
    eventsInfinite: (habitatId: string, action: string | undefined, pageSize: number) =>
      [...queryKeys.habitats.all, "eventsInfinite", habitatId, { action }, pageSize] as const,
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
    list: (habitatId: string) => [...queryKeys.missions.all, "list", habitatId] as const,
    detail: (missionId: string) => [...queryKeys.missions.all, "detail", missionId] as const,
    details: (missionId: string) => [...queryKeys.missions.all, "details", missionId] as const,
    tasks: (missionId: string) => [...queryKeys.missions.all, "tasks", missionId] as const,
    progress: (missionId: string) => [...queryKeys.missions.all, "progress", missionId] as const,
    archived: (habitatId: string, pageSize: number) =>
      [...queryKeys.missions.all, "archived", habitatId, pageSize] as const,
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
    byTask: (missionId: string, taskId: string) =>
      [...queryKeys.pulse.all, "byTask", missionId, taskId] as const,
    byBoard: (habitatId: string) => [...queryKeys.pulse.all, "byBoard", habitatId] as const,
    replies: (pulseId: string) => [...queryKeys.pulse.all, "replies", pulseId] as const,
  },
  insights: {
    all: ["insights"] as const,
    byBoard: (habitatId: string) => [...queryKeys.insights.all, habitatId] as const,
  },
  organizations: {
    all: ["organizations"] as const,
    list: () => [...queryKeys.organizations.all, "list"] as const,
    teams: (orgId: string) => [...queryKeys.organizations.all, "teams", orgId] as const,
    members: (teamId: string) => [...queryKeys.organizations.all, "members", teamId] as const,
  },
  savedFilters: {
    all: ["savedFilters"] as const,
    list: (habitatId: string) => [...queryKeys.savedFilters.all, habitatId] as const,
  },
  health: {
    all: ["health"] as const,
    current: (habitatId: string) => [...queryKeys.health.all, habitatId] as const,
    history: (habitatId: string) => [...queryKeys.health.all, "history", habitatId] as const,
  },
  audit: {
    all: ["audit"] as const,
    summary: (habitatId: string) => [...queryKeys.audit.all, "summary", habitatId] as const,
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
    list: (habitatId: string) => [...queryKeys.scheduledTasks.all, habitatId] as const,
    detail: (id: string) => [...queryKeys.scheduledTasks.all, "detail", id] as const,
  },
  templates: {
    all: ["templates"] as const,
    list: (habitatId: string) => [...queryKeys.templates.all, habitatId] as const,
  },
  chatIntegrations: {
    all: ["chatIntegrations"] as const,
    list: (habitatId: string) => [...queryKeys.chatIntegrations.all, habitatId] as const,
  },
  notificationPrefs: {
    all: ["notificationPrefs"] as const,
    board: (habitatId: string) => [...queryKeys.notificationPrefs.all, habitatId] as const,
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
  remoteAccess: {
    all: ["remoteAccess"] as const,
    management: (habitatId: string) =>
      [...queryKeys.remoteAccess.all, "management", habitatId] as const,
    readiness: (habitatId: string) =>
      [...queryKeys.remoteAccess.all, "readiness", habitatId] as const,
    pods: (habitatId: string) => [...queryKeys.remoteAccess.all, "pods", habitatId] as const,
    grants: (habitatId: string) => [...queryKeys.remoteAccess.all, "grants", habitatId] as const,
    participants: (habitatId: string) =>
      [...queryKeys.remoteAccess.all, "participants", habitatId] as const,
    webhookEndpoints: (habitatId: string) =>
      [...queryKeys.remoteAccess.all, "webhookEndpoints", habitatId] as const,
  },
  metrics: {
    all: ["metrics"] as const,
    experience: (habitatId: string, days: number) =>
      [...queryKeys.metrics.all, "experience", habitatId, days] as const,
    workflow: (habitatId: string, days: number) =>
      [...queryKeys.metrics.all, "workflow", habitatId, days] as const,
  },
  wiki: {
    all: ["wiki"] as const,
    pages: (habitatId: string) => [...queryKeys.wiki.all, "pages", habitatId] as const,
    page: (habitatId: string, pageId: string) =>
      [...queryKeys.wiki.all, "page", habitatId, pageId] as const,
    versions: (habitatId: string, pageId: string) =>
      [...queryKeys.wiki.all, "versions", habitatId, pageId] as const,
    search: (habitatId: string, query: string) =>
      [...queryKeys.wiki.all, "search", habitatId, query] as const,
    signalSurface: (habitatId: string, opts?: string) =>
      [...queryKeys.wiki.all, "signalSurface", habitatId, opts ?? ""] as const,
    cadence: (habitatId: string) => [...queryKeys.wiki.all, "cadence", habitatId] as const,
  },
  plugins: {
    all: ["plugins"] as const,
    enrollments: (habitatId: string) =>
      [...queryKeys.plugins.all, "enrollments", habitatId] as const,
    loaded: () => [...queryKeys.plugins.all, "loaded"] as const,
    runs: (habitatId: string) => [...queryKeys.plugins.all, "runs", habitatId] as const,
  },
  triage: {
    all: ["triage"] as const,
    findings: (habitatId: string, filters?: { status?: string; bucket?: string }) =>
      [...queryKeys.triage.all, "findings", habitatId, filters] as const,
    finding: (id: string) => [...queryKeys.triage.all, "finding", id] as const,
    resolutions: (habitatId: string, clusterKey: string) =>
      [...queryKeys.triage.all, "resolutions", habitatId, clusterKey] as const,
    top: (habitatId: string, limit?: number) =>
      [...queryKeys.triage.all, "top", habitatId, limit] as const,
  },
};
