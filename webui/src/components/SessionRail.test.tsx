// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubSession, SessionRuntime } from '@/api/types'
import { SessionRail } from './SessionRail'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sessions: HubSession[] = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', title: '研究任务', llm_index: null, archive_path: null, created_at: '2026-08-05T08:00:00Z', updated_at: '2026-08-05T09:00:00Z' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', title: '', llm_index: null, archive_path: null, created_at: '2026-08-05T08:00:00Z', updated_at: '2026-08-05T10:00:00Z' },
]
const runtimes: Record<string, SessionRuntime> = {
  'aaaaaaaa-1111-4111-8111-111111111111': { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', status: 'running', run_id: 'run-a', stream_id: 'stream-a' },
  'bbbbbbbb-2222-4222-8222-222222222222': { session_id: 'bbbbbbbb-2222-4222-8222-222222222222', status: 'idle', run_id: null, stream_id: null },
}

describe('SessionRail', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows every session, marks the current one, and selects another session', () => {
    const onSelect = vi.fn()
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId="aaaaaaaa-1111-4111-8111-111111111111" onSelect={onSelect} />,
    ))

    const current = host.querySelector('[aria-current="page"]') as HTMLButtonElement
    expect(current.textContent).toContain('研究任务')
    expect(current.textContent).toContain('运行中')
    expect(host.textContent).toContain('未命名会话 · bbbbbbbb')
    expect(host.textContent).toContain('空闲')

    const buttons = Array.from(host.querySelectorAll('button'))
    const idle = buttons.find((button) => button.textContent?.includes('bbbbbbbb'))
    act(() => idle?.click())
    expect(onSelect).toHaveBeenCalledWith('bbbbbbbb-2222-4222-8222-222222222222')
  })
})
