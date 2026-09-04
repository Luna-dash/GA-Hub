/** Shared TanStack Query keys.
 *
 * Keeping key construction in one place prevents an invalidate call from
 * silently targeting a different cache entry than the query it intends to
 * refresh. Parameterized keys remain functions so their identity is explicit.
 *
 * Sanctioned exception: `queries/conversations.ts` owns its `conversationKeys`
 * alongside the cache-mutation helpers that operate on them — the keys and the
 * only code that touches those entries live (and are tested) together.
 */
export const queryKeys = {
  setup: ['setup'] as const,
  servicePanel: ['service-panel'] as const,
  tokenStats: ['token-stats'] as const,
  llms: ['llms'] as const,
  schedules: ['schedules'] as const,
  sessions: ['sessions'] as const,
  projects: ['projects'] as const,
  runtimes: ['session.runtimes'] as const,
  scheduledChats: (sessionId: string | undefined) =>
    ['session.scheduledChats', sessionId] as const,
  conductor: {
    status: ['conductor', 'status'] as const,
    subagents: ['conductor', 'subagents'] as const,
    subagent: (sid: string) => ['conductor', 'subagent', sid] as const,
    workflows: ['conductor', 'workflows'] as const,
    chat: ['conductor', 'chat'] as const,
  },
  autonomous: {
    runs: ['auto.runs'] as const,
    reports: ['auto.reports'] as const,
    report: (id: string | number | null | undefined) => ['auto.report', id] as const,
  },
  tasks: {
    schedules: ['tasks.schedules'] as const,
    runs: ['tasks.runs'] as const,
    emailConfig: ['tasks.emailConfig'] as const,
  },
  agent: {
    chatRetryConfig: ['agent.chatRetryConfig'] as const,
  },
  memory: {
    global: ['mem.global'] as const,
    insight: ['mem.insight'] as const,
    sops: ['sops'] as const,
    sop: (name: string | null | undefined) => ['sop', name] as const,
  },
  skills: {
    list: (limit = 200) => ['skills', limit] as const,
    detail: (name: string | null | undefined) => ['skill', name] as const,
  },
  mykey: {
    data: ['mykey'] as const,
    backups: ['mykey.backups'] as const,
  },
} as const
