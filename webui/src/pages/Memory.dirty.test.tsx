// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Memory from './Memory'
import { DialogHost } from '@/components/DialogHost'
import { GuardedLink } from '@/components/GuardedLink'
import { api } from '@/api/client'
import { dialog, useDialogStore } from '@/stores/dialogStore'
import { hasDirtyGuard, resetNavigationGuardsForTests } from '@/stores/navigationGuardStore'
import { resetPageState } from '@/utils/pageState'

vi.mock('@/api/client', () => ({
  api: {
    sops: vi.fn(),
    sop: vi.fn(),
    setSop: vi.fn(),
    skills: vi.fn(),
    skill: vi.fn(),
    insight: vi.fn(),
    setInsight: vi.fn(),
    globalMem: vi.fn(),
    setGlobalMem: vi.fn(),
  },
}))
vi.mock('@/components/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="编辑器" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

function SopDeepLink() {
  const navigate = useNavigate()
  const location = useLocation()
  return <>
    <button onClick={() => navigate('/memory?tab=sop&sop=beta.md&keep=1')}>Open beta deep link</button>
    <output data-location>{location.search}</output>
  </>
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Memory unsaved draft guard', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    resetPageState()
    vi.mocked(api.sops).mockResolvedValue({
      sops: [
        { name: 'alpha.md', size: 100 },
        { name: 'beta.md', size: 120 },
      ],
    } as never)
    vi.mocked(api.sop).mockImplementation(async (name: string) => ({
      content: `${name} content`,
      mtime_ns: '1',
      sha256: `sha-${name}`,
    }) as never)
    vi.mocked(api.skills).mockResolvedValue({ skills: [] } as never)
    vi.mocked(api.insight).mockResolvedValue({ content: 'insight', mtime_ns: '1', sha256: 's1' } as never)
    vi.mocked(api.globalMem).mockResolvedValue({ content: 'global', mtime_ns: '1', sha256: 's2' } as never)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    client.clear()
    resetPageState()
    resetNavigationGuardsForTests()
    useDialogStore.setState({
      open: false, config: null, resolve: null, queue: [],
      notificationConfig: null, notificationResolve: null, notificationQueue: [],
    })
    vi.restoreAllMocks()
  })

  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })

  function setEditorText(value: string) {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑器"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function clickText(text: string) {
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!
    expect(btn, `Missing button ${text}`).toBeTruthy()
    act(() => { btn.click() })
  }

  it('guards switching SOP documents and Memory tabs while editor is dirty', async () => {
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/memory?tab=sop&sop=alpha.md']}>
        <QueryClientProvider client={client}>
          <Memory />
        </QueryClientProvider>
      </MemoryRouter>,
    ))
    await settle()

    setEditorText('unsaved alpha draft')
    clickText('beta.md')
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑器"]')?.value).toBe('unsaved alpha draft')

    clickText('L1')
    await settle()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('memory/global_mem_insight.txt')
  })

  it.each([
    ['SOP', '/memory?tab=sop&sop=alpha.md', 'memory/alpha.md', 'alpha.md'],
    ['L1', '/memory?tab=insight', 'memory/global_mem_insight.txt', undefined],
  ])('guards a SOP deep link from a dirty %s editor', async (_tab, path, currentLabel, currentSop) => {
    let finishConfirm!: (ok: boolean) => void
    const confirmSpy = vi.spyOn(dialog, 'confirm')
      .mockImplementationOnce(() => new Promise((resolve) => { finishConfirm = resolve }))
      .mockResolvedValueOnce(true)
    await act(async () => root.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <SopDeepLink />
          <Memory />
        </QueryClientProvider>
      </MemoryRouter>,
    ))
    const editor = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑器"]')
    await vi.waitFor(() => expect(editor()).not.toBeNull())

    setEditorText('unsaved draft')
    clickText('Open beta deep link')
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(editor()?.value).toBe('unsaved draft')
    expect(vi.mocked(api.sop).mock.calls.map(([name]) => name)).toEqual(currentSop ? [currentSop] : [])

    await act(async () => finishConfirm(false))
    expect(host.querySelector('[data-location]')?.textContent).toBe('?keep=1')
    expect(host.textContent).toContain(currentLabel)
    expect(editor()?.value).toBe('unsaved draft')

    clickText('Open beta deep link')
    await settle()
    await vi.waitFor(() => expect(editor()?.value).toBe('beta.md content'))
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('memory/beta.md')
    expect(host.querySelector('[data-location]')?.textContent).toBe('?keep=1')
  })

  it('blocks SPA route navigation via GuardedLink when Memory editor is dirty until confirmed', async () => {
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    function NavProbe() {
      const loc = useLocation()
      return <>
        <GuardedLink to="/chat">Go Chat</GuardedLink>
        <output data-path>{loc.pathname}</output>
      </>
    }
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/memory?tab=insight']}>
        <QueryClientProvider client={client}>
          <NavProbe />
          <Routes>
            <Route path="/memory" element={<Memory />} />
            <Route path="/chat" element={<div>Chat Page</div>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    ))
    await vi.waitFor(() => expect(host.querySelector('textarea[aria-label="编辑器"]')).not.toBeNull())
    expect(hasDirtyGuard()).toBe(false)

    setEditorText('dirty insight draft')
    expect(hasDirtyGuard()).toBe(true)

    const link = host.querySelector<HTMLAnchorElement>('a[href="/chat"]')!
    await act(async () => link.click())
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-path]')?.textContent).toBe('/memory')
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑器"]')?.value).toBe('dirty insight draft')

    await act(async () => link.click())
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-path]')?.textContent).toBe('/chat')
    expect(hasDirtyGuard()).toBe(false)
  })

  it('keeps tab selection and focus on current tab when arrow-key switch is cancelled on dirty editor', async () => {
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/memory?tab=insight']}>
        <QueryClientProvider client={client}>
          <Memory />
        </QueryClientProvider>
      </MemoryRouter>,
    ))
    await vi.waitFor(() => expect(host.querySelector('textarea[aria-label="编辑器"]')).not.toBeNull())
    setEditorText('unsaved insight')

    const l1Tab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent === 'L1')!
    const l2Tab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent === 'L2')!
    l1Tab.focus()
    await act(async () => l1Tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(l1Tab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(l1Tab)

    await act(async () => l1Tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(l2Tab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(l2Tab)
  })

  it('keeps focus on old tab on Cancel and on new active tab on Confirm with real DialogHost', async () => {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/memory?tab=insight']}>
        <QueryClientProvider client={client}>
          <Memory />
          <DialogHost />
        </QueryClientProvider>
      </MemoryRouter>,
    ))
    await vi.waitFor(() => expect(host.querySelector('textarea[aria-label="编辑器"]')).not.toBeNull())
    setEditorText('unsaved insight')

    const tabs = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="记忆层级"] [role="tab"]'))
    const l1Tab = tabs().find((b) => b.textContent === 'L1')!
    const l2Tab = tabs().find((b) => b.textContent === 'L2')!
    l1Tab.focus()

    // ArrowRight opens real DialogHost confirm -> Cancel keeps selection & restores focus to L1
    await act(async () => {
      l1Tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const cancelBtn = host.querySelector<HTMLButtonElement>('[role="dialog"] [data-cancel]')!
    expect(cancelBtn).not.toBeNull()
    await act(async () => { cancelBtn.click() })
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(l1Tab.getAttribute('aria-selected')).toBe('true')
    expect(l1Tab.tabIndex).toBe(0)
    expect(document.activeElement).toBe(l1Tab)

    // ArrowRight -> Confirm ("放弃修改") switches to L2 and keeps focus on L2 (not stolen back to L1)
    await act(async () => {
      l1Tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const confirmBtn = host.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm]')!
    expect(confirmBtn).not.toBeNull()
    await act(async () => { confirmBtn.click() })
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(l2Tab.getAttribute('aria-selected')).toBe('true')
    expect(l2Tab.tabIndex).toBe(0)
    expect(l1Tab.getAttribute('aria-selected')).toBe('false')
    expect(l1Tab.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(l2Tab)
  })
})
