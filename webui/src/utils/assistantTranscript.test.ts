import { describe, expect, it } from 'vitest'
import {
  parseAssistantTranscript,
  renderAskUserPayload,
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
    expect(transcript.finalTurnIndex).toBeNull()
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

  it('preserves interior code fences in the projected final body', () => {
    // 回归（ga更新任务 目录树）：全局剥壳正则曾把结论里的 ```text 围栏
    // 吃掉，树状图退化成一段合并文本。原始内容直出后必须原样保留。
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>拟写迁移方案</summary>',
      '## 建议的清理结果',
      '',
      '```text',
      'memory/',
      '├─ gahub_sop.md   # 保留',
      'temp/',
      '└─ plan.md',
      '```',
      '',
      '是否确认？',
    ].join('\n')

    const { finalBody } = parseAssistantTranscript(content)

    expect(finalBody).toContain('```text')
    expect(finalBody).toContain('├─ gahub_sop.md')
    expect(finalBody).toContain('是否确认？')
  })

  it('treats a tool-only final turn as a stopped dangling tail', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>命令仍在执行</summary>',
      '🛠️ code_run({"script":"test"})',
      '`````',
      'unstructured command output',
      '`````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    // 停止按钮截断的形状：LLM 尾巴不会写入存档 → 不拿过程凑结论
    expect(transcript.stopped).toBe(true)
    expect(transcript.finalBody).toBe('')
    // 原始过程保留在折叠列表里
    expect(transcript.turns[0].content).toContain('unstructured command output')
  })

  it('falls back to the previous conclusion when the tail turn dangles after a stop', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>得出结论</summary>',
      '## 结论\n\n已完成迁移。',
      'LLM Running (Turn 2) ...',
      '<summary>执行清理命令</summary>',
      '🛠️ Tool: `code_run`  📥 args:',
      '````text',
      '{"command":"rm -rf temp"}',
      '````',
      '`````',
      '部分输出…',
      '`````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.stopped).toBe(true)
    expect(transcript.finalBody).toBe('## 结论\n\n已完成迁移。')
    expect(transcript.finalTurnIndex).toBeNull()
    // 悬空轮留在折叠列表（2 个 turn 都在，只有结论轮被排除显示）
    expect(transcript.turns).toHaveLength(2)
  })

  it('does not treat an ask_user tail as a dangling stop', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>等待确认</summary>',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      JSON.stringify({ question: '继续吗？', candidates: ['继续'] }),
      '````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.stopped).toBe(false)
    expect(transcript.finalTurnIndex).toBe(0)
    expect(transcript.finalAskUser).toEqual({ question: '继续吗？', candidates: ['继续'] })
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

    expect(transcript.finalAskUser).toEqual({
      question: '请先启用设备代码授权，然后告诉我结果。',
      candidates: ['已启用设备代码授权', '设置里找不到该开关'],
    })
    // 有候选的 ask_user 由 AskUserCard 接管：正文挖空
    expect(transcript.finalBody).toBe('')
    expect(transcript.finalTurnIndex).toBe(0)
  })

  it('marks the final ask_user turn without hiding earlier execution turns', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>先做检查</summary>',
      '检查完成',
      'LLM Running (Turn 2) ...',
      '<summary>等待用户确认</summary>',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      JSON.stringify({ question: '是否继续？', candidates: ['继续', '暂停'] }),
      '````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.finalTurnIndex).toBe(1)
    expect(transcript.finalAskUser?.question).toBe('是否继续？')
    expect(transcript.finalAskUser?.candidates).toEqual(['继续', '暂停'])
    // 最终轮只剩 ask_user：正文为空，卡片独承内容
    expect(transcript.finalBody).toBe('')
  })

  it('parses real GA ask_user args whose strings hold raw newlines', () => {
    // GA dumps args pretty-printed WITHOUT escaping the newlines inside
    // string values; strict JSON.parse rejects them, so the lenient field
    // scanner must recover the question (regression from a live archive).
    const content = [
      'LLM Running (Turn 14) ...',
      '<summary>方案文档已交付，向用户汇报并请求关键取舍确认</summary>',
      '',
      '方案已完成，全文在 `./l4_archive_proposal.md`。',
      '',
      '几个取舍需要你拍板：',
      '',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      '{',
      '  "candidates": [',
      '    "认可默认值",',
      '    "两项都改"',
      '  ],',
      '  "question": "1. 阈值认可默认值吗？MIN_TURNS=5？',
      '2. 丢弃策略：quarantine 回收站还是直接物理删？',
      '3. 授权移除 scheduler.py 里的 {隐藏 cron} 块吗？"',
      '}',
      '````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.finalTurnIndex).toBe(0)
    expect(transcript.finalAskUser?.question).toContain('1. 阈值认可默认值吗？MIN_TURNS=5？')
    expect(transcript.finalAskUser?.question).toContain('2. 丢弃策略：quarantine 回收站还是直接物理删？')
    expect(transcript.finalAskUser?.candidates).toEqual(['认可默认值', '两项都改'])
    // 问题前的说明正文保留，工具转储被挖掉
    expect(transcript.finalBody).toContain('方案已完成，全文在 `./l4_archive_proposal.md`。')
    expect(transcript.finalBody).not.toContain('🛠️ Tool:')
  })

  it('keeps the conclusion prose when the final turn carries both prose and ask_user', () => {
    // 回归（ga更新任务 会话 turn6）：最终 turn = 结论正文 + ask_user，
    // 旧逻辑把整个 turn 替换成问题文本，结论消失，折叠里只剩 turn5 摘要。
    const content = [
      '**LLM Running (Turn 5) ...**',
      '<summary>最新model_responses文件其实是本会话自身日志，不能作peer证据</summary>',
      '🛠️ Tool: `code_run`  📥 args:',
      '````text',
      '{"cwd": "D:\\\\study\\\\GA", "code": "print(1)"}',
      '````',
      '`````',
      '{"status": "success", "stdout": "ok"}',
      '`````',
      '**LLM Running (Turn 6) ...**',
      '',
      '## 是，有未提交修改（12 个文件）',
      '',
      '主仓工作树现在有 **10 个修改 + 2 个未跟踪**，共 +624/−69 行。',
      '',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      '{',
      '  "candidates": [',
      '    "我来提交（按主题拆分）并推送",',
      '    "只提交不推送"',
      '  ],',
      '  "question": "这批 WIP 要我怎么处理？"',
      '}',
      '````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.turns).toHaveLength(2)
    expect(transcript.finalTurnIndex).toBe(1)
    // 结论正文保留，且在问题之前
    const body = transcript.finalBody
    expect(body).toContain('## 是，有未提交修改（12 个文件）')
    expect(body).toContain('共 +624/−69 行')
    expect(body).not.toContain('🛠️ Tool:')
    expect(transcript.finalAskUser?.question).toBe('这批 WIP 要我怎么处理？')
    expect(transcript.finalAskUser?.candidates).toEqual(['我来提交（按主题拆分）并推送', '只提交不推送'])
  })

  it('falls back to the text form when the ask_user payload has no candidates', () => {
    const content = [
      'LLM Running (Turn 1) ...',
      '<summary>需要补充信息</summary>',
      '🛠️ Tool: `ask_user`  📥 args:',
      '````text',
      JSON.stringify({ question: '请补充部署目标环境。' }),
      '````',
    ].join('\n')

    const transcript = parseAssistantTranscript(content)

    expect(transcript.finalAskUser).toBeNull()
    expect(transcript.finalBody).toBe('请补充部署目标环境。')
  })

  it('renders an ask_user payload back to its text form for copying', () => {
    expect(renderAskUserPayload({ question: '继续吗？', candidates: ['继续', '暂停'] }))
      .toBe('继续吗？\n\n可选项：\n- 继续\n- 暂停')
    expect(renderAskUserPayload({ question: '单独问题', candidates: [] })).toBe('单独问题')
  })

  it('strips only the trailing final-response protocol marker', () => {
    const content = '正文中提到 [Info] Final response to user. 不应删除。\n[Info] Final response to user.'

    expect(stripFinalResponseMarker(content)).toBe('正文中提到 [Info] Final response to user. 不应删除。')
    expect(stripAssistantTranscriptTags('**LLM Running (Turn 3) ...**\n<summary>完成</summary>\n正文'))
      .toBe('正文')
  })
})
