export interface ChatPerformanceSample {
  at: number
  sessionId: string | null
  historyStatus: string
  totalMessages: number
  renderedMessages: number
  totalCharacters: number
  domNodes: number
  virtualized: boolean
  streaming: boolean
  readyMs: number | null
  heapBytes: number | null
}

export interface ChatPerformanceBuffer {
  samples: ChatPerformanceSample[]
  latest: ChatPerformanceSample | null
  clear: () => void
}

declare global {
  interface Window {
    __GA_HUB_PERF__?: ChatPerformanceBuffer
  }
}

const MAX_SAMPLES = 80

export function hasChatPerformanceQuery(search: string, hash: string): boolean {
  if (new URLSearchParams(search).get('perf') === '1') return true

  // HashRouter keeps the route query inside location.hash, for example
  // `#/chat?perf=1`, leaving location.search empty in packaged Tauri builds.
  const queryStart = hash.indexOf('?')
  if (queryStart < 0) return false
  const queryEnd = hash.indexOf('#', queryStart)
  const query = hash.slice(queryStart + 1, queryEnd < 0 ? undefined : queryEnd)
  return new URLSearchParams(query).get('perf') === '1'
}

export function isChatPerformanceEnabled(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return window.localStorage.getItem('gahub.chatPerformance') === '1'
      || hasChatPerformanceQuery(window.location.search, window.location.hash)
  } catch {
    return false
  }
}

export function collectChatPerformanceSample(
  root: HTMLElement | null,
  input: Omit<
    ChatPerformanceSample,
    'at' | 'renderedMessages' | 'domNodes' | 'virtualized' | 'heapBytes'
  >,
): ChatPerformanceSample {
  const virtualRoot = root?.querySelector<HTMLElement>('[data-chat-virtual-list]') ?? null
  const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } }
  const heap = memory.memory?.usedJSHeapSize
  return {
    ...input,
    at: Date.now(),
    renderedMessages: root?.querySelectorAll('[data-chat-message]').length ?? 0,
    domNodes: root?.querySelectorAll('*').length ?? 0,
    virtualized: virtualRoot?.dataset.virtualized === 'true',
    heapBytes: Number.isFinite(heap) ? heap as number : null,
  }
}

export function publishChatPerformanceSample(sample: ChatPerformanceSample): void {
  const buffer = window.__GA_HUB_PERF__ ?? {
    samples: [],
    latest: null,
    clear: () => {
      if (!window.__GA_HUB_PERF__) return
      window.__GA_HUB_PERF__.samples.length = 0
      window.__GA_HUB_PERF__.latest = null
    },
  }
  buffer.samples.push(sample)
  if (buffer.samples.length > MAX_SAMPLES) {
    buffer.samples.splice(0, buffer.samples.length - MAX_SAMPLES)
  }
  buffer.latest = sample
  window.__GA_HUB_PERF__ = buffer
}
