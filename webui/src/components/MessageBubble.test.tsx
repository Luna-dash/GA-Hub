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
import { useDraftStore } from '@/stores/draftStore'

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
    useDraftStore.setState({ texts: {}, attachments: {} })
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

  it('shows an archived ask_user call as an interactive picker card', () => {
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

    // 问题由 AskUserCard 渲染（结论区不再输出文本形式），候选为可点击按钮
    const card = host.querySelector('[data-ask-user-card]')
    expect(card).toBeTruthy()
    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toBe('请选择下一步。')
    const optionTexts = [...card!.querySelectorAll('button')].map((button) => button.textContent)
    expect(optionTexts.some((text) => text?.includes('继续'))).toBe(true)
    expect(optionTexts.some((text) => text?.includes('暂停'))).toBe(true)
    expect(host.textContent).toContain('点击选项将填入输入框')
    expect(host.textContent).not.toContain('查看执行过程')
    expect(host.textContent).not.toContain('共 1 个 Turn')
    expect(host.textContent).not.toContain('🛠️ Tool:')
  })

  it('fills the composer draft when a picker option is clicked', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>需要用户确认</summary>',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      '{"question":"请选择下一步。","candidates":["继续","暂停"]}',
      '````',
    ].join('\n')

    act(() => root.render(
      <MessageBubble
        role="assistant"
        content={content}
        streaming={false}
        askUserDraftKey="liveChat:s1"
      />,
    ))

    const card = host.querySelector('[data-ask-user-card]')!
    const option = [...card.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('暂停'))!
    act(() => option.click())

    expect(useDraftStore.getState().texts['liveChat:s1']).toBe('暂停')
    const picked = [...card.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('暂停'))!
    expect(picked.textContent).toContain('已填入')
  })

  it('copies only the conclusion, not the whole process, from a multi-turn card', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    ;(navigator as unknown as { clipboard: { writeText: (t: string) => Promise<void> } }).clipboard = { writeText }
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>执行搜索</summary>',
      '🛠️ Tool: `code_run`  📥 args:',
      '````text',
      '{"cmd":"grep -r foo"}',
      '````',
      '**LLM Running (Turn 2) ...**',
      '<summary>得出结论</summary>',
      '## 最终结论\n\n迁移已完成，共 7 个文件。',
    ].join('\n')

    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} />))
    const copyButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '复制')
    await act(async () => { copyButton?.click(); await Promise.resolve() })

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('## 最终结论')
    expect(copied).not.toContain('🛠️ Tool:')
    expect(copied).not.toContain('执行搜索')
  })

  it('marks system-role bubbles with the left-edge dot and no GA Agent header', () => {
    act(() => root.render(
      <MessageBubble role="system" content="GA-Hub 已重新连接会话。" streaming={false} />,
    ))

    // 2026-09 user ruling: the in-bubble "• system" header row duplicated the
    // dot marker, so system bubbles carry no header text at all.
    expect(host.textContent).not.toContain('GA Agent')
    expect(host.textContent).not.toContain('system')
    expect(host.querySelector('[data-system-dot]')).toBeTruthy()
  })

  it('uses the last summary as the stopped conclusion and ends with the stop notice', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>得出结论</summary>',
      '## 结论\n\n已完成迁移。',
      '**LLM Running (Turn 2) ...**',
      '<summary>执行清理命令</summary>',
      '🛠️ Tool: `code_run`  📥 args:',
      '````text',
      '{"command":"rm -rf temp"}',
      '````',
    ].join('\n')

    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} />))

    // 停止态统一：正文=被截止轮的最后一条有效 summary；不再回落上一轮完整正文
    expect(host.textContent).toContain('⏹任务中止')
    expect(host.textContent).not.toContain('以下为上一轮的完整结论')
    expect(host.textContent).not.toContain('已完成迁移。')
    expect(markdownRender.mock.calls[0][0].children).toBe('执行清理命令')
    // 提示行置于最后（在正文之后）
    const text = host.textContent || ''
    expect(text.indexOf('执行清理命令')).toBeLessThan(text.indexOf('⏹任务中止'))
    // 悬空轮留在折叠里，不顶掉结论
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).not.toContain('该条历史回复未包含可提取的最终回答')
  })

  it('renders a tool-only archived reply with its summary as the stopped conclusion', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>命令仍在执行</summary>',
      '🛠️ code_run({"script":"test"})',
      '`````',
      'unstructured command output',
      '`````',
    ].join('\n')

    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} />))

    expect(host.textContent).toContain('⏹任务中止')
    // 该轮摘要作为"被打断时在做什么"的上下文兜底展示
    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toBe('命令仍在执行')
    // 过程仍可展开
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).not.toContain('该条历史回复未包含可提取的最终回答')
  })

  it('renders the same stop notice whether the stop fact is present or the heuristic fires', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>执行清理命令</summary>',
      '🛠️ Tool: `code_run`  📥 args:',
      '````text',
      '{"command":"rm -rf temp"}',
      '````',
    ].join('\n')

    // 停止事实在位（当场，abort 事件）：正文=该轮 summary，提示行统一置尾
    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} stopped />))
    expect(host.textContent).toContain('⏹任务中止')
    expect(markdownRender.mock.calls[0][0].children).toBe('执行清理命令')

    // 无事实位（事后重载/轮询/进程重启）：启发式触发同一条提示行，呈现完全一致
    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} />))
    expect(host.textContent).toContain('⏹任务中止')
    expect(host.textContent).not.toContain('已手动停止')
    expect(host.textContent).not.toContain('本轮以工具调用收尾')
  })

  it('keeps a manual stop with a complete conclusion intact and appends the stop notice', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>给出结论</summary>',
      '## 结论\n\n已完成。',
      '**LLM Running (Turn 2) ...**',
      '<summary>补充说明</summary>',
      '结论保持有效，无需进一步操作。',
    ].join('\n')

    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} stopped />))
    // 尾轮正文完整：正文保留（不换成摘要），提示行统一追加在最后
    expect(host.textContent).toContain('⏹任务中止')
    expect(host.textContent).not.toContain('以下为上一轮的完整结论')
    expect(markdownRender.mock.calls.at(-1)?.[0].children).toContain('结论保持有效')
  })

  it('shows the live-path stop notice below the content for a short stopped reply without turn markers', () => {
    // 短内容 + 无 turn 标记 → 不走投影分支，直播路径同样以"⏹任务中止"收尾
    act(() => root.render(<MessageBubble role="assistant" content="先想一下" streaming={false} stopped />))
    expect(host.textContent).toContain('⏹任务中止')
    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toBe('先想一下')
    // 提示行位于内容之后（末尾）
    const text = host.textContent || ''
    expect(text.indexOf('先想一下')).toBeLessThan(text.indexOf('⏹任务中止'))
  })

  it('hides the conclusion body when a stopped reply has no summary at all', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '🛠️ Tool: `code_run`  📥 args:',
      '````text',
      '{"command":"rm -rf temp"}',
      '````',
    ].join('\n')

    act(() => root.render(<MessageBubble role="assistant" content={content} streaming={false} />))
    // 无有效 summary：正文不展示，仅保留过程折叠与停止提示行
    expect(host.textContent).toContain('⏹任务中止')
    expect(markdownRender).not.toHaveBeenCalled()
    expect(host.textContent).toContain('查看执行过程')
    expect(host.textContent).not.toContain('该条历史回复未包含可提取的最终回答')
  })

  it('renders source tags as a label line instead of content prefix', () => {
    act(() => root.render(
      <MessageBubble role="assistant" content="正文保持纯净。" streaming={false} tagLabel="🔁 [自动继续]" />,
    ))
    expect(host.textContent).toContain('🔁 [自动继续]')
    // content 本体不再携带标签前缀
    expect(markdownRender.mock.calls[0][0].children).toBe('正文保持纯净。')
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
