import { useCallback, useEffect, useState } from 'react'
import { llmIndexForKey, resolveMainLlmKey, resolveSubagentLlmKey, type LlmIdentity } from '@/utils/llm'

export const MAIN_LLM_PREFERENCE_KEY = 'gahub.modelSelection.mainLlmKey.v1'
export const SUBAGENT_LLM_PREFERENCE_KEY = 'gahub.modelSelection.subagentLlmKey.v1'

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePreference(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {}
}

/** Shared non-session model preferences used by Conductor and Goal/Hive.
 * Live chat keeps a per-session binding, but uses the same key-based policy
 * and selectors.
 */
export function useSharedModelSelection(llms: ReadonlyArray<LlmIdentity>) {
  const [savedMainLlmKey, setSavedMainLlmKey] = useState<string | null>(() => readPreference(MAIN_LLM_PREFERENCE_KEY))
  const [savedSubagentLlmKey, setSavedSubagentLlmKey] = useState<string | null>(() => readPreference(SUBAGENT_LLM_PREFERENCE_KEY))

  const mainLlmKey = resolveMainLlmKey(llms, savedMainLlmKey)
  const subagentLlmKey = resolveSubagentLlmKey(llms, savedSubagentLlmKey)

  useEffect(() => {
    if (llms.length === 0) return

    const repairedMainKey = mainLlmKey ?? null
    if (savedMainLlmKey !== repairedMainKey) {
      setSavedMainLlmKey(repairedMainKey)
      writePreference(MAIN_LLM_PREFERENCE_KEY, repairedMainKey)
    }

    if (savedSubagentLlmKey !== subagentLlmKey) {
      setSavedSubagentLlmKey(subagentLlmKey)
      writePreference(SUBAGENT_LLM_PREFERENCE_KEY, subagentLlmKey)
    }
  }, [llms.length, mainLlmKey, savedMainLlmKey, savedSubagentLlmKey, subagentLlmKey])

  const selectMainLlm = useCallback((llmKey: string) => {
    setSavedMainLlmKey(llmKey)
    writePreference(MAIN_LLM_PREFERENCE_KEY, llmKey)
  }, [])

  const selectSubagentLlm = useCallback((llmKey: string | null) => {
    setSavedSubagentLlmKey(llmKey)
    writePreference(SUBAGENT_LLM_PREFERENCE_KEY, llmKey)
  }, [])

  const effectiveSubagentLlmKey = subagentLlmKey ?? mainLlmKey
  const selectedSubagentLlmIndex = llmIndexForKey(llms, subagentLlmKey)

  return {
    mainLlmKey,
    subagentLlmKey,
    mainLlmIndex: llmIndexForKey(llms, mainLlmKey),
    subagentLlmIndex: llmIndexForKey(llms, effectiveSubagentLlmKey),
    selectedSubagentLlmIndex,
    selectMainLlm,
    selectSubagentLlm,
  }
}
