/** Single registry of browser-storage keys owned by the web UI.
 *
 * Every localStorage key (and the sessionStorage namespace) lives here so
 * duplicates and collisions are visible in one place (review: scattered key
 * literals). Values are frozen historical names — two predate the `gahub.`
 * prefix convention and must not change, because renaming would orphan
 * saved user preferences.
 */
export const storageKeys = {
  /** LiveChat: last active session id, restored on boot. */
  currentSessionId: 'gahub.currentSessionId',
  /** SidebarNav: '1' = navigation sidebar collapsed. */
  sidebarCollapsed: 'gahub.sidebar.collapsed',
  /** ConversationIndexRail: 'true' = conversation index rail collapsed. */
  conversationIndexCollapsed: 'gahub.conversationIndexCollapsed',
  /** SessionRail: per-session completed-run bookkeeping (JSON object). */
  sessionRailSeenCompletedRuns: 'gahub.sessionRailSeenCompletedRuns',
  /** SessionRail: terminal state per session id (JSON object). */
  sessionRailTerminalState: 'gahub.sessionRailTerminalState',
  /** SessionRail: collapsed rail groups (JSON object). */
  sessionRailGroupCollapse: 'gahub.sessionRailGroupCollapse',
  /** LEGACY: pre-terminal-state recent-activity list, removed on boot. */
  sessionRailLegacyRecentActivity: 'gahub.sessionRailRecentActivity',
  /** Conductor: 'true' = subagent model switcher locked to engine default. */
  conductorSubagentModelLocked: 'gahub.conductor.subagentModelLocked.v1',
  /** config/navigation.ts: ordering/visibility preferences (JSON). */
  navPreferences: 'gahub.nav.preferences.v1',
  /** useSharedModelSelection: preferred LLM bindings (string keys). */
  modelSelectionMainLlm: 'gahub.modelSelection.mainLlmKey.v1',
  modelSelectionSubagentLlm: 'gahub.modelSelection.subagentLlmKey.v1',
  /** chatAppearance: chat font-scale percent (number-as-string). */
  chatFontScale: 'gahub.chat-font-scale',
  /** railAppearance: rail title font-scale percent (number-as-string). */
  railTitleScale: 'gahub.rail-title-scale',
  /** mykeySyncUi: '1'/'0' upload hint visibility. */
  mykeyShowUpload: 'gahub.mykey-show-upload',
  /** chatPerformance: '1' = performance mode enabled. */
  chatPerformance: 'gahub.chatPerformance',
  /** LEGACY pre-`gahub.` prefixes — frozen so saved prefs keep working. */
  desktopNotifications: 'ga.desktopNotifications.v1',
  /** main.tsx: dynamic-import chunk reload guard (epoch timestamp). */
  chunkReloadAt: 'ga-hub:chunk-reload-at',
} as const

/** pageState.ts namespace prefix (sessionStorage, per-page key/values). */
export const pageStatePrefix = 'gahub.pageState.v1:'
