import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearMarkdownRenderCache,
  markdownRenderCacheStats,
  renderMarkdownTree,
} from './markdownRenderCache'

describe('Markdown render cache', () => {
  beforeEach(clearMarkdownRenderCache)

  it('reuses the parsed tree for a completed message', () => {
    const options = { children: '**stable**' }
    const first = renderMarkdownTree('chat', '**stable**', options)
    const second = renderMarkdownTree('chat', '**stable**', options)

    expect(second).toBe(first)
    expect(markdownRenderCacheStats()).toEqual({ entries: 1, characters: 10 })
  })

  it('keeps chat and plain pipelines isolated', () => {
    const source = '`tool output`'
    const chat = renderMarkdownTree('chat', source, { children: source })
    const plain = renderMarkdownTree('plain', source, { children: source })

    expect(plain).not.toBe(chat)
    expect(markdownRenderCacheStats().entries).toBe(2)
  })

  it('does not retain streaming or exceptionally large sources', () => {
    renderMarkdownTree('chat', 'streaming', { children: 'streaming' }, false)
    const large = 'x'.repeat(180_001)
    renderMarkdownTree('chat', large, { children: large })

    expect(markdownRenderCacheStats()).toEqual({ entries: 0, characters: 0 })
  })
})
