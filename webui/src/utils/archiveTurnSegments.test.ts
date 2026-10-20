import { describe, it, expect } from 'vitest'
import { replySegmentsContent, replySegmentsTurns } from './replySegments'
import { parseAssistantTranscript } from './assistantTranscript'

describe('trusted archive turn segments', () => {
  const first = '**LLM Running (Turn 1) ...**\n<summary>Read evidence</summary>\nstep one\nLLM Running (Turn 88) ...\nliteral example'
  const last = '**LLM Running (Turn 2) ...**\n<summary>Deliver</summary>\nfinal answer\n```text\nLLM Running (Turn 99) ...\n```'
  it('does not split a segment at prose or code Turn markers', () => {
    const result = parseAssistantTranscript(first + last, false, [first, last])
    expect(result.turns).toHaveLength(2)
    expect(result.turns[0].content).toContain('Turn 88')
    expect(result.finalBody).toContain('Turn 99')
    expect(result.turns.map(turn => turn.turn)).toEqual([1, 2])
  })
  it('accepts unnumbered segments and numbers them by order', () => {
    const result = parseAssistantTranscript('stepanswer', false, ['step', 'answer'])
    expect(result.turns.map(turn => turn.turn)).toEqual([1, 2])
    expect(result.finalBody).toBe('answer')
  })
  it.each([undefined, null, [], ['ok', 3], ['ok', ' ']])('falls back for malformed metadata %j', (value) => {
    expect(parseAssistantTranscript('plain answer', false, value)).toEqual(parseAssistantTranscript('plain answer'))
  })
  it('keeps reasoning hidden and tool-ended fallback shared with legacy parsing', () => {
    const turns = ['<thinking>secret</thinking>\n<summary>Done</summary>\nanswer', '🛠️ code_run({})']
    const result = parseAssistantTranscript(turns.join(''), false, turns)
    expect(result.turns[0].content).not.toContain('secret')
    expect(result.turns[0].rawContent).toContain('secret')
    expect(result.finalBody).toBe('answer')
    expect(result.stopped).toBe(true)
  })
})

describe('archive safety and mixed reply pieces', () => {
  it('rejects metadata inconsistent with the authoritative content', () => {
    expect(parseAssistantTranscript('real answer', false, ['wrong', 'answer']))
      .toEqual(parseAssistantTranscript('real answer'))
  })
  it.each([
    ['```text\nstart\n', '<summary>literal</summary>\nLLM Running (Turn 99) ...\nend\n```'],
    ['<thinking>private', ' continuation</thinking>\nanswer'],
  ])('preserves lexical protection across physical boundaries', (a, b) => {
    const text = a + b
    const result = parseAssistantTranscript(text, false, [a, b])
    expect(result).toEqual(parseAssistantTranscript(text))
    expect(result.finalBody).not.toContain('private')
  })
  it('keeps trusted boundaries while parsing only the legacy reply piece', () => {
    const parts = [
      { streamId: 'a', content: 'firstLLM Running (Turn 88) ...literal', turnSegments: ['firstLLM Running (Turn 88) ...literal'], done: true },
      { streamId: 'b', content: '**LLM Running (Turn 1) ...**\nstep\n**LLM Running (Turn 2) ...**\nanswer', done: true },
    ]
    const content = replySegmentsContent(parts)
    const turns = replySegmentsTurns(parts)
    expect(turns?.join('')).toBe(content)
    const parsed = parseAssistantTranscript(content, false, turns)
    expect(parsed.turns).toHaveLength(3)
    expect(parsed.turns[0].content).toContain('Turn 88')
    expect(parsed.finalBody).toBe('answer')
  })
})
