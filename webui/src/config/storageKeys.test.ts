// Static gate mirroring server tests/test_env_registry.py: browser-storage
// access must go through config/storageKeys.ts. A bare string key here would
// silently bypass the registry and collide with an unregistered name.
//
// Sources are loaded raw via import.meta.glob so this stays inside the app
// TypeScript program (no node:fs / __dirname).
import { describe, expect, it } from 'vitest'

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
