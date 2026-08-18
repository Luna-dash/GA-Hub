import { useCallback } from 'react'
import { ImagePasteInput, type PasteAttachment } from './ImagePasteInput'
import type { SlashCommand } from './slashCommands'
import { useDraftStore } from '@/stores/draftStore'

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
          submitDisabled={submitDisabled}
        />
      </div>
    </div>
  )
}
