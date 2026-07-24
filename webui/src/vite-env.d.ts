/// <reference types="vite/client" />

interface PywebviewApi {
  open_url?: (url: string) => Promise<{ ok?: boolean; error?: string } | unknown> | unknown
  save_export?: (filename: string, content: string) => Promise<unknown>
}

interface Window {
  pywebview?: { api?: PywebviewApi }
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
