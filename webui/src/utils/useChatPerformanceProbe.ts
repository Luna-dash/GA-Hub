import { type RefObject, useCallback, useEffect, useRef } from 'react'
import {
  collectChatPerformanceSample,
  isChatPerformanceEnabled,
  publishChatPerformanceSample,
} from './chatPerformance'

interface Options {
  rootRef: RefObject<HTMLElement>
  sessionId: string | null
  historyStatus: string
  messages: ReadonlyArray<{ content: string }>
  streaming: boolean
}

/**
 * Development/opt-in performance telemetry kept entirely in the local page.
 * Inspect `window.__GA_HUB_PERF__` from DevTools; no sample leaves the device.
 */
export function useChatPerformanceProbe(options: Options): void {
  const enabled = isChatPerformanceEnabled()
  const latestRef = useRef(options)
  const switchStartedRef = useRef<number | null>(null)
  const readyMsRef = useRef<number | null>(null)
  latestRef.current = options

  const sample = useCallback(() => {
    if (!enabled) return
    const latest = latestRef.current
    publishChatPerformanceSample(collectChatPerformanceSample(latest.rootRef.current, {
      sessionId: latest.sessionId,
      historyStatus: latest.historyStatus,
      totalMessages: latest.messages.length,
      totalCharacters: latest.messages.reduce((total, message) => total + message.content.length, 0),
      streaming: latest.streaming,
      readyMs: readyMsRef.current,
    }))
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    switchStartedRef.current = performance.now()
    readyMsRef.current = null
  }, [enabled, options.sessionId])

  useEffect(() => {
    if (!enabled || options.historyStatus !== 'ready' || switchStartedRef.current == null) return
    readyMsRef.current = performance.now() - switchStartedRef.current
    switchStartedRef.current = null
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(sample)
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [enabled, options.historyStatus, options.sessionId, sample])

  useEffect(() => {
    if (!enabled) return
    const timer = window.setTimeout(sample, 500)
    return () => window.clearTimeout(timer)
  }, [enabled, options.historyStatus, options.messages.length, options.sessionId, options.streaming, sample])

  useEffect(() => {
    if (!enabled || !options.streaming) return
    const timer = window.setInterval(sample, 2_000)
    return () => window.clearInterval(timer)
  }, [enabled, options.streaming, sample])
}
