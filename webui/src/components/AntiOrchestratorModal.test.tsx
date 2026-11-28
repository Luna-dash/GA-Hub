// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/api/client'
import { AntiOrchestratorModal } from './AntiOrchestratorModal'

const antiApiMock = vi.hoisted(() => ({
  models: vi.fn(),
  modelsConfig: vi.fn(),
  syncModels: vi.fn(),
  updateModelsConfig: vi.fn(),
  updateProfileOrchestrator: vi.fn(),
}))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, antiApi: antiApiMock }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AntiOrchestratorModal', () => {
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
  })

  it('renders query errors with retry, disables saving over failed config, and formats mutation errors', async () => {
    antiApiMock.models.mockRejectedValueOnce(new HttpError(500, { detail: '目录服务异常' }))
    antiApiMock.modelsConfig.mockRejectedValueOnce(new HttpError(500, { detail: '配置读取失败' }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AntiOrchestratorModal open onClose={() => {}} profileId="p1" />
        </QueryClientProvider>,
      )
    })

    await vi.waitFor(() => {
      const dialog = document.body.querySelector('[role="dialog"]')!
      expect(dialog.textContent).toContain('上游模型目录加载失败：目录服务异常')
      expect(dialog.textContent).toContain('模型配置加载失败（已禁用保存以防覆盖）：配置读取失败')
    })

    const dialog = document.body.querySelector('[role="dialog"]')!
    const saveBtn = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === '保存设置') as HTMLButtonElement
    const resetBtn = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === '恢复默认') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    expect(resetBtn.disabled).toBe(true)

    // Retry both queries to recover
    antiApiMock.models.mockResolvedValue({ items: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', family: 'claude' }], synced_at: null })
    antiApiMock.modelsConfig.mockResolvedValue({ config_path: '', orchestrator_presets: [], hidden_models: [] })

    const retryButtons = Array.from(dialog.querySelectorAll('button')).filter(b => b.textContent === '重试') as HTMLButtonElement[]
    expect(retryButtons).toHaveLength(2)
    await act(async () => {
      retryButtons[0].click()
      retryButtons[1].click()
    })

    await vi.waitFor(() => {
      expect(saveBtn.disabled).toBe(false)
    })

    // Mutation errors format structured HttpError bodies cleanly
    antiApiMock.syncModels.mockRejectedValueOnce(new HttpError(502, { detail: { message: '上游同步超时' } }))
    const syncBtn = dialog.querySelector<HTMLButtonElement>('button[aria-label="同步上游模型"]')!
    await act(async () => { syncBtn.click() })
    await vi.waitFor(() => {
      expect(dialog.textContent).toContain('上游同步超时')
    })

    antiApiMock.updateModelsConfig.mockRejectedValueOnce(new HttpError(400, { message: '预设名称非法' }))
    await act(async () => { saveBtn.click() })
    await vi.waitFor(() => {
      expect(dialog.textContent).toContain('预设名称非法')
    })
  })

  it('displays filtered legacy count and saves hide_legacy_models toggle', async () => {
    antiApiMock.models.mockResolvedValue({
      items: [
        { id: 'gemini-4-hydrogen', display_name: 'Gemini 4 Hydrogen', efforts: ['low', 'high'] },
      ],
      source: 'acp',
      filtered_legacy_count: 3,
      synced_at: '2026-11-28T09:00:00+08:00',
    })
    antiApiMock.modelsConfig.mockResolvedValue({
      config_path: '',
      orchestrator_presets: [],
      hidden_models: [],
      hide_legacy_models: true,
    })
    antiApiMock.updateModelsConfig.mockResolvedValue({
      config_path: '',
      orchestrator_presets: [],
      hidden_models: [],
      hide_legacy_models: false,
    })
    antiApiMock.updateProfileOrchestrator.mockResolvedValue({ profile_id: 'p1', planner: null, executor: null })

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AntiOrchestratorModal open onClose={() => {}} profileId="p1" />
        </QueryClientProvider>,
      )
    })

    await vi.waitFor(() => {
      const dialog = document.body.querySelector('[role="dialog"]')!
      expect(dialog.textContent).toContain('共 1 个模型（已隐藏 3 个旧模型） · ACP')
    })

    const dialog = document.body.querySelector('[role="dialog"]')!
    const toggle = dialog.querySelector<HTMLInputElement>('input[aria-label="自动隐藏旧世代模型"]')!
    expect(toggle.checked).toBe(true)

    await act(async () => { toggle.click() })
    expect(toggle.checked).toBe(false)

    const saveBtn = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === '保存设置') as HTMLButtonElement
    await act(async () => { saveBtn.click() })

    await vi.waitFor(() => {
      expect(antiApiMock.updateModelsConfig).toHaveBeenCalledWith(expect.objectContaining({
        hide_legacy_models: false,
      }))
    })
  })
})
