import { describe, expect, it } from 'vitest'
import { themeReportConclusion } from './themeReport'

describe('themeReportConclusion', () => {
  it('keeps only the last reply, not earlier turns or summaries', () => {
    const raw = '**LLM Running (Turn 1) ...**\n<summary>检查</summary>\n过程说明\n**LLM Running (Turn 2) ...**\n<summary>完成</summary>\n<thinking>内部推理</thinking>\n✅ **签到成功**\n奖励 10 分。'
    expect(themeReportConclusion(raw)).toBe('✅ **签到成功**\n奖励 10 分。')
  })
  it('drops prose before the last tool call and its output', () => {
    const raw = '<summary>检查</summary>\n正在查询\n🛠️ Tool: `check`\n````json\n{"ok":true}\n````\n[Info] execution done\n结论：已完成。'
    expect(themeReportConclusion(raw)).toBe('结论：已完成。')
  })
  it('does not revive an earlier reply when the final turn is empty', () => {
    expect(themeReportConclusion('**LLM Running (Turn 1) ...**\n旧结果\n**LLM Running (Turn 2) ...**\n<summary>检查中</summary>')).toBe('')
    expect(themeReportConclusion('正在检查\n🛠️ check()')).toBe('')
  })
  it('preserves plain replies and markdown code, but not stopped runs', () => {
    expect(themeReportConclusion('<summary>完成</summary>\n# 结论\n```json\n{"ok": true}\n```')).toBe('# 结论\n```json\n{"ok": true}\n```')
    expect(themeReportConclusion('**LLM Running (Turn 1) ...**\n旧结论\n**LLM Running (Turn 2) ...**\n正在检查\n🛠️ check()')).toBe('')
  })
})
