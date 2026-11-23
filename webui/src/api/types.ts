import type { components as GeneratedApiComponents } from './generated/schema'

// Shared contracts come from the generated OpenAPI schema. Legacy types below
// remain until their endpoint-specific response models are migrated.
type ApiSchemas = GeneratedApiComponents['schemas']

// ── Setup ─────────────────────────────────────────────────
export type SetupCandidate = ApiSchemas['SetupCandidateResp']
export type SetupStatus = ApiSchemas['SetupStatusResp']

export type AgentStatus = ApiSchemas['GlobalAgentStatus']
export type ConversationSummary = ApiSchemas['ConversationSummaryResp']
export type Conversation = ApiSchemas['ConversationDetailResp']
/** Where an archive came from — the history listing's source badge + filter.
 *  Archives record no frontend identity, so `im` is the finest grain there is. */
export type ConversationSource = ConversationSummary['source']
export type ConversationListResponse = ApiSchemas['ConversationListResp']
export type ConversationUpdateResponse = ApiSchemas['ConversationUpdateResp']
export type ConversationDeleteResponse = ApiSchemas['ConversationMutationResp']
export type ConversationImportResponse = ApiSchemas['ConversationImportResp']
export type ConversationMessage = ApiSchemas['ConversationMessageResp']

export type LLMInfo = ApiSchemas['LLMInfoResp']

export type MemoryTextResponse = ApiSchemas['MemoryTextResp']
export type MemoryWriteRequest = ApiSchemas['MemoryWriteReq']
export type MemoryWriteResponse = ApiSchemas['MemoryWriteResp']

export interface SessionSnapshot {
  path: string
  mtime: number
  preview: string
  rounds: number
}

export type ThemeTaskConfig = ApiSchemas['ThemeTaskConfig']
// ThemeRunResp allows extra keys (index signature); Omit<> would collapse the
// known fields to `unknown`, so alias it directly.
export type ThemeRun = ApiSchemas['ThemeRunResp']

export type HubSession = Omit<ApiSchemas['HubSession'], 'kind' | 'status'> & {
  kind?: string
  status?: string
}

export type ProjectItem = Omit<ApiSchemas['ProjectItem'], 'last_used' | 'mem_lines' | 'source' | 'dangling'> & {
  last_used?: number
  mem_lines?: number
  source?: string | null
  dangling?: boolean
}

export type SessionRuntime = ApiSchemas['SessionRuntimeResp']
export type SessionMessageProjection = ApiSchemas['SessionMessageProjection'] & {
  session_id?: string | null
  run_id?: string | null
  logical_id?: string | null
  stream_id?: string | null
  archive_generation?: string | null
  outcome?: 'completed' | 'cancelled' | 'failed' | null
}
type GeneratedSessionMessagesResponse = ApiSchemas['SessionMessagesResp']
export type SessionMessagesResponse = Omit<
  GeneratedSessionMessagesResponse,
  'total' | 'has_more' | 'next_before' | 'items'
> & {
  items: SessionMessageProjection[]
  /** Optional during rolling upgrades from a pre-pagination backend. */
  total?: number
  has_more?: boolean
  next_before?: number | null
}

export type ChatRetryConfig = ApiSchemas['ChatRetryConfigReq']

export type ScheduledChat = ApiSchemas['ScheduledChatResp']
export type ScheduledChatListResponse = ApiSchemas['ScheduledChatListResp']

// ── Memory / SOPs ─────────────────────────────────────────
export type SOPListResponse = ApiSchemas['SOPListResp']
export type SkillListResponse = ApiSchemas['SkillListResp']
export type SkillDetailResponse = ApiSchemas['SkillDetailResp']
export type SOPDetailResponse = ApiSchemas['SOPDetailResp']

// ── Autonomous ────────────────────────────────────────────
export type ScheduleType = 'idle' | 'cron' | 'interval'

export type Schedule = ApiSchemas['AutonomousScheduleResp']
export type ScheduleListResponse = ApiSchemas['AutonomousScheduleListResp']
export type ScheduleMutationResponse = ApiSchemas['AutonomousMutationResp']
export type ScheduleTriggerResponse = ApiSchemas['AutonomousTriggerResp']
export type AutonomousRunListResponse = ApiSchemas['AutonomousRunListResp']
export type AutonomousReportListResponse = ApiSchemas['AutonomousReportListResp']
export type AutonomousReportDetailResponse = ApiSchemas['AutonomousReportDetailResp']

// ── Scheduled Tasks ───────────────────────────────────────
export type TaskScheduleType = 'cron' | 'interval'

