// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ThemeTasks from './ThemeTasks'
import { api } from '@/api/client'
import { writeClipboard } from '@/utils/clipboard'
import { writeRecentInstructions, readRecentInstructions } from '@/utils/themeTaskActions'

vi.mock('@/utils/clipboard', () => ({ writeClipboard: vi.fn() }))
vi.mock('@/api/client', () => ({ api: {
  getSessionMessages: vi.fn(),
  startThemeRun: vi.fn(async () => ({})),
  abortSession: vi.fn(async () => ({})),
  themeConfig: vi.fn(async () => ({})),
  updateSessionModel: vi.fn(async () => ({})),
  sessions: vi.fn(async () => ({ items: [{ id: 'one', title: '签到', llm_key: 'model', theme_task: { title: '签到', instruction: '检查签到' } }] })),
  themeRun: vi.fn(async () => ({ run: { started_at: 10, finished_at: 20, turns: 2, outcome: 'completed', report: '**LLM Running (Turn 1) ...**\n<summary>检查</summary>\n过程转储\n**LLM Running (Turn 2) ...**\n<summary>完成</summary>\n最终：签到成功。' } })),
  sessionRuntime: vi.fn(async () => ({ status: 'idle' })),
  llms: vi.fn(async () => ({ llms: [{ key: 'model', name: '执行模型' }] })),
} }))
const ev = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown) => void>(), states: [] as ((s: string) => void)[] }))
vi.mock('@/runtime/hubEventClient', () => ({ hubEventClient: {
  subscribe: (topic: string, fn: (e: unknown) => void) => { ev.handlers.set(topic, fn); return () => { ev.handlers.delete(topic) } },
  subscribeState: (fn: (s: string) => void) => { ev.states.push(fn); return () => { ev.states = ev.states.filter(f => f !== fn) } },
} }))
vi.mock('@/components/MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <div>{content}</div> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, client: QueryClient
beforeEach(async () => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(writeClipboard).mockReset().mockResolvedValue(true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><ThemeTasks /></MemoryRouter></QueryClientProvider>) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
})
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove() })
it('expands only with the explicit control and keeps details within the page', () => {
  const card = host.querySelector('[aria-label="主题任务卡片：签到"]') as HTMLElement
  const expand = host.querySelector('[aria-label="打开主题任务：签到"]') as HTMLButtonElement
  expect(card.textContent).toContain('执行模型')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  act(() => card.click())
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')).toBeNull()
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  act(() => expand.click())
  const details = host.querySelector('[aria-label="主题任务详情：签到"]')!
  expect(card.contains(details)).toBe(true)
  expect(card.className).toContain('col-span-full')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(details.className).not.toMatch(/fixed|inset-0|w-screen/)
  expect(host.querySelector('h1')?.textContent).toBe('主题任务')
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(details.textContent).toContain('最终：签到成功。')
  expect(details.textContent).not.toContain('过程转储')
  expect(card.querySelectorAll('header [role=tab]')).toHaveLength(3)
  expect(card.querySelector('header')?.textContent).toContain('会话历史')
  expect(api.getSessionMessages).not.toHaveBeenCalled()
  act(() => expand.click())
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')).toBeNull()
})

const wait = (ms = 25) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const run = { run_id: 'r', started_at: 10, finished_at: 20, turns: 2, outcome: 'completed', report: '结论' }
async function click(label: string) {
  const target = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === label || b.textContent?.includes(label))
  expect(target, label).toBeTruthy()
  await act(async () => { target!.click() })
  await wait()
}
const runtimeCalls = () => vi.mocked(api.sessionRuntime).mock.calls.length

it('shows an always-visible icon shortcut on the compact card', () => {
  const launch = host.querySelector('[aria-label="运行主题任务：签到"]')!
  expect(launch).not.toBeNull()
  expect(launch.textContent).toBe('')
  expect(launch.className).not.toContain('opacity-0')
})

it('stays quiet while idle and refreshes only the card named by a runtime event', async () => {
  const before = runtimeCalls()
  await wait(60)
  expect(runtimeCalls()).toBe(before)
  act(() => ev.handlers.get('session:runtime')?.({ topic: 'session:runtime', payload: { session_id: 'other' } }))
  await wait()
  expect(runtimeCalls()).toBe(before)
  act(() => ev.handlers.get('session:runtime')?.({ topic: 'session:runtime', payload: { session_id: 'one' } }))
  await wait()
  expect(runtimeCalls()).toBe(before + 1)
})

it('refreshes every card once after the event socket reconnects', async () => {
  const before = runtimeCalls()
  act(() => { ev.states.forEach(f => f('closed')); ev.states.forEach(f => f('open')) })
  await wait()
  expect(runtimeCalls()).toBe(before + 1)
})

