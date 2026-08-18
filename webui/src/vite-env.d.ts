/// <reference types="vite/client" />

interface PywebviewApi {
  open_url?: (url: string) => Promise<{ ok?: boolean; error?: string } | unknown> | unknown
  save_export?: (filename: string, content: string) => Promise<unknown>
  select_directory?: () => Promise<{
    ok?: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }> | {
    ok?: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }
}

interface Window {
  __TAURI_INTERNALS__?: unknown
  pywebview?: { api?: PywebviewApi }
  __GA_HUB_RUNTIME__?: {
    apiOrigin?: string
    wsOrigin?: string
    desktop?: boolean
    instanceToken?: string
  }
}

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}
