import type { PointerEventHandler, ReactNode, Ref } from 'react'
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

export interface TranscriptUtilityRailProps {
  railRef?: Ref<HTMLElement>
  onPointerDown?: PointerEventHandler<HTMLElement>
  topSlot?: ReactNode
  minimap?: ReactNode
  navDock?: ReactNode
  className?: string
}

/**
 * 固定右侧会话导航栏结构：
 * 底部为 TranscriptNavDock 预留固定高度（stuckBottom 显隐时不挤压上方空间），
 * 使中间的 ConversationTurnMinimap 中心始终停在一致高度、滚动到两端不再上下跳动。
 */
export function TranscriptUtilityRail({
  railRef,
  onPointerDown,
  topSlot,
  minimap,
  navDock,
  className = 'pointer-events-auto flex min-h-0 w-14 flex-1 flex-col items-center gap-2',
}: TranscriptUtilityRailProps) {
  return (
    <aside
      ref={railRef}
      className={className}
      aria-label="对话功能区"
      onPointerDown={onPointerDown}
    >
      {topSlot}
      <div className="pointer-events-none flex min-h-0 w-full flex-1 items-center justify-center">
        {minimap}
      </div>
      <div className="pointer-events-none mt-auto flex h-[132px] w-full shrink-0 flex-col items-center justify-end">
        {navDock}
      </div>
    </aside>
  )
}

export function ChatComposerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-t border-line/40 bg-transparent px-3 py-2.5">
      <div className="w-full rounded-xl border border-line/70 bg-bg-card shadow-[inset_0_1px_0_rgba(255,250,232,0.65),0_2px_8px_rgba(45,34,22,0.08)]">{children}</div>
    </div>
  )
}
