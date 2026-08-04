import { beforeEach, describe, expect, it } from 'vitest'
import type { PasteAttachment } from '@/components/ImagePasteInput'
import { useDraftStore } from './draftStore'

const attachment = (path: string): PasteAttachment => ({
  file_id: path,
  path,
  name: path.split('/').pop() || path,
  url: `/api/uploads/${path}`,
  mime: 'image/png',
  size: 1,
})

describe('draftStore conditional clearing', () => {
  beforeEach(() => {
    useDraftStore.setState({ texts: {}, attachments: {} })
  })

  it('clears the submitted snapshot after a successful request', () => {
    const sent = [attachment('first.png')]
    useDraftStore.getState().setText('liveChat', 'hello')
    useDraftStore.getState().setAttachments('liveChat', sent)

    const cleared = useDraftStore.getState().clearDraftIfMatch('liveChat', 'hello', sent)

    expect(cleared).toBe(true)
    expect(useDraftStore.getState()).toMatchObject({ texts: {}, attachments: {} })
  })

  it('preserves a newer draft when an older request finishes late', () => {
    const sent = [attachment('first.png')]
    const newer = [attachment('second.png')]
    useDraftStore.getState().setText('liveChat', 'hello')
    useDraftStore.getState().setAttachments('liveChat', sent)
    useDraftStore.getState().setText('liveChat', 'new thought')
    useDraftStore.getState().setAttachments('liveChat', newer)

    const cleared = useDraftStore.getState().clearDraftIfMatch('liveChat', 'hello', sent)

    expect(cleared).toBe(false)
    expect(useDraftStore.getState().texts.liveChat).toBe('new thought')
    expect(useDraftStore.getState().attachments.liveChat).toEqual(newer)
  })

  it('isolates text and attachments by session draft key', () => {
    const first = [attachment('first.png')]
    const second = [attachment('second.png')]
    useDraftStore.getState().setText('liveChat:session-a', 'draft a')
    useDraftStore.getState().setAttachments('liveChat:session-a', first)
    useDraftStore.getState().setText('liveChat:session-b', 'draft b')
    useDraftStore.getState().setAttachments('liveChat:session-b', second)

    useDraftStore.getState().clearDraft('liveChat:session-a')

    expect(useDraftStore.getState().texts).toEqual({ 'liveChat:session-b': 'draft b' })
    expect(useDraftStore.getState().attachments).toEqual({ 'liveChat:session-b': second })
  })
})
