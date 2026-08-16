// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubSession, SessionRuntime } from '@/api/types'
import { SessionRail } from './SessionRail'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sessions: HubSession[] = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', title: '研究任务', llm_key: null, llm_index: null, archive_path: null, project_name: 'alpha', project_path: 'D:/projects/alpha', created_at: '2026-08-05T08:00:00Z', updated_at: '2026-08-05T09:00:00Z' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', title: '', llm_key: null, llm_index: null, archive_path: null, created_at: '2026-08-05T08:00:00Z', updated_at: '2026-08-05T10:00:00Z' },
  { id: 'cccccccc-3333-4333-8333-333333333333', title: '', llm_key: null, llm_index: null, archive_path: 'D:/archives/chat.json', created_at: '2026-08-05T08:00:00Z', updated_at: '2026-08-05T11:00:00Z' },
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

  it('skips rendering when the parent updates with unchanged props', () => {
    let reads = 0
    const trackedSession = new Proxy(sessions[0], {
      get(target, property, receiver) {
        reads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const stableSessions = [trackedSession]
    const stableRuntimes = { [trackedSession.id]: runtimes[trackedSession.id] }
    const onSelect = vi.fn()
    const rail = (
      <SessionRail
        sessions={stableSessions}
        runtimes={stableRuntimes}
        currentId={trackedSession.id}
        onSelect={onSelect}
      />
    )

    act(() => root.render(rail))
    const readsAfterMount = reads
    act(() => root.render(rail))

    expect(reads).toBe(readsAfterMount)
  })

  it('shows every session, keeps them selectable, and deletes an idle session after confirmation', async () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={onSelect} onDelete={onDelete} />,
    ))

    const current = host.querySelector('[aria-current="page"]') as HTMLButtonElement
    expect(current.textContent).toContain('研究任务')
    expect(current.textContent).toContain('alpha')
    expect(current.textContent).toContain('运行中')
    expect(host.textContent).toContain('未命名会话 · bbbbbbbb')
    expect(host.textContent).toContain('未命名会话 · cccccccc')
    expect(host.textContent).not.toContain('已隐藏')

    const empty = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('bbbbbbbb'))
    act(() => empty?.click())
    expect(onSelect).toHaveBeenCalledWith(sessions[1].id)

    const runningDelete = host.querySelector('[aria-label="删除 研究任务"]') as HTMLButtonElement
    expect(runningDelete.disabled).toBe(true)

    const idleDelete = host.querySelector('[aria-label="删除 未命名会话 · bbbbbbbb"]') as HTMLButtonElement
    act(() => idleDelete.click())
    expect(host.querySelector('[role="alertdialog"]')?.getAttribute('aria-label')).toBe('确认删除 未命名会话 · bbbbbbbb')
    const confirm = Array.from(host.querySelectorAll('[role="alertdialog"] button'))
      .find((button) => button.textContent === '确认') as HTMLButtonElement
    await act(async () => { confirm.click() })
    expect(onDelete).toHaveBeenCalledWith(sessions[1].id)
  })

  it('creates and renames sessions from the workspace rail', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    const onRename = vi.fn().mockResolvedValue(undefined)
    act(() => root.render(
      <SessionRail
        sessions={sessions}
        runtimes={runtimes}
        currentId={sessions[0].id}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onRename={onRename}
      />,
    ))

    const create = host.querySelector('[aria-label="新建会话"]') as HTMLButtonElement
    await act(async () => { create.click() })
    expect(onCreate).toHaveBeenCalledOnce()

    const rename = host.querySelector('[aria-label="重命名 研究任务"]') as HTMLButtonElement
    act(() => rename.click())
    const input = host.querySelector('input[aria-label="重命名 研究任务"]') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '新的标题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
    })
    await act(async () => {})
    expect(onRename).toHaveBeenCalledWith(sessions[0].id, '新的标题')
  })

  it('acknowledges only the current completed session when the user interacts with the window', () => {
    const completedRuntimes: Record<string, SessionRuntime> = {
      [sessions[0].id]: {
        session_id: sessions[0].id,
        status: 'idle',
        run_id: null,
        stream_id: null,
        completed_run_id: 'completed-current',
      },
      [sessions[1].id]: {
        session_id: sessions[1].id,
        status: 'idle',
        run_id: null,
        stream_id: null,
        completed_run_id: 'completed-background',
      },
    }

    act(() => root.render(
      <SessionRail
        sessions={sessions.slice(0, 2)}
        runtimes={completedRuntimes}
        currentId={sessions[0].id}
        onSelect={vi.fn()}
      />,
    ))

    expect(host.querySelector(`[aria-label="${sessions[0].title}，已完成"]`)).not.toBeNull()
    expect(host.querySelector('[aria-label="未命名会话 · bbbbbbbb，已完成"]')).not.toBeNull()

    act(() => window.dispatchEvent(new Event('pointerdown')))

    expect(host.querySelector(`[aria-label="${sessions[0].title}，已完成"]`)).toBeNull()
    expect(host.querySelector('[aria-label="未命名会话 · bbbbbbbb，已完成"]')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailSeenCompletedRuns') || '{}')).toEqual({
      [sessions[0].id]: 'completed-current',
    })
  })

  it('keeps the previous recent sessions when a newly active session is promoted', () => {
    localStorage.setItem('gahub.sessionRailRecentActivity', JSON.stringify([sessions[1].id, sessions[2].id]))

    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))

    expect(JSON.parse(localStorage.getItem('gahub.sessionRailRecentActivity') || '[]')).toEqual([
      sessions[0].id,
      sessions[1].id,
      sessions[2].id,
    ])
  })

  it('shows an unseen completed run immediately and persists acknowledgement on selection', () => {
    const onSelect = vi.fn()
    const completedRuntimes = {
      ...runtimes,
      [sessions[1].id]: {
        ...runtimes[sessions[1].id],
        completed_run_id: 'short-run-b',
      },
    }

    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={completedRuntimes} currentId={sessions[0].id} onSelect={onSelect} />,
    ))

    const completedCard = host.querySelector(`[data-activity="completed"]`)
    expect(completedCard).not.toBeNull()
    const select = completedCard?.querySelector('button') as HTMLButtonElement
    act(() => select.click())
    expect(onSelect).toHaveBeenCalledWith(sessions[1].id)
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailSeenCompletedRuns') || '{}')).toEqual({
      [sessions[1].id]: 'short-run-b',
    })
  })

  it('starts collapsed on every mount and expansion only lasts for the current window', () => {
    localStorage.setItem('gahub.sessionRailCollapsed', 'false')
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))

    const toggle = host.querySelector('[aria-label="展开会话管理"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[aria-label="会话工作区"]')?.getAttribute('aria-hidden')).toBe('true')
    act(() => toggle.click())
    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('false')
    expect(localStorage.getItem('gahub.sessionRailCollapsed')).toBe('false')

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
