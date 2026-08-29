// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMyKeyShowUpload,
  MYKEY_SHOW_UPLOAD_EVENT,
  MYKEY_SHOW_UPLOAD_KEY,
  setMyKeyShowUpload,
} from './mykeySyncUi'

describe('mykeySyncUi visibility flag', () => {
  beforeEach(() => {
    localStorage.removeItem(MYKEY_SHOW_UPLOAD_KEY)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to hidden when nothing is stored', () => {
    expect(getMyKeyShowUpload()).toBe(false)
  })

  it('persists and emits a change event with the new value', () => {
    const seen: boolean[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent<boolean>).detail)
    window.addEventListener(MYKEY_SHOW_UPLOAD_EVENT, listener)
    try {
      expect(setMyKeyShowUpload(true)).toBe(true)
      expect(localStorage.getItem(MYKEY_SHOW_UPLOAD_KEY)).toBe('1')
      expect(getMyKeyShowUpload()).toBe(true)

      expect(setMyKeyShowUpload(false)).toBe(false)
      expect(localStorage.getItem(MYKEY_SHOW_UPLOAD_KEY)).toBe('0')
      expect(getMyKeyShowUpload()).toBe(false)

      expect(seen).toEqual([true, false])
    } finally {
      window.removeEventListener(MYKEY_SHOW_UPLOAD_EVENT, listener)
    }
  })

  it('falls back to hidden when storage throws', () => {
    const getItem = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    try {
      expect(getMyKeyShowUpload()).toBe(false)
    } finally {
      Storage.prototype.getItem = getItem
    }
  })
})
