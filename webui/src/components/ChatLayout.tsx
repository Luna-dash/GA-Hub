import type { ReactNode } from 'react'

// Leave the same space between the transcript and scrollbar on both chat pages.
export const chatTranscriptClass = 'relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 pb-1 pl-8 pr-[76px] outline-none [overflow-anchor:none] md:pl-10'

export function ChatComposerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-t border-line/40 bg-transparent px-3 py-2.5">
      <div className="w-full rounded-xl border border-line/60 bg-bg-card shadow-sm">{children}</div>
    </div>
  )
}
