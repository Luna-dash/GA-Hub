import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Memory from './Memory'
import { readPageState, resetPageState, writePageState } from '@/utils/pageState'

const api = vi.hoisted(() => ({
  sops: vi.fn(async () => ({ sops: [] })),
  sop: vi.fn(async () => ({ content: 'SOP body', version: 'v1' })),
  skills: vi.fn(async () => ({ skills: [] })),
  insight: vi.fn(async () => ({ content: 'L1 body', version: 'v1' })),
  globalMem: vi.fn(async () => ({ content: 'L2 body', version: 'v1' })),
}))
vi.mock('@/api/client', () => ({ api }))
vi.mock('@/components/VersionedMemoryEditor', () => ({
  VersionedMemoryEditor: ({ label }: { label: string }) => <output data-editor>{label}</output>,
}))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Navigation() {
  const navigate = useNavigate()
  const location = useLocation()
  return <>
    <output data-location>{location.pathname + location.search}</output>
    <button data-nav="global" onClick={() => navigate('/memory?tab=global')}>Global link</button>
    <button data-nav="plain" onClick={() => navigate('/memory')}>Plain link</button>
    <button data-nav="sop" onClick={() => navigate('/memory?tab=sop')}>SOP link</button>
  </>
}

describe('Memory tab deep links', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  beforeEach(() => {
    resetPageState()
    vi.clearAllMocks()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
    resetPageState()
  })
  async function mount(url: string) {
    await act(async () => root.render(
      <MemoryRouter initialEntries={[url]}>
        <QueryClientProvider client={client}><Navigation /><Memory /></QueryClientProvider>
      </MemoryRouter>,
    ))
  }
  function tab(label: string) {
    return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === label)!
  }
  function expectSelected(label: string) {
    expect(tab(label).getAttribute('aria-selected')).toBe('true')
    expect(tab(label).className).toContain('ga-segmented-btn-active')
  }
  async function navigate(name: string) {
    await act(async () => (host.querySelector(`[data-nav="${name}"]`) as HTMLButtonElement).click())
  }

  it.each([
    ['sop', 'SOP'], ['skill', 'SKILL'], ['insight', 'L1'], ['global', 'L2'],
  ])('applies tab=%s once and permits subsequent manual selection', async (value, label) => {
    writePageState('memory.tab', value === 'sop' ? 'global' : 'sop')
    await mount(`/memory?tab=${value}`)
    expectSelected(label)
    const next = label === 'SKILL' ? 'SOP' : 'SKILL'
    await act(async () => tab(next).click())
    expectSelected(next)
    expect(readPageState('memory.tab', '')).toBe(next === 'SKILL' ? 'skill' : 'sop')
  })

  it('applies later deep links while mounted and resets after removing the parameter', async () => {
    await mount('/memory?tab=sop')
    await act(async () => tab('SKILL').click())
    await navigate('global')
    expectSelected('L2')
    await act(async () => tab('SKILL').click())
    expectSelected('SKILL')
    await navigate('plain')
    expectSelected('SKILL')
    await navigate('sop')
    expectSelected('SOP')
  })

  it('reapplies an identical deep link on a new navigation', async () => {
    await mount('/memory?tab=sop')
    await act(async () => tab('SKILL').click())
    expectSelected('SKILL')
    await navigate('sop')
    expectSelected('SOP')
    await act(async () => tab('SKILL').click())
    expectSelected('SKILL')
  })

  it('keeps remembered selection for missing or invalid tab parameters', async () => {
    writePageState('memory.tab', 'skill')
    await mount('/memory?tab=unknown')
    expectSelected('SKILL')
    await navigate('plain')
    expectSelected('SKILL')
  })

  it('opens the requested SOP, clears its filter, and permits tab switching', async () => {
    writePageState('memory.tab', 'global')
    writePageState('memory.sopQuery', 'other')
    await mount('/memory?tab=sop&sop=deploy_sop.md')
    expectSelected('SOP')
    expect(api.sop).toHaveBeenCalledWith('deploy_sop.md')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(host.querySelector('[data-editor]')?.textContent).toBe('memory/deploy_sop.md')
    expect(host.querySelector('input')?.value).toBe('')
    expect(host.querySelector('[data-location]')?.textContent).toBe('/memory')
    await act(async () => tab('SKILL').click())
    expectSelected('SKILL')
  })

  it('supports arrow-key, Home/End, and roving tabIndex navigation across Memory tabs', async () => {
    await mount('/memory?tab=sop')
    expect(tab('SOP').tabIndex).toBe(0)
    expect(tab('SKILL').tabIndex).toBe(-1)
    expect(tab('L1').tabIndex).toBe(-1)
    expect(tab('L2').tabIndex).toBe(-1)

    tab('SOP').focus()
    await act(async () => tab('SOP').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expectSelected('SKILL')
    expect(tab('SKILL').tabIndex).toBe(0)
    expect(tab('SOP').tabIndex).toBe(-1)
    expect(document.activeElement).toBe(tab('SKILL'))

    await act(async () => tab('SKILL').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expectSelected('L2')
    expect(document.activeElement).toBe(tab('L2'))

    await act(async () => tab('L2').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expectSelected('SOP')
    expect(document.activeElement).toBe(tab('SOP'))

    await act(async () => tab('SOP').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expectSelected('L2')
    expect(document.activeElement).toBe(tab('L2'))

    await act(async () => tab('L2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expectSelected('SOP')
    expect(document.activeElement).toBe(tab('SOP'))
  })
})
