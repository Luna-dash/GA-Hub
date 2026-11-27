function extractFromObject(payload: Record<string, unknown>, serializeFallback: boolean): string | null {
  for (const key of ['message', 'detail', 'error', 'code']) {
    const candidate = payload[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (key === 'detail' && candidate && typeof candidate === 'object') {
      const nested = extractFromObject(candidate as Record<string, unknown>, false)
      if (nested) return nested
    }
  }
  if (serializeFallback) {
    try {
      return JSON.stringify(payload)
    } catch {
      return null
    }
  }
  return null
}

function tryExtractJsonString(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return extractFromObject(parsed as Record<string, unknown>, false)
    }
  } catch {
    // Not valid JSON; keep the original message text.
  }
  return null
}

const handledErrors = new WeakSet<object>()

export function markErrorHandled(error: unknown): void {
  if (error && typeof error === 'object') {
    handledErrors.add(error)
  }
}

export function isErrorHandled(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && handledErrors.has(error))
}

export function extractErrorMessage(error: unknown, fallback = '请求失败'): string {
  if (typeof error === 'string') {
    if (!error.trim()) return fallback
    return tryExtractJsonString(error) ?? error
  }
  if (!error || typeof error !== 'object') return fallback

  const value = error as {
    name?: unknown
    code?: unknown
    body?: unknown
    message?: unknown
  }

  if (value.name === 'HttpTimeoutError' || value.code === 'timeout') {
    return '请求超时，请检查网络或稍后重试'
  }
  if (value.name === 'NetworkError' || value.code === 'network_error') {
    return '网络连接失败，请检查服务或网络状态后重试'
  }

  const body = value.body
  if (typeof body === 'string' && body.trim()) {
    return tryExtractJsonString(body) ?? body
  }
  if (body && typeof body === 'object') {
    const bodyObj = body as Record<string, unknown>
    const detail = bodyObj.detail
    if (typeof detail === 'string' && detail.trim()) return detail
    if (detail && typeof detail === 'object') {
      const extracted = extractFromObject(detail as Record<string, unknown>, true)
      if (extracted) return extracted
    }
    for (const key of ['message', 'error']) {
      const candidate = bodyObj[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
  }

  if (typeof value.message === 'string' && value.message.trim()) {
    return tryExtractJsonString(value.message) ?? value.message
  }

  return fallback
}
