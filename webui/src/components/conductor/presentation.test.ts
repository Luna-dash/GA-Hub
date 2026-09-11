import { describe, expect, it } from 'vitest'
import type { ConductorSubagent } from '@/api/types'
import {
  briefWorkerTitle,
  collapseBlankLines,
  deliverablesOf,
  deliverableVerified,
  historyRowsOf,
  isWorkflowClosed,
  milestoneCheckSummary,
  parseContractDeliverables,
  sanitizeWorkerOutput,
  splitReplyByMilestones,
  splitWorkerTurns,
  stripContractTail,
  workerNumbers,
  type SubagentReviewFacts,
  type WorkerMilestone,
} from './presentation'

const sub = (overrides: Partial<ConductorSubagent>) => (
  { prompt: '', status: 'stopped', ...overrides } as ConductorSubagent
)

describe('briefWorkerTitle', () => {
  it('prefers a concise manifest goal over the dispatch prompt', () => {
    const long = '很长的下发指令，包含大量执行细节。'.repeat(10)
    expect(briefWorkerTitle(sub({ prompt: long, manifest: { goal: '建立索引' } } as never)))
      .toBe('建立索引')
  })

  it('keeps a short prompt intact', () => {
    expect(briefWorkerTitle(sub({ prompt: '扫描主要性能瓶颈' }))).toBe('扫描主要性能瓶颈')
  })

  it('cuts a long dispatch prompt to its first clause', () => {
    expect(briefWorkerTitle(sub({ prompt: '扫描项目源码与依赖清单，定位性能热点并输出优化报告与修复补丁' })))
      .toBe('扫描项目源码与依赖清单')
  })

  it('hard-caps unpunctuated prompts at 24 chars', () => {
    const long = 'x'.repeat(40)
    expect(briefWorkerTitle(sub({ prompt: long }))).toBe(`${'x'.repeat(24)}…`)
  })

  it('reads the dispatch template\'s [Task Goal] section instead of the tag', () => {
    const prompt = [
      '[Task Goal]',
      '列出 pages 目录的本地 import',
      '',
      '[Deliverables] (write each file to its exact absolute path)',
      '- D:\\study\\GA\\temp\\页面依赖.md',
      '',
      'Every deliverable path must resolve under an allowed root.',
    ].join('\n')
    expect(briefWorkerTitle(sub({ prompt }))).toBe('列出 pages 目录的本地 import')
  })

  it('skips markdown and marker scaffolding to the first content line', () => {
    const prompt = [
      '## 处理结果',
      '【里程碑】归档已建立',
      '扫描 src/ 目录与依赖清单，定位性能热点并汇总成报告',
    ].join('\n')
    expect(briefWorkerTitle(sub({ prompt }))).toBe('扫描 src/ 目录与依赖清单')
  })

  it('never leaks a contract tag into the title', () => {
    const prompt = [
      '[Deliverables] (write each file to its exact absolute path)',
      '- D:/a.md',
      '',
      'Every deliverable path must resolve under an allowed root.',
    ].join('\n')
    const title = briefWorkerTitle(sub({ prompt }))
    expect(title.startsWith('Every')).toBe(true)
    expect(title).not.toContain('[')
  })
})

describe('workflow closure', () => {
  it('treats cancelled and killed workflows as terminal even with legacy stages', () => {
    expect(isWorkflowClosed({
      request_id: 'cancelled', status: 'cancelled', stage: 'supervising',
      admission_state: 'admitted', subagents: {}, created_at: 1,
    })).toBe(true)
    expect(isWorkflowClosed({
      request_id: 'killed', status: 'killed', stage: 'recoverable_failure',
      admission_state: 'admitted', subagents: {}, created_at: 1,
    })).toBe(true)
  })

  it('keeps a recoverable failure open until the tracker emits a terminal event', () => {
    expect(isWorkflowClosed({
      request_id: 'recoverable', status: 'failed', stage: 'recoverable_failure',
      admission_state: 'admitted', subagents: {}, created_at: 1,
    })).toBe(false)
    expect(isWorkflowClosed({
      request_id: 'terminal', status: 'failed', stage: 'failed',
      terminal_event: 'workflow_failed', admission_state: 'admitted', subagents: {}, created_at: 1,
    })).toBe(true)
  })
})

function milestone(overrides: Partial<WorkerMilestone>): WorkerMilestone {
  return {
    id: 'ms-1',
    desc: '归档已建立',
    check: { kind: 'archive_contains', contains: '【里程碑】归档已建立' },
    reached_at: 1_700_000_100,
    ...overrides,
  }
}

