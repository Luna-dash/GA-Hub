import { describe, expect, it } from 'vitest'
import {
  deliverablesOf,
  deliverableVerified,
  isWorkflowClosed,
  milestoneCheckSummary,
  parseContractDeliverables,
  splitReplyByMilestones,
  stripContractTail,
  type SubagentReviewFacts,
  type WorkerMilestone,
} from './presentation'

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
