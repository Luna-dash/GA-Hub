// useDocumentTitle — keep document.title in sync with agent / chat state.
//
// Default: "GenericAgent · 管理控制台"
// Streaming: "⏳ Agent 思考中… · GenericAgent"
// Idle (just finished): "✓ Agent 已回复 · GenericAgent" for ~3s, then default.
//
// Mounted once at App level so it works regardless of which page is shown.

import { useEffect, useRef } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useChatStore } from '@/stores/chatStore'

const DEFAULT = 'GenericAgent · 管理控制台'

export function useDocumentTitle() {
  const streaming = useChatStore((s) => s.streaming)
  const queued = useAgentStore((s) => s.status?.queued_tasks ?? 0)
  const wasStreamingRef = useRef(false)
  const flashTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const setTitle = (t: string) => {
      if (document.title !== t) document.title = t
    }
    if (streaming) {
      const q = queued > 0 ? ` (+${queued})` : ''
      setTitle(`⏳ Agent 思考中…${q} · GenericAgent`)
      wasStreamingRef.current = true
      // Cancel any pending revert
      if (flashTimerRef.current) {
        window.clearTimeout(flashTimerRef.current)
        flashTimerRef.current = undefined
      }
      return
    }
    // Just finished a stream — flash a brief confirmation, then revert.
    if (wasStreamingRef.current) {
      wasStreamingRef.current = false
      setTitle(`✓ Agent 已回复 · GenericAgent`)
      flashTimerRef.current = window.setTimeout(() => {
        setTitle(DEFAULT)
        flashTimerRef.current = undefined
      }, 3000) as unknown as number
      return
    }
    setTitle(DEFAULT)
  }, [streaming, queued])

  // Revert to default on unmount (e.g. setup mode)
  useEffect(
    () => () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
      document.title = DEFAULT
    },
    [],
  )
}
