import { describe, expect, it } from 'vitest'
import { formatToolHint, projectRunningTurn } from './runningTranscript'

const prose = (raw: string) => projectRunningTurn(raw).parts.filter(p => p.kind === 'text').map(p => p.text).join('\n')
const hints = (raw: string) => projectRunningTurn(raw).parts.filter(p => p.kind === 'tools').flatMap(p => p.labels)

describe('light running projection', () => {
  it('keeps prose around tool args/results and hides fake prose inside results', () => {
    const raw = ['检查文件。', '🛠️ Tool: `file_read`  📥 args:', '````json', '{"path":"private"}', '````', '`````text', '日志与假说明', '🛠️ Tool: `code_run`', '`````', '发现边界问题，继续修复。'].join('\n')
    expect(prose(raw)).toBe('检查文件。\n发现边界问题，继续修复。')
    expect(hints(raw)).toEqual(['读取文件'])
  })
  it('keeps commentary between compact calls', () => {
    const raw = '开始\n🛠️ file_read({})\n发现边界问题\n🛠️ code_run({})\n验证完毕'
    expect(prose(raw)).toBe('开始\n发现边界问题\n验证完毕')
    expect(hints(raw)).toEqual(['读取文件', '执行脚本'])
  })
  it('preserves ordinary code fences including tool-looking examples', () => {
    const raw = '说明\n```text\n🛠️ code_run({})\n```\n继续说明'
    expect(prose(raw)).toBe(raw)
    expect(hints(raw)).toEqual([])
  })
  it('hides incomplete four/five-backtick dump fences', () => {
    const raw = '说明\n🛠️ Tool: `code_run`  📥 args:\n````json\n{"script":"private'
    expect(prose(raw)).toBe('说明')
    expect(hints(raw)).toEqual(['执行脚本'])
  })
  it('handles adjacent compact calls and escaped parentheses/newlines in JSON', () => {
    const raw = '之前\n🛠️ file_read({"path":"a)"})🛠️ code_run({"script":"print(\\\"x\\\")"})\n之后'
    expect(prose(raw)).toBe('之前\n之后')
    expect(hints(raw)).toEqual(['读取文件', '执行脚本'])
  })
  it('hides multiline and partial compact args', () => {
    expect(prose('说明\n🛠️ code_run({\n"script":"private"\n})\n完成')).toBe('说明\n完成')
    expect(prose('说明\n🛠️ code_run({"script":"private')).toBe('说明')
  })
  it('handles abbreviated compact output without losing subsequent prose', () => {
    expect(prose('说明\n🛠️ code_run({"script":"long...)\n结果说明')).toBe('说明\n结果说明')
  })
  it('extracts AskUser without exposing args', () => {
    const raw = '请确认\n🛠️ Tool: `functions.ask_user`  📥 args:\n````json\n{"question":"选择？","candidates":["甲","乙"]}\n````'
    expect(projectRunningTurn(raw).askUser).toEqual({ question: '选择？', candidates: ['甲', '乙'] })
    expect(prose(raw)).toBe('请确认')
  })
  it('groups tool labels without inferring success', () => {
    expect(formatToolHint(['读取文件', '执行脚本', '读取文件'])).toBe('读取文件 ×2 · 执行脚本')
    expect(hints('🛠️ unknown({})')).toEqual(['调用工具'])
  })
})
