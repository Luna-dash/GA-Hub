// @vitest-environment jsdom

import { act, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { markdownRender } = vi.hoisted(() => ({
  markdownRender: vi.fn(({ children }: { children?: string }) => <div>{children}</div>),
}))

vi.mock('./MarkdownView', () => ({
  MarkdownView: markdownRender,
}))

import { MessageBubble } from './MessageBubble'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  const [unrelated, setUnrelated] = useState(0)
  return (
    <div>
      <button onClick={() => setUnrelated((value) => value + 1)}>refresh {unrelated}</button>
      <MessageBubble role="assistant" content="stable old message" streaming={false} />
    </div>
  )
}

function StreamingSiblingHarness() {
  const [chunk, setChunk] = useState('first chunk')
  const rewind = useCallback(() => undefined, [])
  return (
    <div>
      <button onClick={() => setChunk('first chunk plus second chunk')}>append chunk</button>
      <MessageBubble role="assistant" content="completed history" streaming={false} onRewind={rewind} />
      <MessageBubble role="assistant" content={chunk} streaming onRewind={rewind} />
    </div>
  )
}

describe('MessageBubble render isolation', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    markdownRender.mockClear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('does not rebuild a static markdown subtree for an unrelated parent update', () => {
    act(() => root.render(<Harness />))
    expect(markdownRender).toHaveBeenCalledTimes(1)

    act(() => (host.querySelector('button') as HTMLButtonElement).click())

    expect(host.textContent).toContain('refresh 1')
    expect(markdownRender).toHaveBeenCalledTimes(1)
  })

  it('only rebuilds the active bubble when a streaming sibling receives a chunk', () => {
    act(() => root.render(<StreamingSiblingHarness />))
    expect(markdownRender).toHaveBeenCalledTimes(2)

    act(() => (host.querySelector('button') as HTMLButtonElement).click())

    expect(host.textContent).toContain('first chunk plus second chunk')
    expect(markdownRender).toHaveBeenCalledTimes(3)
    expect(markdownRender.mock.calls.filter(([props]) => props.children === 'completed history')).toHaveLength(1)
  })

  it('keeps a failed assistant notice shrinkable inside a narrow chat column', () => {
    const detail = `_运行错误（stream_error）：${'AttributeError'.repeat(30)}_`
    act(() => root.render(<MessageBubble role="assistant" content={detail} streaming={false} />))

    const card = host.querySelector('div.relative')
    const content = card?.lastElementChild

    expect(content?.classList.contains('min-w-0')).toBe(true)
    expect(content?.classList.contains('max-w-full')).toBe(true)
    expect(card?.classList.contains('min-w-0')).toBe(true)
    expect(card?.classList.contains('max-w-full')).toBe(true)
  })

  it('defers full Markdown parsing when the extracted final answer is very large', () => {
    const content = 'x'.repeat(70_000)
    act(() => root.render(
      <MessageBubble role="assistant" content={content} streaming={false} />,
    ))

    expect(markdownRender.mock.calls.at(-1)?.[0].children).toHaveLength(20_001)
    expect(host.textContent).toContain('最终回答较长，展开完整内容')

    const expandButton = Array.from(host.querySelectorAll('button'))
      .find(button => button.textContent?.includes('最终回答较长'))
    expect(expandButton).toBeDefined()
    act(() => expandButton!.click())

    expect(markdownRender.mock.calls.at(-1)?.[0].children).toBe(content)
  })

  it('shows the final answer beyond a long tool trace and lazily renders raw turns', () => {
    const rawOutput = `RAW_TOOL_OUTPUT_${'x'.repeat(65_000)}`
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>读取并检查项目文件</summary>',
      '🛠️ code_run({"script":"inspect"})',
      '`````',
      rawOutput,
      '`````',
      '**LLM Running (Turn 2) ...**',
      '<summary>整理结论</summary>',
      '## 可读的最终回答',
      '',
      '问题已经定位并处理。',
      '[Info] Final response to user.',
    ].join('\n')

    act(() => root.render(
      <MessageBubble role="assistant" content={content} streaming={false} />,
    ))

    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toBe('## 可读的最终回答\n\n问题已经定位并处理。')
    expect(host.textContent).toContain('可读的最终回答')
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).toContain('共 2 个 Turn')
    expect(host.textContent).not.toContain('读取并检查项目文件')
    expect(host.textContent).not.toContain('整理结论')
    expect(host.textContent).not.toContain('RAW_TOOL_OUTPUT_')

    const processButton = host.querySelector('button[aria-expanded="false"]') as HTMLButtonElement
    expect(processButton).toBeDefined()
    expect(processButton.parentElement?.nextElementSibling?.textContent).toContain('可读的最终回答')
    expect(markdownRender).toHaveBeenCalledTimes(1)
    act(() => processButton.click())

    expect(host.textContent).toContain('读取并检查项目文件')
    expect(host.textContent).toContain('整理结论')
    expect(processButton.getAttribute('aria-expanded')).toBe('true')
    expect(markdownRender).toHaveBeenCalledTimes(1)

    const firstTurn = host.querySelector('details') as HTMLDetailsElement
    act(() => {
      firstTurn.open = true
      firstTurn.dispatchEvent(new Event('toggle', { bubbles: true }))
    })

    expect(markdownRender).toHaveBeenCalledTimes(2)
    expect(markdownRender.mock.calls[1][0].children).toContain('RAW_TOOL_OUTPUT_')
  })

  it('uses the readable history projection for a multi-turn reply below the size limit', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>检查登录状态</summary>',
      '🛠️ code_run({"script":"inspect"})',
      '`````',
      'raw login state',
      '`````',
      '**LLM Running (Turn 2) ...**',
      '<summary>给出处理建议</summary>',
      '请先启用设备代码授权，然后重新登录。',
    ].join('\n')

    act(() => root.render(
      <MessageBubble role="assistant" content={content} streaming={false} />,
    ))

    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toBe('请先启用设备代码授权，然后重新登录。')
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).toContain('共 2 个 Turn')
    expect(host.textContent).not.toContain('raw login state')
  })

  it('keeps a discoverable process button for a simple single-turn archived answer', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>直接回答</summary>',
      '这是简短回答。',
    ].join('\n')

    act(() => root.render(
      <MessageBubble role="assistant" content={content} streaming={false} />,
    ))

    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toBe('这是简短回答。')
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).toContain('共 1 个 Turn')
  })

  it('shows an archived ask_user call as the final user-facing question', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>需要用户确认</summary>',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      '{"question":"请选择下一步。","candidates":["继续","暂停"]}',
      '````',
    ].join('\n')

    act(() => root.render(
      <MessageBubble role="assistant" content={content} streaming={false} />,
    ))

    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toContain('请选择下一步。')
    expect(markdownRender.mock.calls[0][0].children).toContain('- 继续')
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).toContain('共 1 个 Turn')
    expect(host.textContent).not.toContain('🛠️ Tool:')
  })

  it('keeps the process entry for a just-completed live reply and lazily renders its raw turn', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>中间步骤</summary>',
      'hidden tool trace',
      '**LLM Running (Turn 2) ...**',
      'visible answer',
    ].join('\n')

    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} />))

    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toContain('visible answer')
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).toContain('共 2 个 Turn')
    expect(host.textContent).not.toContain('中间步骤')

    const processButton = host.querySelector('button[aria-expanded="false"]') as HTMLButtonElement
    act(() => processButton.click())

    expect(host.textContent).toContain('中间步骤')
    expect(markdownRender).toHaveBeenCalledTimes(1)

    const folded = host.querySelector('details') as HTMLDetailsElement
    act(() => {
      folded.open = true
      folded.dispatchEvent(new Event('toggle', { bubbles: true }))
    })

    expect(markdownRender).toHaveBeenCalledTimes(2)
    expect(markdownRender.mock.calls[1][0].children).toContain('hidden tool trace')
  })
})
