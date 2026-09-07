import { describe, expect, it } from 'vitest'
import {
  milestoneCheckSummary,
  splitReplyByMilestones,
  stripContractTail,
  type WorkerMilestone,
} from './presentation'

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

  it('keeps a [DONE] that is not at the tail (mid-text mention)', () => {
    const reply = '提到 [DONE] <summary>x</summary> 之后继续\n结尾'
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