export type TaskSchedule = ApiSchemas['TaskScheduleResp']
export type TaskScheduleListResponse = ApiSchemas['TaskScheduleListResp']
export type TaskMutationResponse = ApiSchemas['TaskMutationResp']
export type TaskTriggerResponse = ApiSchemas['TaskTriggerResp']
export type TaskRun = ApiSchemas['TaskRunResp']
export type TaskRunResultResponse = ApiSchemas['TaskRunResultResp']
export type TaskRunListResponse = ApiSchemas['TaskRunListResp']

// ── Upload ────────────────────────────────────────────────
export type UploadResult = ApiSchemas['UploadResp']

export interface PasteAttachment extends UploadResult {
  source?: 'local_ref' | 'managed_upload'
  preview?: string
}
export type RevealFileResponse = ApiSchemas['RevealFileResp']
export type ResolveFileResponse = ApiSchemas['ResolveFileResp']

// ── mykey.py editor ──────────────────────────────────────
export type MyKeySessionType =
  | 'native_claude' | 'native_oai' | 'claude' | 'oai' | 'mixin'
export type MyKeySession = Omit<ApiSchemas['MyKeySession'], 'fields' | 'var' | 'type'> & Pick<ApiSchemas['MyKeySession'], 'lineno' | 'end_lineno'> & {
  var: string
  type: MyKeySessionType
  fields: Record<string, any>
}
export type MyKeyData = Omit<ApiSchemas['MyKeyDataResp'], 'structured'> & {
  structured: {
    sessions: MyKeySession[]
    mixins: MyKeySession[]
    globals: Record<string, any>
  }
}
export type MyKeyWriteResult = ApiSchemas['MyKeyWriteResp']
export type MyKeyMutationAction = 'create' | 'update' | 'rename' | 'duplicate' | 'delete' | 'proxy'
export type MyKeyMutation = {
  action: MyKeyMutationAction
  var?: string
  new_var?: string
  type?: MyKeySessionType
  fields?: Record<string, any>
  expected_raw?: string
}
export type MyKeySessionTestResult = ApiSchemas['MyKeySessionTestResp']
export type MyKeyBackup = ApiSchemas['MyKeyBackup']
export type MyKeyBackupListResponse = ApiSchemas['MyKeyBackupListResp']
export type MyKeyAutoSyncStatus = ApiSchemas['MyKeyAutoSyncStatus']
export type MyKeySyncResult = ApiSchemas['MyKeySyncResultResp']
export type MyKeyOpenResponse = ApiSchemas['MyKeyOpenResp']

// ── Chat WS protocol ─────────────────────────────────────
export type ChatWSIn =
  | { type: 'submit'; text: string; images?: string[]; source?: string; llm_index?: number | null }
  | { type: 'abort' }
  | { type: 'ping' }

export interface ChatStreamSnapshot {
  stream_id: string
  source: string
  query: string
  content: string
  turn_segs?: string[]
  done: boolean
  started_at: number
  finished_at: number
  logical_id?: string
  run_id?: string
  session_id?: string
  outcome?: 'completed' | 'cancelled' | 'failed' | null
  aborted?: boolean
  retry_attempt?: number
  retry_max?: number
  retry_of?: string
  retry_reason?: string
}

export interface ChatRetryReason {
  code: string
  label: string
  marker: string
}

export type BtwResp = ApiSchemas['BtwResp']

export type ChatEventCursor = { event_id: number; epoch: string }
export type ChatWSMeta = { turn_segs?: string[]; event_id?: number; epoch?: string; session_id?: string; run_id?: string; logical_id?: string; outcome?: 'completed' | 'cancelled' | 'failed' | null }

export type ChatWSOut = (
  | {
      type: 'snapshot'
      streams?: ChatStreamSnapshot[]
      session_id?: string
      status?: string
      run_id?: string | null
      stream_id?: string | null
      completed_run_id?: string | null
      runtime?: { status: string; run_id: string | null; stream_id: string | null; error: string | null; completed_run_id?: string | null; outcome?: 'completed' | 'cancelled' | 'failed' | null }
      active_message?: { turn_segs?: string[]; stream_id: string; content: string; done: boolean; query?: string; ts?: number; source?: string; run_id?: string; logical_id?: string; retry_of?: string; retry_attempt?: number; retry_max?: number; retry_reason?: string } | null
    }
  | { type: 'session_runtime'; session_id: string; status: string; run_id: string | null; stream_id: string | null; completed_run_id?: string | null; outcome?: 'completed' | 'cancelled' | 'failed' | null; error?: string | null }
  | { type: 'reset'; reason?: string }
  | { type: 'started'; stream_id: string; source?: string; query?: string; ts?: number; logical_id?: string; retry_attempt?: number; retry_max?: number; retry_of?: string; retry_reason?: string }
  | { type: 'heartbeat'; stream_id: string }
  | { type: 'next'; stream_id: string; content: string; source?: string; logical_id?: string; retry_attempt?: number; retry_max?: number; retry_of?: string; retry_reason?: string }
  | { type: 'done'; stream_id: string; content: string; source?: string; logical_id?: string; retry_attempt?: number; retry_max?: number; retry_of?: string; retry_reason?: string }
  | { type: 'retry_scheduled'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; delay_seconds?: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'retry'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'retry_exhausted'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'aborted' }
  | { type: 'pong' }
  | { type: 'error'; session_id: string; run_id: string; stream_id: string; code: string; detail: string }
  | { type: 'rewound'; session_id: string; removed_sids: string[]; kept: number; history_lines: number }
  | { type: 'resync_required'; session_id: string; reason: string }
  | { type: 'replay_done'; session_id: string; event_id: number }
) & ChatWSMeta

