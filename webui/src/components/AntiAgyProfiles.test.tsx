// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/api/client'
import { AntiAgyProfiles, useAgyProfiles } from './AntiAgyProfiles'

const antiApiMock = vi.hoisted(() => ({
  startCodeLogin: vi.fn(),
  submitCodeLogin: vi.fn(),
  codeLoginStatus: vi.fn(),
  cancelCodeLogin: vi.fn(),
  switchProfile: vi.fn(),
  captureProfile: vi.fn(),
  deleteProfile: vi.fn(),
  clearProfileCredentials: vi.fn(),
  accountUsage: vi.fn(),
}))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, antiApi: antiApiMock }
})
vi.mock('@/runtime/runtimeConfig', () => ({ resolveApiUrl: (p: string) => p }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  const profiles = useAgyProfiles()
  return <AntiAgyProfiles profiles={profiles} refresh={() => {}} open onOpenChange={() => {}} />
}

describe('AntiAgyProfiles error surfacing & pinned feedback', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
    vi.unstubAllGlobals()
  })

  it('pins feedback above the scroll area, unwraps structured detail in request(), and surfaces manual code-login refresh errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/anti/profiles' && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            active: 'p1',
            login_profile: null,
            profiles: [{ id: 'p1', name: '主力', has_credentials: true, auth_state: 'authenticated' }],
          }),
        }
      }
      if (url === '/api/anti/profiles/p1' && init?.method === 'PATCH') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ detail: { message: '备注名重复', code: 'dup' } }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      )
    })

    await vi.waitFor(() => {
      expect(document.body.querySelector('button[aria-label="账号设置：主力"]')).not.toBeNull()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="账号设置：主力"]')!.click()
    })

    // Trigger structured detail error in request() via rename
    const input = document.body.querySelector<HTMLInputElement>('#agy-edit-name')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新备注')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const saveBtn = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent === '保存备注') as HTMLButtonElement
    await act(async () => { saveBtn.click() })

    await vi.waitFor(() => {
      const pinned = document.body.querySelector('[data-anti-profiles-pinned-feedback]')!
      expect(pinned).not.toBeNull()
      expect(pinned.className).not.toContain('overflow-y-auto')
      expect(pinned.querySelector('[role="alert"]')?.textContent).toBe('备注名重复')
    })

    // Trigger code-login flow and fail manual 刷新
    antiApiMock.startCodeLogin.mockResolvedValue({
      flow_id: 'flow-1',
      profile_id: 'p1',
      phase: 'waiting_code',
      authorization_url: 'https://accounts.google.com/o/oauth2/auth',
    })
    antiApiMock.codeLoginStatus.mockRejectedValueOnce(new HttpError(503, { detail: '授权服务暂不可用' }))
    antiApiMock.cancelCodeLogin.mockResolvedValue({})

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="授权码登录：主力"]')!.click()
    })
    await vi.waitFor(() => {
      expect(document.body.querySelector('button[aria-label="刷新授权状态"]')).not.toBeNull()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新授权状态"]')!.click()
    })
    await vi.waitFor(() => {
      const pinned = document.body.querySelector('[data-anti-profiles-pinned-feedback]')!
      expect(pinned.querySelector('[role="alert"]')?.textContent).toBe('授权服务暂不可用')
    })
  })

  it('resets codeLoginStart and codeLoginSubmit errors when navigating back to the list view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        active: 'p1',
        login_profile: null,
        profiles: [{ id: 'p1', name: '主力', has_credentials: true, auth_state: 'authenticated' }],
      }),
    })))
    antiApiMock.startCodeLogin.mockRejectedValueOnce(new HttpError(500, { detail: '生成链接失败' }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      )
    })

    await vi.waitFor(() => {
      expect(document.body.querySelector('button[aria-label="账号设置：主力"]')).not.toBeNull()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="账号设置：主力"]')!.click()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="授权码登录：主力"]')!.click()
    })

    await vi.waitFor(() => {
      const pinned = document.body.querySelector('[data-anti-profiles-pinned-feedback]')!
      expect(pinned.querySelector('[role="alert"]')?.textContent).toBe('生成链接失败')
    })

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="返回账号列表"]')!.click()
    })

    expect(document.body.querySelector('ul[aria-label="账号列表"]')).not.toBeNull()
    expect(document.body.querySelector('[data-anti-profiles-pinned-feedback] [role="alert"]')).toBeNull()
  })
})
