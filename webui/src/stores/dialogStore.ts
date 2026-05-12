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
}

interface DialogState {
  open: boolean
  config: DialogConfig | null
  resolve: ((v: any) => void) | null

  show: <T = unknown>(cfg: DialogConfig) => Promise<T>
  resolveCurrent: (v: any) => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  open: false,
  config: null,
  resolve: null,

  show: <T = unknown>(cfg: DialogConfig) =>
    new Promise<T>((resolve) => {
      set({ open: true, config: cfg, resolve: resolve as (v: any) => void })
    }),

  resolveCurrent: (v: any) => {
    const r = get().resolve
    set({ open: false, config: null, resolve: null })
    if (r) r(v)
  },
}))

// ── Imperative helpers (use these from anywhere) ──────────────────
export const dialog = {
  alert: (title: string, message?: string) =>
    useDialogStore.getState().show<void>({
      kind: 'alert',
      title,
      message,
      confirmText: '知道了',
    }),

  confirm: (
    title: string,
    message?: string,
    opts?: { confirmText?: string; cancelText?: string; tone?: DialogTone },
  ) =>
    useDialogStore.getState().show<boolean>({
      kind: 'confirm',
      title,
      message,
      confirmText: opts?.confirmText ?? '确认',
      cancelText: opts?.cancelText ?? '取消',
      tone: opts?.tone,
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
    },
  ) =>
    useDialogStore.getState().show<string | null>({
      kind: 'prompt',
      title,
      message: opts?.message,
      defaultValue: opts?.defaultValue ?? '',
      placeholder: opts?.placeholder,
      confirmText: opts?.confirmText ?? '确认',
      cancelText: opts?.cancelText ?? '取消',
      multiline: opts?.multiline,
    }),
}
