// Renders the in-app toast stack (bottom-center) from useToastStore.
// Mounted once at App root. Self-contained styling (scoped keyframes) so it
// doesn't touch the shared index.css that other work may be editing.

import { useToastStore, type ToastKind } from '@/stores/toastStore'

const TONE: Record<ToastKind, { ring: string; icon: string; iconCls: string }> = {
  success: { ring: 'border-emerald-500/40', icon: '✓', iconCls: 'text-emerald-400' },
  error: { ring: 'border-rose-500/40', icon: '✕', iconCls: 'text-rose-400' },
  info: { ring: 'border-sky-500/40', icon: 'ℹ', iconCls: 'text-sky-400' },
}

export function ToastHost() {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)

  if (items.length === 0) return null

  return (
    <div className="fixed inset-x-0 bottom-5 z-[60] flex flex-col items-center gap-2 px-4 pointer-events-none">
      <style>{`
        @keyframes ga-toast-in {
          from { opacity: 0; transform: translateY(12px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      {items.map((t) => {
        const tone = TONE[t.kind]
        return (
          <div
            key={t.id}
            role="status"
            onClick={() => dismiss(t.id)}
            style={{ animation: 'ga-toast-in 160ms ease-out' }}
            className={`pointer-events-auto cursor-pointer max-w-md w-fit flex items-start gap-2.5 rounded-xl border ${tone.ring} bg-bg-soft/95 backdrop-blur-sm shadow-2xl px-4 py-2.5 text-sm text-slate-200`}
            title="点击关闭"
          >
            <span className={`mt-0.5 font-bold ${tone.iconCls}`}>{tone.icon}</span>
            <span className="whitespace-pre-line leading-5 break-words">{t.message}</span>
          </div>
        )
      })}
    </div>
  )
}
