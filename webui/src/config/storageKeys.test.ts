/// <reference types="vitest" />
// @vitest-environment node
// Static gate mirroring server tests/test_env_registry.py: browser-storage
// access must go through config/storageKeys.ts. A bare string key here would
// silently bypass the registry and collide with an unregistered name.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function listSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue
      out.push(...listSources(full))
    } else if (/\.(tsx?|css)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

// Storage access with a literal key. `storage.` registry reads and dynamic
// accesses via variables are fine; a quoted key means an unregistered name.
const LITERAL_STORAGE_ACCESS =
  /(localStorage|sessionStorage)\.(getItem|setItem|removeItem|setItem)\(\s*(['"`])/

describe('storage key registry gate', () => {
  it('keeps literal browser-storage keys out of non-registry sources', () => {
    const srcDir = join(__dirname, '..')
    const violations: string[] = []
    for (const file of listSources(srcDir)) {
      if (file.replace(/\\/g, '/').includes('config/storageKeys')) continue
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((line, index) => {
        if (/(localStorage|sessionStorage)\.(getItem|setItem|removeItem)\(\s*['"`]/.test(line)) {
          violations.push(`${file.replace(/\\/g, '/')}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  it('the registry itself defines every key with the documented prefixes', () => {
    const registry = readFileSync(join(__dirname, 'storageKeys.ts'), 'utf-8')
    const values = [...registry.matchAll(/^ {2}\w+: '([^']+)',?$/gm)].map((m) => m[1])
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
