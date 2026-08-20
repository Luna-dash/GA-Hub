import { describe, expect, it } from 'vitest'
import {
  parseAssistantTranscript,
  stripAssistantTranscriptTags,
  stripFinalResponseMarker,
} from './assistantTranscript'

describe('assistant transcript projection', () => {
  it('extracts turn summaries and the user-facing final body', () => {
    const content = [
      '**LLM Running (Turn 1) ...**',
      '<summary>读取配置\n定位入口</summary>',
      '🛠️ Tool: `file_read`  📥 args:',
      '````text',
      '{"path":"config.json"}',
      '````',
      '`````',
      'raw tool output',
      '`````',
      '**LLM Running (Turn 2) ...**',
      '<summary>分析完成</summary>',
      '## 最终回答',
      '',
      '这里是面向用户的结论。',
      '`````',
      '[Info] Final response to user.',
      '`````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.turns).toHaveLength(2)
    expect(transcript.turns[0].summary).toBe('读取配置 · 定位入口')
    expect(transcript.turns[1].summary).toBe('分析完成')
    expect(transcript.finalBody).toBe('## 最终回答\n\n这里是面向用户的结论。')
    expect(transcript.finalBody).not.toContain('raw tool output')
  })

  it('does not treat a turn marker inside a tool-result fence as a real turn', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>运行工具</summary>',
      '🛠️ code_run({"script":"test"})',
      '`````',
      'LLM Running (Turn 99) ...',
      '`````',
      'LLM Running (Turn 2) ...',
      '<summary>完成</summary>',
      '最终结果',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.turns.map((turn) => turn.turn)).toEqual([1, 2])
    expect(transcript.finalBody).toBe('最终结果')
  })

  it('does not expose a tool-only result as a final answer', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>命令仍在执行</summary>',
      '🛠️ code_run({"script":"test"})',
      '`````',
      'unstructured command output',
      '`````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.finalBody).toBe('')
    expect(transcript.turns[0].content).toContain('unstructured command output')
  })

  it('treats ask_user as a readable final response', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>等待用户确认授权设置</summary>',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      JSON.stringify({
        question: '请先启用设备代码授权，然后告诉我结果。',
        candidates: ['已启用设备代码授权', '设置里找不到该开关'],
      }, null, 2),
      '````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.finalBody).toBe([
      '请先启用设备代码授权，然后告诉我结果。',
      '',
      '可选项：',
      '- 已启用设备代码授权',
      '- 设置里找不到该开关',
    ].join('\n'))
  })

  it('strips only the trailing final-response protocol marker', () => {
    const content = '正文中提到 [Info] Final response to user. 不应删除。\n[Info] Final response to user.'

    expect(stripFinalResponseMarker(content)).toBe('正文中提到 [Info] Final response to user. 不应删除。')
    expect(stripAssistantTranscriptTags('**LLM Running (Turn 3) ...**\n<summary>完成</summary>\n正文'))
      .toBe('正文')
  })
})