it('opens the conclusion requested by a notification link', async () => {
  act(() => root.unmount())
  localStorage.clear()
  vi.mocked(writeClipboard).mockReset().mockResolvedValue(true)
  vi.mocked(api.getSessionMessages).mockReset()
  root = createRoot(host)
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/theme-tasks?open=one']}><ThemeTasks /></MemoryRouter></QueryClientProvider>) })
  await wait(60)
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')?.textContent).toContain('最终：签到成功。')
})


it('shows the conclusion without a collapse toolbar and copies from the card header', async () => {
  localStorage.setItem('gahub.theme-report:one', 'closed')
  await wait(60); await click('打开主题任务：签到')
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')?.textContent).toContain('最终：签到成功。')
  expect(host.querySelector('button[aria-label="最终结论"]')).toBeNull()
  const copy = host.querySelector('button[aria-label="复制结论"]')!
  expect(copy.closest('header')).not.toBeNull()
  expect(copy.textContent).toBe('')
  expect(host.querySelector('[aria-label="主题任务详情：签到"] button[aria-label="复制结论"]')).toBeNull()
  await click('复制结论')
  expect(writeClipboard).toHaveBeenLastCalledWith('最终：签到成功。')
  expect(host.textContent).toContain('结论已复制')
  vi.mocked(writeClipboard).mockResolvedValueOnce(false)
  await click('复制结论')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('复制失败：请检查剪贴板权限。')
})

it('retrieves the failed run request from session history, then requires explicit confirmation', async () => {
  await wait(60)
  await act(async () => { client.setQueryData(['theme-run', 'one'], { session_id: 'one', run: { ...run, outcome: 'failed', report: '!!! Error: login expired' } }) })
  vi.mocked(api.getSessionMessages).mockResolvedValue({ session_id: 'one', archive_bound: true, items: [{ id: 'q', ordinal: 0, role: 'user', content: '只检查，不签到', run_id: 'r' }], has_more: false, revision: 'v' })
  await click('打开主题任务：签到')
  expect(host.textContent).toContain('login expired')
  await click('取回原指令重试')
  expect((host.querySelector('[aria-label="本次执行指令"]') as HTMLTextAreaElement).value).toBe('只检查，不签到')
  expect(api.startThemeRun).not.toHaveBeenCalled()
  expect(host.textContent).toContain('不会回滚')
  await click('确认重试')
  expect(api.startThemeRun).toHaveBeenCalledWith('one', '只检查，不签到')
  expect(readRecentInstructions('one')).toEqual(['只检查，不签到'])
  expect(api.themeConfig).not.toHaveBeenCalled()
})

it('does not substitute the default when the failed run request is missing', async () => {
  await wait(60)
  await act(async () => { client.setQueryData(['theme-run', 'one'], { session_id: 'one', run: { ...run, outcome: 'failed' } }) })
  vi.mocked(api.getSessionMessages).mockResolvedValue({ session_id: 'one', archive_bound: true, items: [], has_more: false, revision: 'v' })
  await click('打开主题任务：签到'); await click('取回原指令重试')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('未在会话历史中找到')
  expect(api.startThemeRun).not.toHaveBeenCalled()
})

it('reuses recent instructions without starting a run and supports removal and clearing', async () => {
  act(() => root.unmount())
  writeRecentInstructions('one', ['仅检查', '执行签到'])
  root = createRoot(host)
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><ThemeTasks /></MemoryRouter></QueryClientProvider>) })
  await wait(60); await click('打开主题任务：签到'); await click('本次调整')
  const recent = host.querySelector('section[aria-label="最近指令"]')!
  expect(recent).not.toBeNull()
  expect(recent.closest('details')).toBeNull()
  expect(recent.querySelectorAll('button[title]').length).toBe(2)
  await click('仅检查')
  expect((host.querySelector('[aria-label="本次执行指令"]') as HTMLTextAreaElement).value).toBe('仅检查')
  expect(api.startThemeRun).not.toHaveBeenCalled()
  await click('删除最近指令1'); expect(readRecentInstructions('one')).toEqual(['执行签到'])
  await click('清空记录'); expect(readRecentInstructions('one')).toEqual([])
})

