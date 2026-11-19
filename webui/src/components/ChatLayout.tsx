import type { ReactNode } from 'react'
import { FileTransferBox, type FileTransferBoxProps } from './FileTransferBox'

// Leave the same space between the transcript and scrollbar on both chat pages.
export const chatTranscriptClass = 'relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 pb-1 pl-8 pr-[76px] outline-none [overflow-anchor:none] md:pl-10'

export function ChatUtilityDock({ fileTransfer, children }: { fileTransfer?: FileTransferBoxProps; children?: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-2 inset-y-3 z-10 flex flex-col items-end gap-2">
      {fileTransfer && <div className="ml-4 mr-0.5 shrink-0 self-stretch"><FileTransferBox {...fileTransfer} /></div>}
      {children}
    </div>
  )
}

export function ChatComposerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-t border-line/40 bg-transparent px-3 py-2.5">
      <div className="mx-auto w-full max-w-4xl rounded-xl border border-line/70 bg-bg-card shadow-[inset_0_1px_0_rgba(255,250,232,0.65),0_2px_8px_rgba(45,34,22,0.08)]">{children}</div>
    </div>
  )
}
