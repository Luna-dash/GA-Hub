import Markdown, { type Options } from 'react-markdown'
import type { ReactElement } from 'react'

interface CacheEntry {
  tree: ReactElement
  characters: number
}

const MAX_ENTRIES = 48
const MAX_SOURCE_CHARACTERS = 1_500_000
const MAX_SINGLE_ENTRY_CHARACTERS = 180_000
const cache = new Map<string, CacheEntry>()
let cachedCharacters = 0

/**
 * Cache the synchronous ReactMarkdown output tree for completed messages.
 * This matters once transcript virtualization unmounts off-screen rows: a row
 * can return without running the Markdown/remark/rehype pipeline again.
 */
export function renderMarkdownTree(
  namespace: string,
  source: string,
  options: Readonly<Options>,
  cacheable = true,
): ReactElement {
  if (!cacheable || source.length > MAX_SINGLE_ENTRY_CHARACTERS) {
    return Markdown(options)
  }

  const key = `${namespace}\u0000${source}`
  const cached = cache.get(key)
  if (cached) {
    // Map insertion order is the LRU order.
    cache.delete(key)
    cache.set(key, cached)
    return cached.tree
  }

  const tree = Markdown(options)
  const entry = { tree, characters: source.length }
  cache.set(key, entry)
  cachedCharacters += entry.characters
  trimMarkdownRenderCache()
  return tree
}

function trimMarkdownRenderCache(): void {
  while (cache.size > MAX_ENTRIES || cachedCharacters > MAX_SOURCE_CHARACTERS) {
    const oldest = cache.entries().next().value as [string, CacheEntry] | undefined
    if (!oldest) break
    cache.delete(oldest[0])
    cachedCharacters -= oldest[1].characters
  }
}

export function clearMarkdownRenderCache(): void {
  cache.clear()
  cachedCharacters = 0
}

export function markdownRenderCacheStats(): { entries: number; characters: number } {
  return { entries: cache.size, characters: cachedCharacters }
}