async function editPrompt(text: string) {
  const input = host.querySelector('[aria-label="编辑本次启动提示词"]') as HTMLTextAreaElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => { setValue.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

it('edits the compact prompt in a modal without saving the default and blocks blank input', async () => {
  await wait(60)
  const preview = host.querySelector('[aria-label="本次启动提示词：签到"]')!
  expect(preview.tagName).toBe('P')
  expect(preview.textContent).toBe('检查签到')
  expect(host.querySelector('textarea')).toBeNull()
  await click('编辑本次提示词：签到')
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  expect(host.querySelector('section[aria-label="最近指令"]')?.textContent).toContain('暂无记录，执行后保留最近5条不同指令。')
  expect(host.querySelector('section[aria-label="最近指令"]')?.querySelector('button')).toBeNull()
  await editPrompt('')
  await click('保存')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect((host.querySelector('[aria-label="运行主题任务：签到"]') as HTMLButtonElement).disabled).toBe(true)
  await click('编辑本次提示词：签到')
  await editPrompt('仅检查今天的签到结果')
  await click('保存')
  await click('运行主题任务：签到')
  expect(api.startThemeRun).toHaveBeenLastCalledWith('one', '仅检查今天的签到结果')
  expect(api.themeConfig).not.toHaveBeenCalled()
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')).toBeNull()
  expect(readRecentInstructions('one')).toEqual(['仅检查今天的签到结果'])
  await click('打开主题任务：签到')
  expect(preview.textContent).toBe('仅检查今天的签到结果')
})

it('discards modal edits on cancel and Escape without starting a task', async () => {
  await wait(60)
  await click('编辑本次提示词：签到'); await editPrompt('不保存'); await click('取消')
  expect(host.querySelector('[aria-label="本次启动提示词：签到"]')?.textContent).toBe('检查签到')
  await click('编辑本次提示词：签到')
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('检查签到')
  await editPrompt('仍不保存')
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(host.querySelector('[aria-label="本次启动提示词：签到"]')?.textContent).toBe('检查签到')
  expect(api.startThemeRun).not.toHaveBeenCalled()
})

it('uses round controls, switches to stop while running, and moves the spinner to the footer', async () => {
  await wait(60)
  const card = host.querySelector('[aria-label="主题任务卡片：签到"]')!
  expect(host.querySelector('[aria-label="运行主题任务：签到"]')?.className).toContain('rounded-full')
  expect(host.querySelector('[aria-label="打开主题任务：签到"]')?.className).toContain('rounded-full')
  await act(async () => { client.setQueryData(['theme-runtime', 'one'], { status: 'running' }) }); await wait()
  const stop = host.querySelector('[aria-label="停止主题任务：签到"]') as HTMLButtonElement
  expect(stop.disabled).toBe(false)
  expect(stop.querySelector('rect')).not.toBeNull()
  expect((host.querySelector('[aria-label="编辑本次提示词：签到"]') as HTMLButtonElement).disabled).toBe(true)
  const status = card.querySelector('[role="status"]')!
  expect(status.getAttribute('aria-label')).toBe('运行中')
  expect(status.textContent).toBe('')
  expect(status.querySelector('[class*="animate-spin"]')).not.toBeNull()
  expect(card.querySelectorAll('[class*="animate-spin"]').length).toBe(1)
  await click('停止主题任务：签到')
  expect(api.abortSession).toHaveBeenCalledWith('one')
  expect(api.startThemeRun).not.toHaveBeenCalled()
  expect(host.querySelector('[aria-label="运行主题任务：签到"]')).not.toBeNull()
})

it('disables stop while aborting and surfaces stop failures without expanding', async () => {
  await wait(60)
  await act(async () => { client.setQueryData(['theme-runtime', 'one'], { status: 'aborting' }) }); await wait()
  expect((host.querySelector('[aria-label="停止主题任务：签到"]') as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { client.setQueryData(['theme-runtime', 'one'], { status: 'running' }) }); await wait()
  vi.mocked(api.abortSession).mockRejectedValueOnce(new Error('停止失败'))
  await click('停止主题任务：签到')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('停止失败')
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')).toBeNull()
})

it('shows quick-start errors on the compact card without forcing expansion', async () => {
  await wait(60)
  vi.mocked(api.startThemeRun).mockRejectedValueOnce(new Error('启动失败'))
  await click('运行主题任务：签到')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('启动失败')
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')).toBeNull()
})

it('places settings in the compact sidebar and preserves expansion on cancel', async () => {
  expect(host.querySelector('[aria-label="任务设置：签到"]')).toBeNull()
  await click('打开主题任务：签到')
  const settings = host.querySelector('[aria-label="任务设置：签到"]')!
  expect(settings.closest('aside')).not.toBeNull()
  expect(host.querySelector('article header [role=tablist]')).not.toBeNull()
  expect(host.querySelectorAll('h2').length).toBe(1)
  await click('任务设置：签到')
  const dialog = host.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-labelledby')).toBe('theme-settings-title-one')
  expect(dialog.querySelector('footer')).not.toBeNull()
  expect(dialog.textContent).not.toContain('基本信息')
  expect(dialog.querySelector('details summary')?.textContent).toContain('任务描述')
  expect(dialog.textContent).toContain('默认指令')
  expect(dialog.querySelectorAll('select').length).toBe(1)
  await click('取消')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')).not.toBeNull()
  expect(api.themeConfig).not.toHaveBeenCalled()
})

it('saves settings with the existing model key and keeps the expanded card', async () => {
  await click('打开主题任务：签到'); await click('任务设置：签到')
  const dialog = host.querySelector('[role="dialog"]')!
  const input = dialog.querySelector('input')!
  const prompt = dialog.querySelector('[aria-label="默认执行指令"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新签到任务')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, '  新默认指令  ')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('保存')
  expect(api.themeConfig).toHaveBeenCalledWith('one', { instruction: '新默认指令', description: '' }, '新签到任务')
  expect(api.updateSessionModel).not.toHaveBeenCalled()
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(host.querySelector('[aria-label="主题任务详情：签到"]')).not.toBeNull()
})

it('shows one activity animation and one prompt preview when expanded', async () => {
  await act(async () => { client.setQueryData(['theme-runtime', 'one'], { status: 'running' }) }); await wait()
  await click('打开主题任务：签到')
  const card = host.querySelector('article')!
  expect(card.querySelectorAll('[class*="animate-spin"]').length).toBe(1)
  expect(card.querySelectorAll('[aria-label="本次启动提示词：签到"]').length).toBe(1)
  expect((card.querySelector('[aria-label="任务设置：签到"]') as HTMLButtonElement).disabled).toBe(true)
  expect(card.querySelector('aside')?.textContent).toContain('00:10')
  expect(card.querySelector('[aria-label="执行轮次"]')?.textContent).toBe('2turn')
  expect((card.querySelector('[aria-label="移回聊天：签到"]') as HTMLButtonElement).disabled).toBe(true)
})


it('groups consistent sidebar controls and keeps metadata separate from the prompt', async () => {
  await wait(60)
  await click('打开主题任务：签到')
  const sidebar = host.querySelector('aside')!
  const actions = sidebar.querySelector('[aria-label="任务操作"]')!
  const controls = Array.from(actions.querySelectorAll('button'))
  expect(controls.map(b => b.getAttribute('aria-label'))).toEqual(['运行主题任务：签到', '任务设置：签到', '移回聊天：签到'])
  controls.forEach(b => { expect(b.className).toContain('h-7 w-7'); expect(b.className).toContain('rounded-full') })
  controls.slice(1).forEach(b => expect(b.className).toContain('border-slate-500'))
  expect(host.querySelector('[aria-label="收起任务卡片"]')?.className).toContain('border-slate-500')
  expect(sidebar.querySelectorAll('[aria-label="移回聊天：签到"]')).toHaveLength(1)
  expect(sidebar.querySelector('dl [aria-label="已运行"]')?.textContent).toBe('00:10')
  expect(sidebar.querySelector('[aria-label="本次启动提示词：签到"]')?.textContent).toBe('检查签到')
  expect(sidebar.querySelectorAll('dl')).toHaveLength(2)
  await click('移回聊天：签到')
  expect(api.themeConfig).toHaveBeenCalledWith('one', null)
  expect(api.startThemeRun).not.toHaveBeenCalled()
})


it('promotes the expanded card, collapses the previous one, and restores source order', async () => {
  const one = client.getQueryData<{ items: import('@/api/types').HubSession[] }>(['sessions'])?.items[0]
  expect(one).toBeDefined()
  act(() => client.setQueryData(['sessions'], { items: [one, { ...one, id: 'two', title: '第二项', theme_task: { ...one!.theme_task, title: '第二项' } }, { ...one, id: 'three', title: '第三项', theme_task: { ...one!.theme_task, title: '第三项' } }] }))
  await wait(60)
  const cards = () => Array.from(host.querySelectorAll('article[aria-label^="主题任务卡片"]'))
  const original = cards()
  expect(original).toHaveLength(3)
  await click('打开主题任务：第三项')
  expect(cards()).toEqual([original[2], original[0], original[1]])
  expect(host.querySelectorAll('section[aria-label^="主题任务详情"]')).toHaveLength(1)
  await click('打开主题任务：第二项')
  expect(cards()).toEqual([original[1], original[0], original[2]])
  expect(host.querySelector('[aria-label="主题任务详情：第三项"]')).toBeNull()
  expect(host.querySelector('[aria-label="主题任务详情：第二项"]')).not.toBeNull()
  await click('收起任务卡片')
  expect(cards()).toEqual(original)
  expect(host.querySelectorAll('section[aria-label^="主题任务详情"]')).toHaveLength(0)
  expect(api.startThemeRun).not.toHaveBeenCalled()
})
