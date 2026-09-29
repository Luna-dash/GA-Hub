export type ViewportResumePolicy = 'restore-position' | 'follow-latest' | 'open-latest'

export type ViewportHydrationPhase =
  | 'empty'
  | 'loading-history'
  | 'cached'
  | 'replaying'
  | 'ready'
  | 'failed'

export type ViewportAction = 'wait' | 'restore-position' | 'follow-latest' | 'open-latest'

export interface ViewportDecisionInput {
  resumePolicy: ViewportResumePolicy
  hydration: ViewportHydrationPhase
  hasMessages: boolean
}

/**
 * Pure policy for session viewport landing. DOM/virtual-list mechanics belong
 * to the caller; this function only decides when a final landing is allowed.
 *
 * 'ready' is the healthy release. 'failed' is the degraded escape: the
 * projection barrier never resolved (e.g. the transport is down), so the
 * caller lands with the cached view instead of stranding the reader at the
 * top — the same policy applies, just without the barrier.
 */
export function decideViewportAction({
  resumePolicy,
  hydration,
  hasMessages,
}: ViewportDecisionInput): ViewportAction {
  if (!hasMessages) return 'wait'
  if (hydration !== 'ready' && hydration !== 'failed') return 'wait'
  return resumePolicy
}
