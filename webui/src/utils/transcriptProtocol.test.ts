import { describe, it, expect } from 'vitest'
import { scanTranscript, protectTranscript, transcriptRecordMarkdown } from './transcriptProtocol'
import { projectRunningTurn } from './runningTranscript'
import { parseAssistantTranscript, extractAskUserPayload } from './assistantTranscript'

const tool = (result: string) => '🛠️ Tool: `functions.code_run` 📥 args:\n````json\n{"script":"test"}\n````\n````\n' + result + '````\n'
const prose = (s: string) => projectRunningTurn(s).parts.filter(p => p.kind === 'text').map(p => p.text).join('\n')

describe('shared transcript protocol', () => {
  it('separates a glued tool header and closing fence without changing raw offsets', () => {
    const raw = '模型说明' + tool('result without newline') + '后续说明'
    const nodes = scanTranscript(raw)
    expect(nodes.map(n => n.raw).join('')).toBe(raw)
    expect(nodes.filter(n => n.kind === 'tool')).toHaveLength(1)
    expect(prose(raw)).toBe('模型说明\n后续说明')
    expect(transcriptRecordMarkdown(raw)).toContain('模型说明\n🛠️')
    expect(transcriptRecordMarkdown(raw)).toContain('result without newline\n````\n后续说明')
    const { safe, restore } = protectTranscript(raw)
    expect(restore(safe)).toBe(raw)
  })
  it('never exposes wrappers or results at any detailed-stream prefix', () => {
    const raw = '说明' + tool('secret-result') + '后续说明'
    for (let end = 2; end <= raw.length; end++) {
      const visible = prose(raw.slice(0, end))
      expect(visible, `prefix ${end}`).not.toMatch(/🛠|Tool:|args:|script|secret|`/)
    }
    // The application receives cumulative content; every split converges to
    // precisely the same node tree and projections as one-shot replay.
    for (let split = 0; split <= raw.length; split++) {
      let accumulated = raw.slice(0, split)
      scanTranscript(accumulated)
      accumulated += raw.slice(split)
      expect(scanTranscript(accumulated)).toEqual(scanTranscript(raw))
      expect(prose(accumulated)).toBe(prose(raw))
    }
  })
  it('protects fake turns, summaries and calls inside both ordinary code and tool output', () => {
    const fake = 'LLM Running (Turn 99) ...\n<summary>not summary</summary>\n🛠️ Tool: `ask_user`\n'
    const raw = 'LLM Running (Turn 1) ...\n<summary>real</summary>\n```text\n' + fake + '```\n' + tool(fake) + '完成'
    const parsed = parseAssistantTranscript(raw)
    expect(parsed.turns.map(t => t.turn)).toEqual([1])
    expect(parsed.turns[0].summary).toBe('real')
    expect(extractAskUserPayload(raw)).toBeNull()
    expect(prose(raw)).toContain('Turn 99') // ordinary model code survives
    expect(prose(raw)).not.toContain('script')
  })
  it('treats quoted tool names as prose, not calls', () => {
    const raw = '正文中引用 🛠️ Tool: `code_run`，不是调用。'
    expect(scanTranscript(raw).every(n => n.kind === 'text')).toBe(true)
    expect(prose(raw)).toBe(raw)
    expect(transcriptRecordMarkdown(raw)).toBe(raw)
  })
  it('keeps multiple calls and ask_user parsing on the shared boundary scanner', () => {
    const raw = tool('out\n') + '中间说明' + '🛠️ Tool: `functions.ask_user` 📥 args:\n````json\n{"question":"选择？","candidates":["A","B"]}\n````\n'
    expect(scanTranscript(raw).filter(n => n.kind === 'tool').map(n => n.name)).toEqual(['functions.code_run', 'functions.ask_user'])
    expect(projectRunningTurn(raw).askUser).toEqual({ question: '选择？', candidates: ['A', 'B'] })
  })
  it('does not apply result-fence repairs to ordinary code', () => {
    const raw = '```text\nresult````\n'
    expect(transcriptRecordMarkdown(raw)).toBe(raw)
  })
})
