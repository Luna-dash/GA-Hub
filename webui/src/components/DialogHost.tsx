// Single mount point for themed alert/confirm/prompt dialogs.
// Reads state from dialogStore; rendered once at App root.

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useDialogStore } from '@/stores/dialogStore'

export function DialogHost() {
  const open = useDialogStore((s) => s.open)
  const config = useDialogStore((s) => s.config)
  const resolveCurrent = useDialogStore((s) => s.resolveCurrent)

  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // Reset input value & autofocus whenever a new dialog opens
  useEffect(() => {
    if (open && config) {
      setValue(config.defaultValue ?? '')
      // RAF so the textarea is mounted before we focus
      const id = window.setTimeout(() => {
        inputRef.current?.focus()
        if (inputRef.current && 'select' in inputRef.current) inputRef.current.select()
      }, 30)
      return () => window.clearTimeout(id)
    }
  }, [open, config])

  // ESC closes (cancel), Enter confirms unless we're in a multiline prompt
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        if (config?.kind === 'prompt' && config.multiline) return
        e.preventDefault()
        confirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, config, value])

  if (!open || !config) return null

  const cancel = () => {
    if (config.kind === 'alert') resolveCurrent(undefined)
    else if (config.kind === 'confirm') resolveCurrent(false)
    else resolveCurrent(null) // prompt
  }
  const confirm = () => {
    if (config.kind === 'alert') resolveCurrent(undefined)
    else if (config.kind === 'confirm') resolveCurrent(true)
    else resolveCurrent(value)
  }

  const danger = config.tone === 'danger'
  const primaryCls = danger
    ? 'bg-rose-600 hover:bg-rose-500 text-white'
    : 'bg-accent text-white hover:brightness-110'

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex items-center justify-center px-4"
      onClick={cancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-bg-soft border border-line rounded-xl shadow-2xl w-full max-w-md p-5 animate-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-slate-200 mb-1">{config.title}</div>
        {config.message && (
          <div className="text-sm text-slate-400 whitespace-pre-line leading-6 mb-3">
            {config.message}
          </div>
        )}

        {config.kind === 'prompt' && (
          config.multiline ? (
            <textarea
              ref={inputRef as any}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={config.placeholder}
              rows={4}
              className="w-full bg-bg-card border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent text-slate-200 resize-y mb-3"
            />
          ) : (
            <input
              ref={inputRef as any}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={config.placeholder}
              className="w-full bg-bg-card border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent text-slate-200 mb-3"
            />
          )
        )}

        <div className="flex justify-end gap-2 mt-2">
          {config.kind !== 'alert' && (
            <button
              onClick={cancel}
              className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 text-sm"
            >
              {config.cancelText || '取消'}
            </button>
          )}
          <button
            onClick={confirm}
            className={clsx('px-3 py-1.5 rounded-lg text-sm', primaryCls)}
          >
            {config.confirmText || '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
