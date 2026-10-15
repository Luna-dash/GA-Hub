import { describe, expect, it } from 'vitest'
import { parseAssistantTranscript } from './assistantTranscript'
import { foldTurns } from './foldTurns'
import { projectRunningTurn } from './runningTranscript'
import { scanTranscript } from './transcriptProtocol'
import { themeReportConclusion } from './themeReport'

// One protocol sample consumed by each projection; policy need not be identical.
const completed = [
  '**LLM Running (Turn 1) ...**',
  '<summary>检查</summary>',
  '🛠️ Tool: `functions.code_run`',
  '````text',
  '**LLM Running (Turn 99) ...**',
  '````',
  '**LLM Running (Turn 2) ...**',
  '<summary>完成</summary>',
  '最终结论。',
].join('\n')

const emptyFinal = [
  '**LLM Running (Turn 1) ...**',
  '先前正文。',
  '**LLM Running (Turn 2) ...**',
  '<summary>检查中</summary>',
].join('\n')

describe('shared transcript projection contracts', () => {
  it('ignores fenced turn markers across scanner, chat, live and report', () => {
    expect(scanTranscript(completed).filter(node => node.kind === 'turn')).toHaveLength(2)
    expect(parseAssistantTranscript(completed).turns.map(turn => turn.turn)).toEqual([1, 2])
    expect(parseAssistantTranscript(completed).finalBody).toBe('最终结论。')
    expect(foldTurns(completed)).toHaveLength(2)
    expect(foldTurns(completed).at(-1)).toEqual({ type: 'text', content: '最终结论。' })
    expect(projectRunningTurn(completed).parts).toContainEqual({ kind: 'tools', labels: ['执行脚本'] })
    expect(themeReportConclusion(completed)).toBe('最终结论。')
  })

  it('preserves chat fallback without reviving an earlier theme report', () => {
    expect(parseAssistantTranscript(emptyFinal).finalBody).toBe('先前正文。')
    expect(foldTurns(emptyFinal).at(-1)).toEqual({ type: 'text', content: '' })
    expect(themeReportConclusion(emptyFinal)).toBe('')
  })
})
