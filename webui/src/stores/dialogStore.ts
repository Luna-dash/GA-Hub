// Themed alert / confirm / prompt — replaces native window.{alert,confirm,prompt}.
//
// Imperative API (`dialog.confirm(...)`) returns a Promise so callers can
// `await` it just like the native versions; behind the scenes a single
// <DialogHost> reads state from this store and renders the modal.

import { create } from 'zustand'

export type DialogTone = 'default' | 'danger'

export interface DialogConfig {
  kind: 'alert' | 'confirm' | 'prompt'
  title: string
  message?: string                // body text (rendered with whitespace preserved)
  defaultValue?: string           // prompt initial value
  placeholder?: string            // prompt placeholder
  confirmText?: string            // primary button label
  cancelText?: string             // secondary button label (omit on alert)
  tone?: DialogTone               // 'danger' colors the primary button red
  multiline?: boolean             // prompt: textarea vs input
  detail?: string                  // optional expandable diagnostics
}

export type DialogResult = boolean | string | null | void
export const cancelResult = (cfg: DialogConfig): DialogResult => cfg.kind === 'confirm' ? false : null
interface PendingDialog { config: DialogConfig; resolve: (v: DialogResult) => void }

interface DialogState {
  open: boolean
  config: DialogConfig | null
  resolve: ((v: DialogResult) => void) | null
  queue: PendingDialog[]

  show: <T = unknown>(cfg: DialogConfig) => Promise<T>
  resolveCurrent: (v: DialogResult) => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  open: false,
  config: null,
  resolve: null,
  queue: [],

  show: <T = unknown>(cfg: DialogConfig) =>
    new Promise<T>((resolve) => {
      const entry = { config: cfg, resolve: resolve as (v: DialogResult) => void }
      if (get().open) set({ queue: [...get().queue, entry] })
      else set({ open: true, config: cfg, resolve: entry.resolve })
    }),

  resolveCurrent: (v: DialogResult) => {
    const { resolve, queue } = get()
    const [next, ...rest] = queue
    set(next
      ? { open: true, config: next.config, resolve: next.resolve, queue: rest }
      : { open: false, config: null, resolve: null, queue: [] })
    resolve?.(v)
  },
}))

// Keep desktop failures in the same FIFO lane, including browser fallback.
let desktopLane: Promise<unknown> = Promise.resolve()
export function requestDialog<T>(config: DialogConfig): Promise<T> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return useDialogStore.getState().show<T>(config)
  }
  const request = desktopLane.then(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      return await invoke<T>('show_message_dialog', { config })
    } catch (error) {
      console.warn('Desktop message window unavailable; using in-page dialog', error)
      // The Rust error path re-enables main before rejecting. Preserve safe
      // focus and prompt semantics rather than auto-confirming via OS defaults.
      return useDialogStore.getState().show<T>(config)
    }
  })
  desktopLane = request.catch(() => undefined)
  return request
}

// ── Imperative helpers (use these from anywhere) ──────────────────
export const dialog = {
  alert: (title: string, message?: string, opts?: { detail?: string }) =>
    requestDialog<void>({
      kind: 'alert',
      title,
      message,
      detail: opts?.detail,
      confirmText: '知道了',
    }),

  confirm: (
    title: string,
    message?: string,
    opts?: { confirmText?: string; cancelText?: string; tone?: DialogTone; detail?: string },
  ) =>
    requestDialog<boolean>({
      kind: 'confirm',
      title,
      message,
      confirmText: opts?.confirmText ?? '确认',
      cancelText: opts?.cancelText ?? '取消',
      tone: opts?.tone,
      detail: opts?.detail,
    }),

  prompt: (
    title: string,
    opts?: {
      message?: string
      defaultValue?: string
      placeholder?: string
      confirmText?: string
      cancelText?: string
      multiline?: boolean
      detail?: string
    },
  ) =>
    requestDialog<string | null>({
      kind: 'prompt',
      title,
      message: opts?.message,
      defaultValue: opts?.defaultValue ?? '',
      placeholder: opts?.placeholder,
      confirmText: opts?.confirmText ?? '确认',
      cancelText: opts?.cancelText ?? '取消',
      multiline: opts?.multiline,
      detail: opts?.detail,
    }),
}
