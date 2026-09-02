import { describe, expect, it } from 'vitest'
import { foldTurns } from './foldTurns'

describe('foldTurns (thin view over the transcript engine)', () => {
  it('splits turns into folds plus a growing final text segment without the raw marker', () => {
    const text = [
      '**LLM Running (Turn 1) ...**',
      '<summary>执行搜索</summary>',
      '🛠️ Tool: `code_run`  📥 args:',
      '````text',
      '{"cmd":"grep"}',
      '````',
      '**LLM Running (Turn 2) ...**',
      '<summary>得出结论</summary>',
      '结论正文。',
    ].join('\n')

    const segs = foldTurns(text)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ type: 'fold', title: '执行搜索' })
    expect(segs[0].type === 'fold' && segs[0].content).not.toContain('<summary>')
    // 最后一个 turn 是正文段：不再显示 "LLM Running (Turn N)" 协议原文，
    // 直播与完成后的外观因此一致（双引擎收敛的动机之一）
    expect(segs[1]).toMatchObject({ type: 'text', content: '结论正文。' })
  })

  it('preserves leading text before the first turn marker', () => {
    const text = [
      '开场说明。',
      '**LLM Running (Turn 1) ...**',
      '<summary>第一步</summary>',
      '步骤内容。',
      '**LLM Running (Turn 2) ...**',
      '<summary>第二步</summary>',
      '收尾内容。',
    ].join('\n')

    const segs = foldTurns(text)
    expect(segs[0]).toMatchObject({ type: 'text', content: '开场说明。' })
    expect(segs[1]).toMatchObject({ type: 'fold', title: '第一步' })
  })

  it('keeps interior 4-backtick fences intact while splitting (anchored protection)', () => {
    // 回归：旧非锚定围栏正则曾在流式期间错误配对正文内部的 4+ 反引号块
    const text = [
      '**LLM Running (Turn 1) ...**',
      '<summary>展示目录树</summary>',
      '````text',
      '目录树正文',
      '````',
      '**LLM Running (Turn 2) ...**',
      '<summary>结论</summary>',
      '## 最终回答',
    ].join('\n')

    const segs = foldTurns(text)
    expect(segs[0].type === 'fold' && segs[0].content).toContain('目录树正文')
    expect(segs[1]).toMatchObject({ type: 'text', content: '## 最终回答' })
  })

  it('keeps half-open summaries visible during streaming (no flicker removal)', () => {
    const text = '**LLM Running (Turn 1) ...**\n<summary>还在流式输出'
    const segs = foldTurns(text)
    expect(segs).toHaveLength(1)
    expect(segs[0].type === 'text' && segs[0].content).toContain('<summary>还在流式输出')
  })

  it('returns a single text segment when no turn marker exists', () => {
    expect(foldTurns('普通一句话')).toEqual([{ type: 'text', content: '普通一句话' }])
    expect(foldTurns('')).toEqual([])
  })
})
