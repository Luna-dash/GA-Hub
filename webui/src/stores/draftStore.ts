import { create } from 'zustand'
import type { PasteAttachment } from '@/components/ImagePasteInput'

interface DraftState {
  texts: Record<string, string>
  attachments: Record<string, PasteAttachment[]>
  setText: (key: string, text: string) => void
  setAttachments: (key: string, attachments: PasteAttachment[]) => void
  clearDraft: (key: string) => void
}

export const useDraftStore = create<DraftState>((set) => ({
  texts: {},
  attachments: {},
  setText: (key, text) => set((state) => ({ texts: { ...state.texts, [key]: text } })),
  setAttachments: (key, attachments) => set((state) => ({ attachments: { ...state.attachments, [key]: attachments } })),
  clearDraft: (key) => set((state) => {
    const texts = { ...state.texts }
    const attachments = { ...state.attachments }
    delete texts[key]
    delete attachments[key]
    return { texts, attachments }
  }),
}))
