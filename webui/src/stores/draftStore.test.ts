import { beforeEach, describe, expect, it } from 'vitest'
import type { PasteAttachment } from '@/api/types'
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
    useDraftStore.setState({ texts: {}, attachments: {}, revisions: {}, submissions: {} })
  })

  it('clears the submitted snapshot after a successful request', () => {
    const sent = [attachment('first.png')]
    useDraftStore.getState().setText('liveChat', 'hello')
    useDraftStore.getState().setAttachments('liveChat', sent)

    const cleared = useDraftStore.getState().clearDraftIfMatch('liveChat', 'hello', sent)

    expect(cleared).toBe(true)
    expect(useDraftStore.getState()).toMatchObject({ texts: {}, attachments: {}, revisions: {}, submissions: {} })
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


describe('draft submission transactions', () => {
  beforeEach(() => useDraftStore.setState({ texts: {}, attachments: {}, revisions: {}, submissions: {} }))
  const seed = () => {
    const store = useDraftStore.getState()
    const atts = [attachment('first.png')]
    store.setText('a', 'hello')
    store.setAttachments('a', atts)
    return store.beginSubmission('a', 'hello', atts)!
  }

  it('clears text and attachments synchronously and guards duplicate submissions', () => {
    const item = seed()
    const store = useDraftStore.getState()
    expect(store.texts.a ?? '').toBe('')
    expect(store.attachments.a ?? []).toEqual([])
    store.setText('a', 'next')
    expect(store.beginSubmission('a', 'next', [])).toBeNull()
    expect(store.submissions[item.id].attachments[0].path).toBe('first.png')
  })
  it('restores unchanged drafts and attachments on a definite failure', () => {
    const item = seed()
    expect(useDraftStore.getState().failSubmission(item.id)).toBe(true)
    expect(useDraftStore.getState().texts.a).toBe('hello')
    expect(useDraftStore.getState().attachments.a[0].path).toBe('first.png')
    expect(useDraftStore.getState().submissions).toEqual({})
  })
  it('never overwrites a newer draft and allows explicit recovery only when empty', () => {
    const item = seed()
    const store = useDraftStore.getState()
    store.setText('a', 'next')
    expect(store.failSubmission(item.id)).toBe(false)
    expect(store.restoreSubmission(item.id)).toBe(false)
    expect(useDraftStore.getState().texts.a).toBe('next')
    store.setText('a', '')
    expect(store.restoreSubmission(item.id)).toBe(true)
    expect(useDraftStore.getState().texts.a).toBe('hello')
  })
  it('does not auto restore after an edit-and-clear cycle', () => {
    const item = seed()
    const store = useDraftStore.getState()
    store.setText('a', 'next')
    store.setText('a', '')
    expect(store.failSubmission(item.id)).toBe(false)
    expect(useDraftStore.getState().texts.a).toBe('')
  })
  it('success leaves subsequent text and attachments untouched', () => {
    const item = seed()
    const store = useDraftStore.getState()
    store.setText('a', 'next')
    store.setAttachments('a', [attachment('second.png')])
    store.finishSubmission(item.id)
    expect(useDraftStore.getState().texts.a).toBe('next')
    expect(useDraftStore.getState().attachments.a[0].path).toBe('second.png')
  })
  it('uncertain delivery retains the snapshot without automatic restoration or resubmit', () => {
    const item = seed()
    const store = useDraftStore.getState()
    expect(store.failSubmission(item.id, true)).toBe(false)
    expect(useDraftStore.getState().texts.a ?? '').toBe('')
    store.setText('a', 'next')
    expect(store.beginSubmission('a', 'next', [])).toBeNull()
    store.bindSubmissionStage(item.id, 'receipt')
    store.acceptSubmissionStage('receipt')
    expect(useDraftStore.getState().submissions).toEqual({})
    expect(useDraftStore.getState().texts.a).toBe('next')
  })
  it('moves only the submitted snapshot when first-send creates a session', () => {
    const item = seed()
    const store = useDraftStore.getState()
    store.setText('a', 'next')
    store.moveSubmission(item.id, 'new')
    store.failSubmission(item.id)
    expect(useDraftStore.getState().texts.a).toBe('next')
    expect(useDraftStore.getState().texts.new).toBe('hello')
  })
})