describe('stripContractTail', () => {
  it('removes the trailing [DONE] summary contract pair', () => {
    const reply = '正文内容\n\n[DONE] <summary>任务完成</summary>'
    expect(stripContractTail(reply)).toBe('正文内容')
  })

  it('removes the canonical [[GAHUB_TASK_DONE]] summary pair (2026-09-08 contract)', () => {
    const reply = '正文内容\n\n[[GAHUB_TASK_DONE]]\n<summary>任务完成</summary>'
    expect(stripContractTail(reply)).toBe('正文内容')
  })

  it('removes a bare trailing [[GAHUB_TASK_DONE]] marker (workers omit the summary line)', () => {
    const reply = '正文内容\n\n[[GAHUB_TASK_DONE]]'
    expect(stripContractTail(reply)).toBe('正文内容')
  })

  it('removes the bare marker when milestone lines precede it', () => {
    const reply = '正文内容\n\nMILESTONE-m1-DONE\nMILESTONE-m2-DONE\n\n[[GAHUB_TASK_DONE]]\n'
    expect(stripContractTail(reply)).toBe('正文内容\n\nMILESTONE-m1-DONE\nMILESTONE-m2-DONE')
  })

  it('keeps a lone legacy [DONE] — it is not a completion signal on its own', () => {
    const reply = '正文内容\n\n[DONE]'
    expect(stripContractTail(reply)).toBe(reply)
  })

  it('keeps a bare canonical marker that is mid-text', () => {
    const reply = '提到 [[GAHUB_TASK_DONE]] 之后继续\n结尾'
    expect(stripContractTail(reply)).toBe(reply)
  })

  it('keeps a [DONE] that is not at the tail (mid-text mention)', () => {
    const reply = '提到 [DONE] <summary>x</summary> 之后继续\n结尾'
    expect(stripContractTail(reply)).toBe(reply)
  })

  it('keeps a canonical marker that is not at the tail (mid-text mention)', () => {
    const reply = '提到 [[GAHUB_TASK_DONE]] <summary>x</summary> 之后继续\n结尾'
    expect(stripContractTail(reply)).toBe(reply)
  })

  it('leaves replies without the contract untouched', () => {
    expect(stripContractTail('普通输出')).toBe('普通输出')
  })
})

describe('splitReplyByMilestones', () => {
  it('returns one text segment when nothing can anchor', () => {
    const reply = '第一段\n第二段'
    const segments = splitReplyByMilestones(reply, [milestone({})])
    expect(segments).toEqual([{ kind: 'text', text: reply }])
  })

  it('ignores unreached or non-archive milestones', () => {
    const reply = '【里程碑】归档已建立\n之后的内容'
    const unreached = splitReplyByMilestones(reply, [
      milestone({ reached_at: null }),
    ])
    expect(unreached).toEqual([{ kind: 'text', text: reply }])
    const fileCheck = splitReplyByMilestones(reply, [
      milestone({ check: { kind: 'file_exists', path: 'D:/x.md' } }),
    ])
    expect(fileCheck).toEqual([{ kind: 'text', text: reply }])
  })

  it('lifts the marker line out as a milestone anchor segment', () => {
    const reply = '开工说明\n【里程碑】归档已建立\n后续分析正文'
    const segments = splitReplyByMilestones(reply, [milestone({})])
    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ kind: 'text', text: '开工说明\n' })
    expect(segments[1]).toEqual({ kind: 'milestone', milestone: expect.objectContaining({ id: 'ms-1' }) })
    expect(segments[2]).toEqual({ kind: 'text', text: '后续分析正文' })
  })

  it('anchors each milestone at most once and keeps order', () => {
    const reply = '【里程碑】归档已建立\n中间\n【里程碑】归档已建立\n结尾'
    const segments = splitReplyByMilestones(reply, [milestone({})])
    const anchors = segments.filter((segment) => segment.kind === 'milestone')
    expect(anchors).toHaveLength(1)
    expect(segments[0].kind).toBe('milestone')
  })

  it('handles a marker that is the whole reply', () => {
    const reply = '【里程碑】归档已建立'
    const segments = splitReplyByMilestones(reply, [milestone({})])
    expect(segments).toEqual([{ kind: 'milestone', milestone: expect.objectContaining({ id: 'ms-1' }) }])
  })
})

describe('milestoneCheckSummary', () => {
  it('labels archive markers without leaking the marker text', () => {
    expect(milestoneCheckSummary({ kind: 'archive_contains', contains: 'secret-marker' })).toBe('输出标记检查')
  })

  it('summarizes file checks with the basename', () => {
    expect(milestoneCheckSummary({ kind: 'file_exists', path: 'D:/out/report.md' })).toBe('文件存在 · report.md')
    expect(milestoneCheckSummary({ kind: 'file_contains', path: 'D:/out/report.md' })).toBe('内容检查 · report.md')
    expect(milestoneCheckSummary({ kind: 'file_modified_after', path: 'D:/a/b.log' })).toBe('更新检查 · b.log')
  })

  it('falls back to a generic label', () => {
    expect(milestoneCheckSummary(null)).toBe('机械检查')
    expect(milestoneCheckSummary({ kind: 'exotic' })).toBe('机械检查')
  })
})

