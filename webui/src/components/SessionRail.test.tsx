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
  { id: 'cccccccc-3333-4333-8333-333333333333', title: '', llm_index: null, archive_path: 'D:/archives/chat.json', created_at: '2026-08-05T08:00:00Z', updated_at: '2026-08-05T11:00:00Z' },
]
const runtimes: Record<string, SessionRuntime> = {
  'aaaaaaaa-1111-4111-8111-111111111111': { session_id: 'aaaaaaaa-1111-4111-8111-111111111111', status: 'running', run_id: 'run-a', stream_id: 'stream-a' },
  'bbbbbbbb-2222-4222-8222-222222222222': { session_id: 'bbbbbbbb-2222-4222-8222-222222222222', status: 'idle', run_id: null, stream_id: null },
  'cccccccc-3333-4333-8333-333333333333': { session_id: 'cccccccc-3333-4333-8333-333333333333', status: 'idle', run_id: null, stream_id: null },
}

describe('SessionRail', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('hides empty shells but keeps named, archived, and current sessions selectable', () => {
    const onSelect = vi.fn()
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId="aaaaaaaa-1111-4111-8111-111111111111" onSelect={onSelect} />,
    ))

    const current = host.querySelector('[aria-current="page"]') as HTMLButtonElement
    expect(current.textContent).toContain('研究任务')
    expect(current.textContent).toContain('运行中')
    expect(host.textContent).not.toContain('bbbbbbbb')
    expect(host.textContent).toContain('未命名会话 · cccccccc')
    expect(host.textContent).toContain('已隐藏 1 个空会话')

    const archived = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('cccccccc'))
    act(() => archived?.click())
    expect(onSelect).toHaveBeenCalledWith('cccccccc-3333-4333-8333-333333333333')

    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId="bbbbbbbb-2222-4222-8222-222222222222" onSelect={onSelect} />,
    ))
    expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('bbbbbbbb')
    expect(host.textContent).not.toContain('已隐藏 1 个空会话')
  })

  it('collapses, persists the preference, and restores it on a new mount', () => {
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))

    const toggle = host.querySelector('[aria-label="折叠会话管理"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    act(() => toggle.click())
    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('true')
    expect(localStorage.getItem('gahub.sessionRailCollapsed')).toBe('true')
    expect(host.querySelector('[aria-label="会话工作区"]')?.getAttribute('aria-hidden')).toBe('true')

    act(() => root.unmount())
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))
    expect(host.querySelector('[aria-label="展开会话管理"]')).not.toBeNull()
    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('true')
  })
})
