export interface RuntimeConfig {
  apiOrigin: string
  wsOrigin: string
}

function normalizeOrigin(value: string | undefined, protocols: readonly string[]): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (!protocols.includes(url.protocol) || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

function websocketOriginFromHttp(origin: string): string {
  if (!origin) return ''
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.origin
}

export function getRuntimeConfig(): RuntimeConfig {
  const injected = window.__GA_HUB_RUNTIME__
  const apiOrigin = normalizeOrigin(injected?.apiOrigin, ['http:', 'https:'])
  const explicitWsOrigin = normalizeOrigin(injected?.wsOrigin, ['ws:', 'wss:'])
  return {
    apiOrigin,
    wsOrigin: explicitWsOrigin || websocketOriginFromHttp(apiOrigin),
  }
}

export function resolveApiUrl(path: string): string {
  const { apiOrigin } = getRuntimeConfig()
  return apiOrigin ? new URL(path, `${apiOrigin}/`).href : path
}

export function resolveWsUrl(path: string): string {
  const configuredOrigin = getRuntimeConfig().wsOrigin
  if (configuredOrigin) return new URL(path, `${configuredOrigin}/`).href

  const pageOrigin = new URL(window.location.href)
  pageOrigin.protocol = pageOrigin.protocol === 'https:' ? 'wss:' : 'ws:'
  return new URL(path, `${pageOrigin.origin}/`).href
}
