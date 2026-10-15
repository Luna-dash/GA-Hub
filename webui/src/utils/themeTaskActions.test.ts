// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { storageKeys } from '@/config/storageKeys'
import { readRecentInstructions, writeRecentInstructions, readRunInstruction, themeFailureReason } from './themeTaskActions'
vi.mock('@/api/client', () => ({ api: { getSessionMessages: vi.fn() } }))
beforeEach(() => { localStorage.clear(); vi.resetAllMocks() })
it('keeps five unique trimmed instructions per session and allows clearing', () => {
  expect(writeRecentInstructions('a', ['  one ', 'two', 'one', '', '3', '4', '5', '6'])).toEqual(['one', 'two', '3', '4', '5'])
  expect(readRecentInstructions('b')).toEqual([])
  expect(readRecentInstructions('a')).toEqual(['one', 'two', '3', '4', '5'])
  writeRecentInstructions('a', []); expect(readRecentInstructions('a')).toEqual([])
})
it('ignores malformed browser storage', () => {
  localStorage.setItem(storageKeys.themeInstructionsPrefix + 'a', '{')
  expect(readRecentInstructions('a')).toEqual([])
  localStorage.setItem(storageKeys.themeInstructionsPrefix + 'a', '[null, 3, " ", "ok"]')
  expect(readRecentInstructions('a')).toEqual(['ok'])
})
it('paginates existing history and matches the user request by run id', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce({ session_id: 'a', archive_bound: true, items: [{ id: 'x', ordinal: 50, role: 'user', run_id: 'other', content: 'wrong' }], has_more: true, next_before: 50, revision: 'v' }).mockResolvedValueOnce({ session_id: 'a', archive_bound: true, items: [{ id: 'q', ordinal: 0, role: 'user', run_id: 'r', content: 'original\nrequest' }], has_more: false, revision: 'v' })
  expect(await readRunInstruction('a', 'r')).toBe('original\nrequest')
  expect(api.getSessionMessages).toHaveBeenLastCalledWith('a', { limit: 100, before: 50 })
})
it('rejects changed history rather than mixing generations', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce({ session_id: 'a', archive_bound: true, items: [], has_more: true, next_before: 20, revision: 'v1' }).mockResolvedValueOnce({ session_id: 'a', archive_bound: true, items: [{ id: 'q', ordinal: 0, role: 'user', run_id: 'r', content: 'old' }], has_more: false, revision: 'v2' })
  await expect(readRunInstruction('a', 'r')).rejects.toThrow('历史已变化')
})
it('rejects a missing identity and a broken pagination cursor', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValue({ session_id: 'a', archive_bound: true, items: [], has_more: true, next_before: 20, revision: 'v' })
  await expect(readRunInstruction('a', 'missing')).rejects.toThrow('未在会话历史中找到')
  expect(api.getSessionMessages).toHaveBeenCalledTimes(2)
})
it('extracts explicit failure lines, not ordinary process text', () => {
  expect(themeFailureReason('tool output\n!!! Error: HTTP 503\n[Error] expired\nfinal prose')).toBe('!!! Error: HTTP 503\n[Error] expired')
  expect(themeFailureReason('normal result')).toBe('')
})
