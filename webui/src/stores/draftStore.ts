import { create } from 'zustand'
import type { PasteAttachment } from '@/api/types'

export interface DraftSubmission {
  id: number
  key: string
  text: string
  attachments: PasteAttachment[]
  clearedRevision: number
  stageId?: string
  status: 'sending' | 'failed' | 'uncertain'
}

interface DraftState {
  texts: Record<string, string>
  attachments: Record<string, PasteAttachment[]>
  revisions: Record<string, number>
  submissions: Record<number, DraftSubmission>
  setText: (key: string, text: string) => void
  setAttachments: (key: string, attachments: PasteAttachment[]) => void
  clearDraft: (key: string) => void
  clearDraftIfMatch: (key: string, text: string, attachments: PasteAttachment[]) => boolean
  beginSubmission: (key: string, text: string, attachments: PasteAttachment[]) => DraftSubmission | null
  moveSubmission: (id: number, key: string) => void
  bindSubmissionStage: (id: number, stageId: string) => void
  acceptSubmissionStage: (stageId: string) => void
  finishSubmission: (id: number) => void
  failSubmission: (id: number, uncertain?: boolean) => boolean
  restoreSubmission: (id: number) => boolean
}

let submissionSequence = 0
const matches = (state: DraftState, key: string, text: string, attachments: PasteAttachment[]) =>
  (state.texts[key] ?? '') === text
  && (state.attachments[key] ?? []).length === attachments.length
  && (state.attachments[key] ?? []).every((item, index) => item.path === attachments[index]?.path)

export const useDraftStore = create<DraftState>((set, get) => ({
  texts: {},
  attachments: {},
  revisions: {},
  submissions: {},
  setText: (key, text) => set((state) => ({
    texts: { ...state.texts, [key]: text },
    revisions: { ...state.revisions, [key]: (state.revisions[key] ?? 0) + 1 },
  })),
  setAttachments: (key, attachments) => set((state) => ({
    attachments: { ...state.attachments, [key]: attachments },
    revisions: { ...state.revisions, [key]: (state.revisions[key] ?? 0) + 1 },
  })),
  clearDraft: (key) => set((state) => {
    const texts = { ...state.texts }
    const attachments = { ...state.attachments }
    delete texts[key]
    delete attachments[key]
    return { texts, attachments, revisions: { ...state.revisions, [key]: (state.revisions[key] ?? 0) + 1 } }
  }),
  clearDraftIfMatch: (key, text, attachments) => {
    if (!matches(get(), key, text, attachments)) return false
    get().clearDraft(key)
    return true
  },
  beginSubmission: (key, text, attachments) => {
    const state = get()
    if (!matches(state, key, text, attachments)) return null
    // Synchronous lock also protects double-click/Enter before React re-renders.
    if (Object.values(state.submissions).some((item) => item.key === key && item.status !== 'failed')) return null
    const transaction: DraftSubmission = {
      id: ++submissionSequence, key, text,
      attachments: attachments.map((item) => ({ ...item })),
      clearedRevision: (state.revisions[key] ?? 0) + 1,
      status: 'sending',
    }
    set((current) => {
      const texts = { ...current.texts }
      const nextAttachments = { ...current.attachments }
      delete texts[key]
      delete nextAttachments[key]
      return {
        texts, attachments: nextAttachments,
        revisions: { ...current.revisions, [key]: transaction.clearedRevision },
        submissions: { ...current.submissions, [transaction.id]: transaction },
      }
    })
    return transaction
  },
  moveSubmission: (id, key) => set((state) => {
    const item = state.submissions[id]
    if (!item) return state
    // No draft migration: a newer draft stays at its original key. The sent
    // snapshot alone follows the newly created session for failure recovery.
    return { submissions: { ...state.submissions, [id]: {
      ...item, key, clearedRevision: state.revisions[key] ?? 0,
    } } }
  }),
  bindSubmissionStage: (id, stageId) => set((state) => {
    const item = state.submissions[id]
    return item ? { submissions: { ...state.submissions, [id]: { ...item, stageId } } } : state
  }),
  acceptSubmissionStage: (stageId) => {
    const item = Object.values(get().submissions).find((entry) => entry.stageId === stageId)
    if (item) get().finishSubmission(item.id)
  },
  finishSubmission: (id) => set((state) => {
    const submissions = { ...state.submissions }
    delete submissions[id]
    return { submissions }
  }),
  failSubmission: (id, uncertain = false) => {
    const item = get().submissions[id]
    if (!item) return false
    set((state) => ({ submissions: {
      ...state.submissions, [id]: { ...item, status: uncertain ? 'uncertain' : 'failed' },
    } }))
    // A changed-then-emptied draft is still a new revision. Do not clobber it.
    if (uncertain || (get().revisions[item.key] ?? 0) !== item.clearedRevision) return false
    return get().restoreSubmission(id)
  },
  restoreSubmission: (id) => {
    const state = get()
    const item = state.submissions[id]
    if (!item || item.status === 'sending' || (state.texts[item.key] ?? '') !== ''
      || (state.attachments[item.key] ?? []).length !== 0) return false
    set((current) => {
      const submissions = { ...current.submissions }
      delete submissions[id]
      return {
        texts: { ...current.texts, [item.key]: item.text },
        attachments: { ...current.attachments, [item.key]: item.attachments },
        revisions: { ...current.revisions, [item.key]: (current.revisions[item.key] ?? 0) + 1 },
        submissions,
      }
    })
    return true
  },
}))