describe('deliverable reconstruction', () => {
  // The shape the hub renders into every worker prompt; the journal keeps the
  // prompt but not the manifest, so this is what archive rows must be parsed
  // from. The trailing root-policy sentence is not a deliverable.
  const contractPrompt = [
    '[Task Goal]',
    '列出 pages 目录的本地 import',
    '',
    '[Deliverables] (write each file to its exact absolute path)',
    '- D:\\study\\GA\\temp\\页面依赖.md',
    '',
    'Every deliverable path must resolve under an allowed root (allowed at startup: D:\\study\\GA);',
    'out-of-root files fail verification with 422.',
    '',
    '[Done When]',
    '文件存在且非空',
  ].join('\n')

  it('parses the contract deliverables section without the policy note', () => {
    expect(parseContractDeliverables(contractPrompt)).toEqual([
      { path: 'D:\\study\\GA\\temp\\页面依赖.md' },
    ])
  })

  it('keeps the optional description', () => {
    expect(parseContractDeliverables('[Deliverables]\n- D:/out/a.md -- 索引文件\n')).toEqual([
      { path: 'D:/out/a.md', desc: '索引文件' },
    ])
  })

  it('returns nothing for prompts without the section', () => {
    expect(parseContractDeliverables('[Task Goal]\n随手写点东西')).toEqual([])
    expect(parseContractDeliverables('')).toEqual([])
  })

  it('prefers the live manifest and falls back to the prompt, then to checks', () => {
    const withManifest = { manifest: { deliverables: [{ path: 'D:/live.md' }] } } as SubagentReviewFacts
    expect(deliverablesOf(withManifest)).toEqual([{ path: 'D:/live.md' }])

    const archived = { prompt: contractPrompt } as SubagentReviewFacts
    expect(deliverablesOf(archived)).toEqual([{ path: 'D:\\study\\GA\\temp\\页面依赖.md' }])

    // No manifest and no contract section: the machine checks name the paths.
    const checksOnly = {
      prompt: 'no contract here',
      quality_checks: { checks: [
        { kind: 'path_exists', path: 'D:/out/report.md', passed: true },
        { kind: 'file_contains', path: 'D:/out/report.md', passed: true },
        { kind: 'python_compile', path: 'D:/out/helper.py', passed: true },
      ] },
      deliverables_missing: ['D:/out/gone.md'],
    } as unknown as SubagentReviewFacts
    expect(deliverablesOf(checksOnly)).toEqual([
      { path: 'D:/out/report.md' },
      { path: 'D:/out/gone.md' },
    ])
  })

  it('reports verification truth per path and ignores plan-only check kinds', () => {
    const facts = {
      quality_checks: { checks: [
        { kind: 'path_exists', path: 'D:/out/report.md', passed: true },
        { kind: 'file_contains', path: 'D:/out/report.md', passed: false },
        { kind: 'archive_contains', path: 'D:/out/other.md', passed: true },
      ] },
    } as unknown as SubagentReviewFacts
    expect(deliverableVerified(facts, 'D:/out/report.md')).toBe(false)
    expect(deliverableVerified(facts, 'D:/out/other.md')).toBe(undefined)
    expect(deliverableVerified(facts, 'D:/out/unknown.md')).toBe(undefined)

    const allPassed = {
      quality_checks: { checks: [
        { kind: 'path_exists', path: 'D:/out/report.md', passed: true, status: 'passed' },
        { kind: 'file_contains', path: 'D:/out/report.md', status: 'passed' },
      ] },
    } as unknown as SubagentReviewFacts
    expect(deliverableVerified(allPassed, 'D:/out/report.md')).toBe(true)
  })
})

describe('workerNumbers', () => {
  it('numbers workers by dispatch order and keeps ties stable', () => {
    const a = { id: 'b', created_at: 10 } as never
    const b = { id: 'a', created_at: 10 } as never
    const c = { id: 'c', created_at: 5 } as never
    const numbers = workerNumbers([a, b, c])
    expect(numbers.get('c')).toBe(1)
    expect(numbers.get('a')).toBe(2)
    expect(numbers.get('b')).toBe(3)
  })
})

