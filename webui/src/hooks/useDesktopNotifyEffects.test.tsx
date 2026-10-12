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
    expect(m.notify).toHaveBeenCalledWith('会话有新结果', expect.objectContaining({ body: '「测试会话」已完成本轮任务，请进入会话查看结果。', tag: 's1:r1' }))
    m.notify.mock.calls[0][1].onOpen()
    expect(m.start).toHaveBeenCalledWith('s1'); expect(m.navigate).toHaveBeenCalledWith('/chat')
    expect(JSON.stringify(m.notify.mock.calls)).not.toContain('PRIVATE OUTPUT')
  })
  it('ignores snapshots, running, errors and stopped runs', async () => {
    await act(async () => {
      emit({ session_id: 's1', status: 'idle' }); emit({ ...settled, status: 'running' }); emit({ ...settled, error: 'failure' })
      emit({ session_id: 's1', status: 'aborting', run_id: 'r1' }); emit(settled)
    })
    expect(m.notify).not.toHaveBeenCalled()
  })
  it('reports interaction without the question or choices', async () => {
    m.messages.mockResolvedValue({ items: [{ role: 'assistant', content: 'LLM Running (Turn 1) ...\n🛠️ Tool: `ask_user`  📥 args:\n````text\n' + JSON.stringify({ question: 'PRIVATE QUESTION', candidates: ['PRIVATE CHOICE'] }) + '\n````' }] })
    await act(async () => emit(settled))
    expect(m.notify).toHaveBeenCalledWith('会话需要互动', expect.objectContaining({ body: '「测试会话」需要你的回复，请进入会话继续。' }))
    expect(JSON.stringify(m.notify.mock.calls)).not.toContain('PRIVATE')
  })
  it('retains different completions', async () => {
    await act(async () => { emit(settled); emit({ ...settled, completed_run_id: 'r2' }) })
    expect(m.notify).toHaveBeenCalledTimes(2)
  })
  it('reports workflow completion without output, not per-turn outcomes', () => {
    m.handlers.get('conductor:workflow_completed')?.({ payload: { item: { msg: 'PRIVATE' } } })
    expect(m.notify).toHaveBeenCalledWith('Conductor 任务完成', expect.objectContaining({ body: '任务已完成，请进入 Conductor 查看结果。' }))
    expect(m.handlers.has('conductor:request_outcome')).toBe(false)
  })
})
