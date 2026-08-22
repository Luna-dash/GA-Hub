/// <reference types="vite/client" />

interface Window {
  __TAURI_INTERNALS__?: unknown
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