describe('collapseBlankLines', () => {
  it('collapses runs of blank lines to one', () => {
    expect(collapseBlankLines('第一段\n\n\n\n\n第二段')).toBe('第一段\n\n第二段')
  })

  it('trims leading and trailing blank lines', () => {
    expect(collapseBlankLines('\n\n  \n内容\n\n\n')).toBe('内容')
  })

  it('keeps normal single blank lines intact', () => {
    expect(collapseBlankLines('第一段\n\n第二段')).toBe('第一段\n\n第二段')
  })
})

describe('sanitizeWorkerOutput', () => {
  it('strips thinking blocks, status lines and stray angle-bracket tags', () => {
    const raw = [
      '[Status] LLM warmup',
      '<thinking>内心推演，不该展示</thinking>',
      '正文第一行</summary>',
      '[Info] cost 0.01',
      '正文第二行 <output> 标记',
    ].join('\n')
    const clean = sanitizeWorkerOutput(raw)
    expect(clean).not.toContain('<thinking>')
    expect(clean).not.toContain('内心推演')
    expect(clean).not.toContain('[Status]')
    expect(clean).not.toContain('[Info]')
    expect(clean).not.toContain('</summary>')
    expect(clean).not.toContain('<output>')
    expect(clean).toContain('正文第一行')
    expect(clean).toContain('正文第二行')
  })

  it('collapses tool-call arg dumps to one tool line', () => {
    const raw = '🛠️ Tool: `read_file`\n📥 args:\n````\n{"path": "x"}\n````\n结果说明'
    const clean = sanitizeWorkerOutput(raw)
    expect(clean).toContain('🛠️ `read_file`')
    expect(clean).not.toContain('"path"')
    expect(clean).toContain('结果说明')
  })
})

describe('splitWorkerTurns', () => {
  it('splits engine turn markers into numbered turns', () => {
    const reply = [
      '**LLM Running (Turn 1) ...**',
      '第一轮输出',
      '**LLM Running (Turn 2) ...**',
      '第二轮输出',
    ].join('\n')
    const turns = splitWorkerTurns(reply)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual({ index: 1, text: '第一轮输出' })
    expect(turns[1]).toEqual({ index: 2, text: '第二轮输出' })
  })

  it('keeps pre-marker text as a 前置说明 segment', () => {
    const reply = '开场说明\n**LLM Running (Turn 1) ...**\n正式内容'
    const turns = splitWorkerTurns(reply)
    expect(turns).toHaveLength(2)
    expect(turns[0].index).toBe(0)
    expect(turns[0].text).toBe('开场说明')
    expect(turns[1].index).toBe(1)
  })

  it('returns a single unlabeled turn for plain replies', () => {
    expect(splitWorkerTurns('普通回复')).toEqual([{ index: 1, text: '普通回复' }])
  })
})

describe('historyRowsOf', () => {
  const workflow = (overrides: Record<string, unknown>) => ({
    request_id: 'r1', status: 'supervising', stage: 'supervising',
    subagents: {}, created_at: 1, ...overrides,
  }) as never

  it('sorts attention-first, then newest first — no sort control needed', () => {
    const rows = historyRowsOf([
      workflow({ request_id: 'done', stage: 'completed', status: 'completed', created_at: 3 }),
      workflow({ request_id: 'review', stage: 'awaiting_review', created_at: 1 }),
      workflow({ request_id: 'live', created_at: 2 }),
    ], [], new Map(), true)
    expect(rows.map((row) => row.requestId)).toEqual(['review', 'done', 'live'])
    expect(rows[0].needsAttention).toBe(true)
    expect(rows[1].needsAttention).toBe(false)
  })

  it('counts archived workers from the merged list instead of the tracker map', () => {
    const rows = historyRowsOf(
      [workflow({ request_id: 'r1', stage: 'completed', status: 'completed' })],
      [
        { id: 'w1', request_id: 'r1', archived: true, review_status: 'accepted', created_at: 1 },
        { id: 'w2', request_id: 'r1', archived: true, review_status: 'pending', created_at: 2 },
      ] as never,
      new Map(),
      true,
    )
    // The tracker map is empty: without the merged list this would read
    // "尚未指派" under two visible cards.
    expect(rows[0].total).toBe(2)
    expect(rows[0].accepted).toBe(1)
  })

  it('locks deletion of a live row while the conductor runs', () => {
    const running = historyRowsOf([workflow({})], [], new Map(), true)
    const paused = historyRowsOf([workflow({})], [], new Map(), false)
    expect(running[0].deletable).toBe(false)
    expect(paused[0].deletable).toBe(true)
  })

  it('falls back to a placeholder title when no first message is known', () => {
    const rows = historyRowsOf([workflow({})], [], new Map(), true)
    expect(rows[0].title).toBe('未命名任务')
  })
})