type EventBusBase = Omit<ApiSchemas['EventBusEnvelope'], 'topic' | 'payload'>
export interface KnownEventPayloadMap {
  'session:runtime': SessionRuntime
  'chat:error': { session_id: string; run_id: string; stream_id: string; code: string; detail: string }
  'chat:rewound': { session_id: string; removed_sids: string[]; kept: number; history_lines: number }
  'conductor:subagents': { items: ConductorSubagent[]; boot_id?: string | null; snapshot_revision?: number }
  'conductor:chat': { item: ConductorChatMessage }
}
export type KnownEventBusEnvelope = {
  [K in keyof KnownEventPayloadMap]: EventBusBase & { topic: K; payload: KnownEventPayloadMap[K] }
}[keyof KnownEventPayloadMap]
export type FallbackEventBusEnvelope = EventBusBase & {
  topic: string
  payload: Record<string, any>
}
export type EventBusEnvelope = KnownEventBusEnvelope | FallbackEventBusEnvelope
export type BusEvent = EventBusEnvelope & {
  event_id?: number
  epoch?: string
}
export type BusEventFor<T extends string = string> = T extends keyof KnownEventPayloadMap
  ? EventBusBase & { topic: T; payload: KnownEventPayloadMap[T]; event_id?: number; epoch?: string }
  : BusEvent
export type HubEventControl =
  | { type: 'resync_required'; reason: string; epoch: string }
  | { type: 'replay_done'; event_id: number; epoch: string }
export type HubEventMessage = BusEvent | HubEventControl
export type LogLinesResponse = ApiSchemas['LogLinesResp']

// ── Conductor ─────────────────────────────────────────────
export type ConductorChatMessage = ApiSchemas['ConductorChatMessage']
export type ConductorSubagent = ApiSchemas['ConductorSubagent']
export type ConductorStatus = ApiSchemas['ConductorStatusResp']
export type ConductorTextResponse = ApiSchemas['ConductorTextResp']
export type ConductorChatListResponse = ApiSchemas['ConductorChatListResp']
export type ConductorLogResponse = ApiSchemas['ConductorLogResp']
export type ConductorSubagentListResponse = ApiSchemas['ConductorSubagentListResp']
export type ConductorSubagentActionResponse = ApiSchemas['ConductorSubagentActionResp']
export type ConductorLifecycleResponse = ApiSchemas['ConductorLifecycleResp']
export type ConductorWorkflow = ApiSchemas['ConductorWorkflow']
export type ConductorWorkflowListResponse = ApiSchemas['ConductorWorkflowListResp']
export type ConductorActivityEvent = ApiSchemas['ConductorActivityEvent']
export type ConductorActivityListResponse = ApiSchemas['ConductorActivityListResp']

export type TokenTotals = ApiSchemas['TokenTotalsResp']
export type TokenThreadStats = Omit<ApiSchemas['TokenThreadStatsResp'], 'updated_at'> & {
  updated_at?: number
}
export type TokenWeekStats = ApiSchemas['TokenWeekStatsResp']
export type TokenDayStats = ApiSchemas['TokenDayStatsResp']
export type TokenStatsResponse = Omit<ApiSchemas['TokenStatsResp'], 'threads'> & {
  threads: TokenThreadStats[]
}
export interface TokenHistoryPoint extends TokenTotals { timestamp: number }

export type ServicePanelItem = Omit<ApiSchemas['ServicePanelItem'], 'metrics'> & {
  metrics: Record<string, string | number | boolean | null>
}
export type ServicePanelResponse = Omit<ApiSchemas['ServicePanelResp'], 'services'> & {
  services: ServicePanelItem[]
}
