// LLM key resolution helpers shared by the model pickers.
//
// Policy: a durable binding stays valid while the bound key still exists;
// anything else falls back to the first configured model (main) or follows
// the main model (subagent), so list reordering never changes identity.

export interface LlmIdentity {
  key: string
  index?: number
}

export function defaultMainLlmKey(llms: ReadonlyArray<LlmIdentity>): string | undefined {
  return llms[0]?.key
}

/** Keep a durable main-model binding when it still exists; otherwise use the
 * first configured model. This is also the migration rule for old positional
 * bindings and for bindings whose model was deleted.
 */
export function resolveMainLlmKey(
  llms: ReadonlyArray<LlmIdentity>,
  llmKey: string | null | undefined,
): string | undefined {
  if (llmKey && llms.some((item) => item.key === llmKey)) {
    return llmKey
  }
  return defaultMainLlmKey(llms)
}

/** An invalid explicit subagent binding falls back to following the main
 * model. It must never drift to a neighbouring item after list changes.
 */
export function resolveSubagentLlmKey(
  llms: ReadonlyArray<LlmIdentity>,
  llmKey: string | null | undefined,
): string | null {
  return llmKey && llms.some((item) => item.key === llmKey) ? llmKey : null
}

/** Convert a durable key to the index expected by legacy runtime APIs. Always
 * use the latest LLM snapshot so reordering does not change model identity.
 */
export function llmIndexForKey(
  llms: ReadonlyArray<LlmIdentity>,
  llmKey: string | null | undefined,
): number | null {
  if (!llmKey) return null
  const position = llms.findIndex((item) => item.key === llmKey)
  if (position < 0) return null
  const configuredIndex = llms[position].index
  return Number.isInteger(configuredIndex) ? configuredIndex as number : position
}

// Live-chat sessions use the same main-model policy, with persistence owned by
// the session API instead of the shared non-session preference hook.
export const defaultSessionLlmKey = defaultMainLlmKey
export const resolveSessionLlmKey = resolveMainLlmKey
