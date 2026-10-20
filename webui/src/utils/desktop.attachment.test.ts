// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { canReferenceLocalFiles } from './desktop'

afterEach(() => { delete window.__TAURI_INTERNALS__; delete window.__GA_HUB_RUNTIME__ })
it('allows native paths only for an authenticated local desktop backend', () => {
  expect(canReferenceLocalFiles()).toBe(false)
  window.__TAURI_INTERNALS__ = {}
  expect(canReferenceLocalFiles()).toBe(false)
  window.__GA_HUB_RUNTIME__ = { desktop: true, instanceToken: 'instance', apiOrigin: 'https://remote.example' }
  expect(canReferenceLocalFiles()).toBe(false)
  window.__GA_HUB_RUNTIME__ = { desktop: true, instanceToken: 'instance', apiOrigin: 'http://127.0.0.1:43123' }
  expect(canReferenceLocalFiles()).toBe(true)
})
