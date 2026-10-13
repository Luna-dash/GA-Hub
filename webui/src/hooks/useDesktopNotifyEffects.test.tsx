// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ handlers: new Map<string, (e: any) => void>(), notify: vi.fn(), navigate: vi.fn(), messages: vi.fn(), start: vi.fn() }))
const qc = { getQueryData: () => ({ items: [{ id: 's1', title: '测试会话' }] }) }
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => qc }))
vi.mock('react-router-dom', () => ({ useNavigate: () => m.navigate }))
vi.mock('@/runtime/hubEventClient', () => ({ hubEventClient: { subscribe: (topic: string, fn: (e: any) => void) => { m.handlers.set(topic, fn); return () => m.handlers.delete(topic) } } }))
vi.mock('@/utils/notify', () => ({ notify: m.notify }))
vi.mock('@/api/client', () => ({ api: { sessions: vi.fn(), getSessionMessages: m.messages } }))
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => ({ start: m.start }) } }))
import { useDesktopNotifyEffects } from './useDesktopNotifyEffects'
import { storageKeys } from '@/config/storageKeys'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
function Probe() { useDesktopNotifyEffects(); return null }
const emit = (payload: any) => m.handlers.get('session:runtime')?.({ topic: 'session:runtime', payload })
const settled = { session_id: 's1', status: 'idle', completed_run_id: 'r1' }
describe('state notifications', () => {
  let root: Root, host: HTMLDivElement
  beforeEach(() => {
    vi.clearAllMocks(); m.handlers.clear()
    m.messages.mockResolvedValue({ items: [{ role: 'assistant', content: 'PRIVATE OUTPUT' }] })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root.render(<Probe />))
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })
  it('reports settled runs once without output and opens the session', async () => {
    await act(async () => { emit(settled); emit(settled) })
    expect(m.notify).toHaveBeenCalledTimes(1)
    expect(m.notify).toHaveBeenCalledWith('可以查看结果了', expect.objectContaining({ body: '「测试会话」已结束本次处理，结果已可查看。', tag: 's1:r1' }))
    m.notify.mock.calls[0][1].onOpen()
    expect(m.navigate).toHaveBeenCalledWith('/chat?session=s1')
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('s1')
    expect(m.start).not.toHaveBeenCalled()
    expect(JSON.stringify(m.notify.mock.calls)).not.toContain('PRIVATE OUTPUT')
  })
  it('ignores snapshots, running and stopped runs', async () => {
    await act(async () => {
      emit({ session_id: 's1', status: 'idle' }); emit({ ...settled, status: 'running' })
      emit({ session_id: 's1', status: 'aborting', run_id: 'r1' }); emit(settled)
    })
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('reports interaction without the question or choices', async () => {
    m.messages.mockResolvedValue({ items: [{ role: 'assistant', content: 'LLM Running (Turn 1) ...\n🛠️ Tool: `ask_user`  📥 args:\n````text\n' + JSON.stringify({ question: 'PRIVATE QUESTION', candidates: ['PRIVATE CHOICE'] }) + '\n````' }] })
    await act(async () => emit(settled))
    expect(m.notify).toHaveBeenCalledWith('需要你回复一下', expect.objectContaining({ body: '「测试会话」有问题需要你回答，回复后即可继续。', confirmText: '前往回复' }))
    expect(JSON.stringify(m.notify.mock.calls)).not.toContain('PRIVATE')
  })
  it.each([
    '🛠️ ask_user(请补充部署目标。)',
    'LLM Running (Turn 1) ...\n🛠️ Tool: `ask_user`  📥 args:\n````text\n{"question":"请补充部署目标。","candidates":[]}\n````\nLLM Running (Turn 2) ...\n<summary>等待回复</summary>',
  ])('reports a current ask_user even without candidates: %s', async (content) => {
    m.messages.mockResolvedValue({ items: [{ role: 'assistant', run_id: 'r1', content }] })
    await act(async () => emit(settled))
    expect(m.notify).toHaveBeenCalledWith('需要你回复一下', expect.objectContaining({ body: '「测试会话」有问题需要你回答，回复后即可继续。', confirmText: '前往回复' }))
    expect(JSON.stringify(m.notify.mock.calls)).not.toContain('部署目标')
  })
  it.each([
    'LLM Running (Turn 1) ...\n🛠️ ask_user(请选择环境\ncandidates:\n- 测试\n- 生产)\nLLM Running (Turn 2) ...\n已经完成部署。',
    '```text\n🛠️ ask_user(只是示例)\n```',
    '🛠️ ask_user(请选择环境)\n已经完成部署。',
  ])('reports a result instead of reviving a historical or quoted question: %s', async (content) => {
    m.messages.mockResolvedValue({ items: [{ role: 'assistant', content }] })
    await act(async () => emit(settled))
    expect(m.notify).toHaveBeenCalledWith('可以查看结果了', expect.objectContaining({ tag: 's1:r1' }))
  })
  it('does not notify a cancelled outcome even with an error', async () => {
    await act(async () => emit({ ...settled, outcome: 'cancelled', error: 'PRIVATE ERROR' }))
    expect(m.messages).not.toHaveBeenCalled()
    expect(m.notify).not.toHaveBeenCalled()
  })
  it.each([{ outcome: 'failed' }, { error: 'PRIVATE ERROR' }])('reports failure once without fetching output: %s', async (failure) => {
    await act(async () => { emit({ ...settled, ...failure }); emit({ ...settled, ...failure }) })
    expect(m.messages).not.toHaveBeenCalled()
    expect(m.notify).toHaveBeenCalledTimes(1)
    expect(m.notify).toHaveBeenCalledWith('会话处理失败', expect.objectContaining({
      body: '「测试会话」本次处理未能完成，请进入会话查看原因。', confirmText: '查看会话', tag: 's1:r1',
    }))
    expect(JSON.stringify(m.notify.mock.calls)).not.toContain('PRIVATE ERROR')
    m.notify.mock.calls[0][1].onOpen()
    expect(m.navigate).toHaveBeenCalledWith('/chat?session=s1')
  })
  it.each([
    { role: 'assistant', run_id: 'r2' },
    { role: 'assistant', run_id: 'r1', outcome: 'cancelled' },
    { role: 'assistant', run_id: 'r1', outcome: 'failed' },
    { role: 'user', run_id: 'r1' },
  ])('does not classify another run, cancelled output or a user reply as pending: %s', async (message) => {
    m.messages.mockResolvedValue({ items: [{ ...message, content: '🛠️ ask_user(请确认环境。)' }] })
    await act(async () => emit(settled))
    expect(m.notify).toHaveBeenCalledWith('会话有更新', expect.objectContaining({ tag: 's1:r1', confirmText: '查看会话' }))
  })
  it('falls back to a generic result if messages cannot be read', async () => {
    m.messages.mockRejectedValue(new Error('offline'))
    await act(async () => emit(settled))
    expect(m.notify).toHaveBeenCalledWith('会话有更新', expect.objectContaining({ tag: 's1:r1', confirmText: '查看会话' }))
  })
  it('reports incoming WeChat messages without exposing the message', () => {
    m.handlers.get('wechat:incoming')?.({ payload: { content: 'PRIVATE MESSAGE' } })
    expect(m.notify).toHaveBeenCalledWith('你有新的微信消息', expect.objectContaining({ body: '可以进入微信查看。', confirmText: '查看微信' }))
    m.notify.mock.calls[0][1].onOpen()
    expect(m.navigate).toHaveBeenCalledWith('/wechat')
  })
  it('retains different completions', async () => {
    await act(async () => { emit(settled); emit({ ...settled, completed_run_id: 'r2' }) })
    expect(m.notify).toHaveBeenCalledTimes(2)
  })
  it('opens each completion target instead of the last active session', async () => {
    localStorage.setItem(storageKeys.currentSessionId, 'last-active')
    await act(async () => {
      emit(settled)
      emit({ ...settled, session_id: 's2', completed_run_id: 'r2' })
    })
    expect(m.notify).toHaveBeenCalledTimes(2)
    expect(m.navigate).not.toHaveBeenCalled()
    const first = m.notify.mock.calls.find(([, opts]) => opts.tag === 's1:r1')![1]
    const second = m.notify.mock.calls.find(([, opts]) => opts.tag === 's2:r2')![1]
    second.onOpen()
    expect(m.navigate).toHaveBeenLastCalledWith('/chat?session=s2')
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('s2')
    first.onOpen()
    expect(m.navigate).toHaveBeenLastCalledWith('/chat?session=s1')
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('s1')
    expect(m.start).not.toHaveBeenCalled()
  })
  it('reports workflow failure without exposing errors and opens Conductor', () => {
    m.handlers.get('conductor:workflow_failed')?.({ payload: { status: 'failed', request_id: 'w1', error: 'PRIVATE ERROR' } })
    expect(m.notify).toHaveBeenCalledWith('Conductor 流程失败', expect.objectContaining({
      body: '本次流程未能完成，请进入 Conductor 查看原因。', confirmText: '查看流程', tag: 'conductor-task-failed:w1',
    }))
    expect(JSON.stringify(m.notify.mock.calls)).not.toContain('PRIVATE ERROR')
    m.notify.mock.calls[0][1].onOpen()
    expect(m.navigate).toHaveBeenCalledWith('/conductor')
  })
  it.each(['cancelled', 'killed'])('does not alert for a %s workflow', (status) => {
    m.handlers.get('conductor:workflow_failed')?.({ payload: { status, error: 'PRIVATE ERROR' } })
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('reports workflow completion without output, not per-turn outcomes', () => {
    m.handlers.get('conductor:workflow_completed')?.({ payload: { item: { msg: 'PRIVATE' } } })
    expect(m.notify).toHaveBeenCalledWith('流程结果可以查看了', expect.objectContaining({ body: 'Conductor 本次流程已结束，可以查看结果了。', confirmText: '查看流程' }))
    expect(m.handlers.has('conductor:request_outcome')).toBe(false)
  })
})
