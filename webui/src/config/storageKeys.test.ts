// Static gate mirroring server tests/test_env_registry.py: browser-storage
// access must go through config/storageKeys.ts. A bare string key here would
// silently bypass the registry and collide with an unregistered name.
//
// Sources are loaded raw via import.meta.glob so this stays inside the app
// TypeScript program (no node:fs / __dirname).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readThemeReportExpanded, storageKeys, writeThemeReportExpanded } from './storageKeys'

const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const LITERAL_STORAGE_ACCESS =
  /(localStorage|sessionStorage)\.(getItem|setItem|removeItem)\(\s*(['"`])/

describe('storage key registry gate', () => {
  it('keeps literal browser-storage keys out of non-registry sources', () => {
    const violations: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      const normalized = path.replace(/\\/g, '/')
      // Tests intentionally use literal keys to pin the registry contract.
      if (/\.test\.(ts|tsx)$/.test(normalized)) continue
      if (normalized.includes('config/storageKeys')) continue
      source.split('\n').forEach((line, index) => {
        if (LITERAL_STORAGE_ACCESS.test(line)) {
          violations.push(`${normalized}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  it('the registry itself defines every key with the documented prefixes', () => {
    // The glob pattern is relative to src/config, so keys are '../storageKeys.ts'.
    const registry = Object.entries(sources)
      .find(([path]) => path.replace(/\\/g, '/').endsWith('/storageKeys.ts'))?.[1]
    expect(registry).toBeTruthy()
    const values = [...registry!.matchAll(/^ {2}\w+: '([^']+)',?$/gm)].map((m) => m[1])
    expect(values.length).toBeGreaterThan(10)
    // Legacy prefixes are frozen history, documented on the registry.
    const allowed = ['gahub.', 'ga.', 'ga-admin.', 'ga-hub:']
    for (const value of values) {
      expect(
        allowed.some((prefix) => value.startsWith(prefix)),
        `unregistered-prefix key: ${value}`,
      ).toBe(true)
    }
  })
})

describe('theme report preference', () => {
  afterEach(() => vi.unstubAllGlobals())

  function fakeStorage(entries: Record<string, string> = {}) {
    const values = new Map(Object.entries(entries))
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    }
    vi.stubGlobal('localStorage', storage)
    return storage
  }

  it('defaults to expanded and writes the registered per-session key', () => {
    const storage = fakeStorage()
    expect(readThemeReportExpanded('one')).toBe(true)
    writeThemeReportExpanded('one', false)
    expect(storage.setItem).toHaveBeenCalledWith(storageKeys.themeReportPrefix + 'one', 'closed')
    expect(readThemeReportExpanded('one')).toBe(false)
    expect(readThemeReportExpanded('two')).toBe(true)
  })

  it('migrates old collapsed preferences without removing the old key', () => {
    const storage = fakeStorage({ 'theme-report:one': 'closed' })
    expect(readThemeReportExpanded('one')).toBe(false)
    expect(storage.setItem).toHaveBeenCalledWith(storageKeys.themeReportPrefix + 'one', 'closed')
    expect(storage.getItem('theme-report:one')).toBe('closed')
  })

  it('prefers a new value over a stale legacy value', () => {
    fakeStorage({ 'theme-report:one': 'closed', [storageKeys.themeReportPrefix + 'one']: 'open' })
    expect(readThemeReportExpanded('one')).toBe(true)
  })

  it('preserves legacy state if migration fails and tolerates blocked storage', () => {
    const storage = fakeStorage({ 'theme-report:one': 'closed' })
    storage.setItem.mockImplementation(() => { throw new Error('quota') })
    expect(readThemeReportExpanded('one')).toBe(false)
    expect(() => writeThemeReportExpanded('one', true)).not.toThrow()
    storage.getItem.mockImplementation(() => { throw new Error('blocked') })
    expect(readThemeReportExpanded('one')).toBe(true)
  })
})
