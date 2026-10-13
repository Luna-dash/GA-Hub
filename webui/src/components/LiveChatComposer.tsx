import { useCallback } from 'react'
import { ImagePasteInput } from './ImagePasteInput'
import type { PasteAttachment } from '@/api/types'
import type { SlashCommand } from './slashCommands'
import { useDraftStore } from '@/stores/draftStore'
import { useChatStore } from '@/stores/chatStore'

const EMPTY_ATTACHMENTS: PasteAttachment[] = []

export interface LiveChatDraftSnapshot {
  draftKey: string
  text: string
  attachments: PasteAttachment[]
}

interface LiveChatComposerProps {
  draftKey: string
  sessionId?: string
  onSubmit: (draft: LiveChatDraftSnapshot) => void
  onSchedule?: () => void
  onStop?: () => void
  stopActive?: boolean
  onSlashCommand?: (
    command: Exclude<SlashCommand['name'], '/btw'>,
    draft: LiveChatDraftSnapshot,
  ) => void
  placeholder?: string
  disabled?: boolean
  submitDisabled?: boolean
}

/** Read a stable event-time snapshot without subscribing the page container. */
export function readLiveChatDraftSnapshot(draftKey: string): LiveChatDraftSnapshot {
  const drafts = useDraftStore.getState()
  return {
    draftKey,
    text: drafts.texts[draftKey] ?? '',
    attachments: [...(drafts.attachments[draftKey] ?? EMPTY_ATTACHMENTS)],
  }
}

/**
 * Owns the high-frequency draft subscription. Typing and attachment changes
 * update this leaf without re-rendering LiveChat's transcript or page chrome.
 */
export function LiveChatComposer({
  draftKey,
  sessionId,
  onSubmit,
  onSchedule,
  onStop,
  stopActive,
  onSlashCommand,
  placeholder,
  disabled,
  submitDisabled,
}: LiveChatComposerProps) {
  const text = useDraftStore((state) => state.texts[draftKey] ?? '')
  const attachments = useDraftStore((state) => state.attachments[draftKey] ?? EMPTY_ATTACHMENTS)
  const submissions = useDraftStore((state) => state.submissions)
  const pending = Object.values(submissions).filter((item) => item.key === draftKey)
  const recovery = pending.filter((item) => item.status !== 'sending')
  const submitting = pending.some((item) => item.status !== 'failed')
  const setText = useCallback(
    (value: string) => useDraftStore.getState().setText(draftKey, value),
    [draftKey],
  )
  const setAttachments = useCallback(
    (value: PasteAttachment[]) => useDraftStore.getState().setAttachments(draftKey, value),
    [draftKey],
  )

  return (
    <div className="shrink-0 border-t border-line/40 bg-transparent px-3 py-2.5">
      <div className="w-full rounded-xl border border-line/60 bg-bg-card shadow-sm">
        <ImagePasteInput
          btwSessionId={sessionId}
          text={text}
          onText={setText}
          attachments={attachments}
          onAttachments={setAttachments}
          onSubmit={() => onSubmit(readLiveChatDraftSnapshot(draftKey))}
          onSchedule={onSchedule}
          onStop={onStop}
          stopActive={stopActive}
          onSlashCommand={onSlashCommand
            ? (command) => onSlashCommand(command, readLiveChatDraftSnapshot(draftKey))
            : undefined}
          placeholder={placeholder}
          disabled={disabled}
          submitDisabled={submitDisabled || submitting}
        />
        {pending.some((item) => item.status === 'sending') && (
          <span role="status" className="sr-only">发送中…</span>
        )}
        {recovery.map((item) => (
          <div key={item.id} role="status" className="flex items-center gap-2 px-3 pb-2 text-xs text-text-muted">
            <span>{item.status === 'uncertain'
              ? '发送状态未确认，请先核对对话，避免重复发送。'
              : '未发送内容已保留；当前草稿不会被覆盖。'}</span>
            <button
              type="button"
              className="shrink-0 text-accent disabled:opacity-40"
              disabled={disabled || text !== '' || attachments.length > 0}
              onClick={() => {
                if (useDraftStore.getState().restoreSubmission(item.id) && item.stageId) {
                  useChatStore.getState().rollbackWebui(item.stageId)
                }
              }}
            >恢复未发送内容</button>
          </div>
        ))}
      </div>
    </div>
  )
}
