const MAX_DEPTH = 4
const ENVELOPE_KEYS = ['message', 'msg', 'detail', 'error', 'code'] as const
const ENVELOPE_KEY_SET = new Set<string>(ENVELOPE_KEYS)

function isEmptySerializedText(raw: string): boolean {
  const trimmed = raw.trim()
  return !trimmed || trimmed === 'null' || trimmed === 'undefined' || trimmed === '{}' || trimmed === '[]'
}

function unwrapJsonString(raw: string, depth = 0): { isJson: boolean; message: string | null } {
  if (depth > MAX_DEPTH) return { isJson: false, message: null }
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { isJson: false, message: null }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      return { isJson: true, message: extractFromArray(parsed, depth + 1) }
    }
    if (parsed && typeof parsed === 'object') {
      return { isJson: true, message: extractFromObject(parsed as Record<string, unknown>, false, depth + 1) }
    }
  } catch {
    // Not valid JSON; keep the original message text.
  }
  return { isJson: false, message: null }
}

function extractFromArray(items: unknown[], depth = 0): string | null {
  if (depth > MAX_DEPTH || items.length === 0) return null
  const parts: string[] = []
  for (const item of items) {
    let part: string | null = null
    if (typeof item === 'string') {
      if (!isEmptySerializedText(item)) {
        const unwrapped = unwrapJsonString(item, depth + 1)
        part = unwrapped.isJson ? unwrapped.message : item.trim()
      }
    } else if (Array.isArray(item)) {
      part = extractFromArray(item, depth + 1)
    } else if (item && typeof item === 'object') {
      part = extractFromObject(item as Record<string, unknown>, false, depth + 1)
    }
    if (part && !parts.includes(part)) {
      parts.push(part)
    }
  }
  return parts.length > 0 ? parts.join('；') : null
}

function extractFromObject(payload: Record<string, unknown>, serializeFallback: boolean, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null
  for (const key of ENVELOPE_KEYS) {
    const candidate = payload[key]
    if (typeof candidate === 'string' && !isEmptySerializedText(candidate)) {
      const unwrapped = unwrapJsonString(candidate, depth + 1)
      if (unwrapped.isJson) {
        if (unwrapped.message) return unwrapped.message
        continue
      }
      return candidate
    }
    if ((key === 'detail' || key === 'error') && candidate && typeof candidate === 'object') {
      const nested = Array.isArray(candidate)
        ? extractFromArray(candidate, depth + 1)
        : extractFromObject(candidate as Record<string, unknown>, false, depth + 1)
      if (nested) return nested
    }
  }
  const keys = Object.keys(payload)
  if (serializeFallback && keys.some((key) => !ENVELOPE_KEY_SET.has(key))) {
    try {
      return JSON.stringify(payload)
    } catch {
      return null
    }
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
    if (isEmptySerializedText(error)) return fallback
    const unwrapped = unwrapJsonString(error)
    return unwrapped.isJson ? (unwrapped.message ?? fallback) : error
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
  if (typeof body === 'string' && !isEmptySerializedText(body)) {
    const unwrapped = unwrapJsonString(body)
    if (unwrapped.isJson) {
      if (unwrapped.message) return unwrapped.message
    } else {
      return body
    }
  }
  if (body && typeof body === 'object') {
    if (Array.isArray(body)) {
      const extracted = extractFromArray(body)
      if (extracted) return extracted
    } else {
      const bodyObj = body as Record<string, unknown>
      const detail = bodyObj.detail
      if (typeof detail === 'string' && !isEmptySerializedText(detail)) {
        const unwrapped = unwrapJsonString(detail)
        if (unwrapped.isJson) {
          if (unwrapped.message) return unwrapped.message
        } else {
          return detail
        }
      }
      if (detail && typeof detail === 'object') {
        const extracted = Array.isArray(detail)
          ? extractFromArray(detail)
          : extractFromObject(detail as Record<string, unknown>, true)
        if (extracted) return extracted
      }
      for (const key of ['message', 'msg', 'error']) {
        const candidate = bodyObj[key]
        if (typeof candidate === 'string' && !isEmptySerializedText(candidate)) {
          const unwrapped = unwrapJsonString(candidate)
          if (unwrapped.isJson) {
            if (unwrapped.message) return unwrapped.message
          } else {
            return candidate
          }
        }
        if (candidate && typeof candidate === 'object') {
          const extracted = Array.isArray(candidate)
            ? extractFromArray(candidate)
            : extractFromObject(candidate as Record<string, unknown>, false)
          if (extracted) return extracted
        }
      }
    }
  }

  if (typeof value.message === 'string' && !isEmptySerializedText(value.message)) {
    const unwrapped = unwrapJsonString(value.message)
    if (unwrapped.isJson) {
      if (unwrapped.message) return unwrapped.message
    } else {
      return value.message
    }
  }

  return fallback
}
