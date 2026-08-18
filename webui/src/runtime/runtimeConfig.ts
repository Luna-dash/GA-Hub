export interface RuntimeConfig {
  apiOrigin: string
  wsOrigin: string
  desktop: boolean
  instanceToken: string
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

function normalizeInstanceToken(value: string | undefined): string {
  const token = value?.trim() || ''
  return token.length <= 256 ? token : ''
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function getRuntimeConfig(): RuntimeConfig {
  const injected = window.__GA_HUB_RUNTIME__
  const apiOrigin = normalizeOrigin(injected?.apiOrigin, ['http:', 'https:'])
  const explicitWsOrigin = normalizeOrigin(injected?.wsOrigin, ['ws:', 'wss:'])
  return {
    apiOrigin,
    wsOrigin: explicitWsOrigin || websocketOriginFromHttp(apiOrigin),
    desktop: injected?.desktop === true,
    instanceToken: normalizeInstanceToken(injected?.instanceToken),
  }
}

export function desktopRuntimeConfigError(): string | null {
  if (!isTauriRuntime()) return null
  const runtime = getRuntimeConfig()
  if (!runtime.desktop) return '桌面运行配置未注入'
  if (!runtime.apiOrigin || !runtime.wsOrigin) return '桌面后端地址无效'
  if (!runtime.instanceToken) return '桌面实例标识缺失'
  return null
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
