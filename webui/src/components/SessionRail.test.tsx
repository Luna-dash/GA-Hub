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

  it('uses the display label without changing project group identity', () => {
    const onSelect = vi.fn()
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={onSelect}
        projects={[{ name: 'alpha', path: 'D:/projects/alpha', display_name: '我的项目', dangling: false }]} />,
    ))
    expect(host.textContent).toContain('我的项目')
    act(() => (host.querySelector('[aria-current="page"]') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith(sessions[0].id)
  })

  it('hides generated project suffixes and shows session counts in the header', () => {
    const projectSession = { ...sessions[0], project_name: 'GA-Hub-d795c16e' }
    act(() => root.render(
      <SessionRail sessions={[projectSession]} runtimes={{}} currentId={projectSession.id} onSelect={vi.fn()} />,
    ))
    const header = host.querySelector('[data-project-header]')!
    expect(header.textContent).toContain('GA-Hub')
    expect(header.textContent).not.toContain('d795c16e')
    expect(header.querySelector('[data-project-session-count]')?.textContent).toBe('1')
    expect(header.querySelector('[data-project-session-count]')?.getAttribute('aria-label')).toBe('1 个会话')
    // A saved user label is displayed verbatim even when it ends in hex digits.
    act(() => root.render(
      <SessionRail sessions={[projectSession]} runtimes={{}} currentId={projectSession.id} onSelect={vi.fn()}
        projects={[{ name: 'GA-Hub-d795c16e', path: 'D:/projects/alpha', display_name: '版本-deadbeef', dangling: false }]} />,
    ))
    expect(host.querySelector('[data-project-header]')?.textContent).toContain('版本-deadbeef')
  })

  it('keeps pin / expand / count in fixed trailing slots, including when pinned', () => {
    const grouped = Array.from({ length: 7 }, (_, i) => ({
      ...sessions[0],
      id: `layout-${i}`,
      updated_at: `2026-08-0${8 - i}T09:00:00Z`,
    }))
    act(() => root.render(
      <SessionRail sessions={grouped} runtimes={{}} currentId={grouped[0].id} onSelect={vi.fn()} />,
    ))
    const header = host.querySelector('[data-project-header]')!
    const pin = header.querySelector('[data-testid^="pin-project-"]') as HTMLButtonElement
    const expand = header.querySelector('[data-testid^="group-show-all-"]')!
    const count = header.querySelector('[data-project-session-count]')!
    expect(pin.nextElementSibling).toBe(expand)
    expect(expand.nextElementSibling).toBe(count)
    expect(header.lastElementChild).toBe(count)
    expect(count.closest('button')).toBeNull()
    for (const button of [pin, expand]) {
      expect(button.classList.contains('opacity-0')).toBe(true)
      expect(button.classList.contains('group-hover/project-header:opacity-100')).toBe(true)
      expect(button.classList.contains('group-focus-within/project-header:opacity-100')).toBe(true)
    }
    act(() => pin.click())
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    expect(pin.classList.contains('opacity-0')).toBe(true)
    act(() => root.render(
      <SessionRail sessions={[grouped[0]]} runtimes={{}} currentId={grouped[0].id} onSelect={vi.fn()} />,
    ))
    expect(header.querySelector('[data-testid^="group-show-all-"]')).toBeNull()
    expect(header.lastElementChild?.hasAttribute('data-project-session-count')).toBe(true)
    expect(pin.nextElementSibling?.getAttribute('aria-hidden')).toBe('true')
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
    expect(current.title).toContain('运行中')
    // 项目归属改由抽屉分组头表达，不再挤占会话标题行
    expect(host.textContent).toContain('alpha')
    expect(host.textContent).toContain('未命名会话 · bbbbbbbb')
    expect(host.textContent).toContain('未命名会话 · cccccccc')
    expect(host.textContent).not.toContain('已隐藏')

    const empty = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('bbbbbbbb'))
    act(() => empty?.click())
    expect(onSelect).toHaveBeenCalledWith(sessions[1].id)

    const runningDelete = host.querySelector('[aria-label="移除 研究任务"]') as HTMLButtonElement
    expect(runningDelete.disabled).toBe(true)

    const idleDelete = host.querySelector('[aria-label="移除 未命名会话 · bbbbbbbb"]') as HTMLButtonElement
    const actionGroup = idleDelete.parentElement!
    const titleRow = actionGroup.parentElement!
    expect(titleRow.classList.contains('relative')).toBe(true)
    expect(actionGroup.classList.contains('top-1/2')).toBe(true)
    expect(actionGroup.classList.contains('-translate-y-1/2')).toBe(true)
    expect(actionGroup.classList.contains('top-2')).toBe(false)
    expect(idleDelete.classList.contains('h-6')).toBe(true)
    expect(idleDelete.classList.contains('w-6')).toBe(true)
    expect(idleDelete.classList.contains('items-center')).toBe(true)
    act(() => idleDelete.click())
    expect(host.querySelector('[role="alertdialog"]')?.parentElement).toBe(titleRow.parentElement)
    expect(titleRow.querySelector('[role="alertdialog"]')).toBeNull()
    expect(host.querySelector('[role="alertdialog"]')?.getAttribute('aria-label')).toBe('确认移除 未命名会话 · bbbbbbbb')
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('移除会话？原档保留。')
    const confirm = Array.from(host.querySelectorAll('[role="alertdialog"] button'))
      .find((button) => button.textContent === '确认') as HTMLButtonElement
    // 只剩一个按钮：取消就是「点别处」
    expect(host.querySelectorAll('[role="alertdialog"] button')).toHaveLength(1)
    await act(async () => { confirm.click() })
    expect(onDelete).toHaveBeenCalledWith(sessions[1].id)
  })

  it('keeps delete hidden on selected rows until hover or keyboard focus, and accessible on touch', () => {
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} onDelete={vi.fn()} />,
    ))

    const classesOf = (label: string) => (
      host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
    ).parentElement!.className.split(/\s+/)

    for (const label of ['移除 研究任务', '移除 未命名会话 · bbbbbbbb']) {
      const classes = classesOf(label)
      expect(classes).toContain('opacity-0')
      expect(classes).not.toContain('opacity-100')
      expect(classes).toContain('group-hover:opacity-100')
      expect(classes).toContain('has-[:focus-visible]:opacity-100')
      expect(classes).not.toContain('focus-within:opacity-100')
      expect(classes).toContain('[@media(hover:none)]:opacity-100')
    }
  })

  it('cancels the delete confirmation from anywhere outside it, or with Escape', () => {
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} onDelete={vi.fn()} />,
    ))

    const openConfirm = () => {
      act(() => (host.querySelector('[aria-label="移除 未命名会话 · bbbbbbbb"]') as HTMLButtonElement).click())
      expect(host.querySelector('[role="alertdialog"]')).not.toBeNull()
    }

    openConfirm()
    act(() => { window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()

    openConfirm()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()

    // 非 Escape 的按键不误关
    openConfirm()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })) })
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull()
    act(() => { window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
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

    // 一体化「新会话」主按钮：内置加号图标与文本统一触发新建会话
    const empty = host.querySelector('[data-testid="create-session-empty"]') as HTMLButtonElement
    expect(empty).not.toBeNull()
    expect(empty.getAttribute('aria-label')).toBe('新建会话')
    expect(empty.textContent).toContain('新会话')
    expect(empty.querySelector('svg')).not.toBeNull()
    expect(host.querySelector('[aria-label="新建空会话"]')).toBeNull()

    await act(async () => { empty.click() })
    expect(onCreate).toHaveBeenCalledOnce()

    const renameCard = host.querySelector('[aria-current="page"]') as HTMLButtonElement
    act(() => { renameCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
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

  it('routes the history-import button to the history page', async () => {
    const onCreate = vi.fn()
    const onImportFromHistory = vi.fn()
    act(() => root.render(
      <SessionRail
        sessions={sessions}
        runtimes={runtimes}
        currentId={sessions[0].id}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onImportFromHistory={onImportFromHistory}
      />,
    ))

    const importButton = host.querySelector('[data-testid="create-session-import"]') as HTMLButtonElement
    expect(importButton.getAttribute('aria-label')).toBe('历史导入')
    // 图标-only 按钮：无文字标签
    expect(importButton.textContent?.trim()).toBe('')

    await act(async () => { importButton.click() })
    expect(onImportFromHistory).toHaveBeenCalledOnce()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('pins a project group to the top and persists the choice', () => {
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))

    // 置顶前没有 pinned 组；alpha 是 fixture 里唯一的项目空间
    const pin = host.querySelector('[data-testid="pin-project-project:alpha"]') as HTMLButtonElement
    expect(pin).not.toBeNull()
    expect(pin.getAttribute('aria-pressed')).toBe('false')

    act(() => pin.click())
    expect((host.querySelector('[aria-label="取消置顶 alpha"]') as HTMLButtonElement)
      .getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('gahub.sessionRailGroupPinned')).toContain('alpha')

    // 再点一次取消置顶
    act(() => (host.querySelector('[aria-label="取消置顶 alpha"]') as HTMLButtonElement).click())
    expect((host.querySelector('[aria-label="置顶 alpha"]') as HTMLButtonElement)
      .getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem('gahub.sessionRailGroupPinned')).not.toContain('alpha')
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

    // Subsequent scroll/wheel/key activity on an already-acknowledged session must not re-parse localStorage.
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    act(() => {
      window.dispatchEvent(new Event('wheel'))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    expect(getItemSpy).not.toHaveBeenCalled()
    getItemSpy.mockRestore()
  })

  it('groups sessions into project drawers ordered by latest activity', () => {
    localStorage.setItem('gahub.sessionRailRecentActivity', JSON.stringify([sessions[2].id, sessions[1].id]))

    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))

    // 自由会话抽屉在前，组内按最近活动统一排序（不再按状态分桶）
    const freeGroup = Array.from(host.querySelectorAll('section'))
      .find((section) => section.textContent?.startsWith('自由会话'))
    expect(freeGroup).toBeTruthy()
    const freeCards = Array.from(freeGroup!.querySelectorAll('[data-activity]'))
    expect(freeCards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('未命名会话 · cccccccc'),
      expect.stringContaining('未命名会话 · bbbbbbbb'),
    ])
    // 运行中的项目会话收进自己的抽屉，标题不再与项目徽章互相挤压
    const projectCards = Array.from(host.querySelectorAll('[data-activity]'))
      .filter((card) => card.textContent?.includes('研究任务'))
    expect(projectCards).toHaveLength(1)
    expect(localStorage.getItem('gahub.sessionRailRecentActivity')).toBeNull()
  })

  it('keeps a newly created unstarted session above sessions with older activity', () => {
    const newSession: HubSession = {
      id: 'dddddddd-4444-4444-8444-444444444444',
      title: '',
      llm_key: null,
      llm_index: null,
      archive_path: null,
      created_at: '2026-08-05T12:00:00Z',
      updated_at: '2026-08-05T12:00:00Z',
    }
    localStorage.setItem('gahub.sessionRailRecentActivity', JSON.stringify([sessions[0].id, sessions[1].id]))

    act(() => root.render(
      <SessionRail
        sessions={[...sessions, newSession]}
        runtimes={{}}
        currentId={newSession.id}
        onSelect={vi.fn()}
      />,
    ))

    const firstCard = host.querySelector('[data-activity]')
    expect(firstCard?.textContent).toContain('未命名会话 · dddddddd')
  })

  it('orders sessions by completed > error > active > idle and returns cancelled runs to idle', () => {
    const orderOf = () => Array.from(host.querySelectorAll('[data-activity]'))
      .map((card) => card.getAttribute('data-session-id'))
    const freeSessions: HubSession[] = [
      { ...sessions[1], id: 's-idle-newest', title: '空闲最新', updated_at: '2026-08-05T12:00:00Z' },
      { ...sessions[1], id: 's-active', title: '运行中', updated_at: '2026-08-05T09:00:00Z' },
      { ...sessions[1], id: 's-error', title: '异常失败', updated_at: '2026-08-05T08:00:00Z' },
      { ...sessions[1], id: 's-completed', title: '完成未读', updated_at: '2026-08-05T07:00:00Z' },
      { ...sessions[1], id: 's-cancelled', title: '手动中止', updated_at: '2026-08-05T11:00:00Z' },
    ]

    act(() => root.render(
      <SessionRail
        sessions={freeSessions}
        runtimes={{
          's-idle-newest': { session_id: 's-idle-newest', status: 'idle', run_id: null, stream_id: null },
          's-active': { session_id: 's-active', status: 'running', run_id: 'run-act', stream_id: null },
          's-error': { session_id: 's-error', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'run-err', outcome: 'failed' },
          's-completed': { session_id: 's-completed', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'run-ok', outcome: 'completed' },
          's-cancelled': { session_id: 's-cancelled', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'run-can', outcome: 'cancelled' },
        }}
        currentId="s-idle-newest"
        onSelect={vi.fn()}
      />,
    ))

    expect(orderOf()).toEqual(['s-completed', 's-error', 's-active', 's-idle-newest', 's-cancelled'])
    expect(host.querySelector('[data-session-id="s-cancelled"]')?.getAttribute('data-activity')).toBe('idle')

    // Running -> cancelled returns to idle sorted by recency.
    act(() => root.render(
      <SessionRail
        sessions={freeSessions}
        runtimes={{
          's-idle-newest': { session_id: 's-idle-newest', status: 'idle', run_id: null, stream_id: null },
          's-active': { session_id: 's-active', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'run-act', outcome: 'cancelled' },
          's-error': { session_id: 's-error', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'run-err', outcome: 'failed' },
          's-completed': { session_id: 's-completed', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'run-ok', outcome: 'completed' },
          's-cancelled': { session_id: 's-cancelled', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'run-can', outcome: 'cancelled' },
        }}
        currentId="s-idle-newest"
        onSelect={vi.fn()}
      />,
    ))

    expect(orderOf()).toEqual(['s-completed', 's-error', 's-idle-newest', 's-cancelled', 's-active'])
  })

  it('lifts a session to the top as soon as its activity stamp moves', () => {
    // 发消息 → 乐观提升 updated_at → 会话必须立刻置顶（旧缓存只在重连/重挂载
    // 时才刷新，于是同一行会长时间停在原位）。
    const orderOf = () => Array.from(host.querySelectorAll('[data-activity]'))
      .map((card) => card.getAttribute('data-session-id'))

    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={{}} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))
    expect(orderOf()).toEqual([sessions[2].id, sessions[1].id, sessions[0].id])

    act(() => root.render(
      <SessionRail
        sessions={sessions.map((item) => (
          item.id === sessions[0].id ? { ...item, updated_at: '2026-08-05T12:00:00Z' } : item
        ))}
        runtimes={{}}
        currentId={sessions[0].id}
        onSelect={vi.fn()}
      />,
    ))

    expect(orderOf()).toEqual([sessions[0].id, sessions[2].id, sessions[1].id])
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

  it('starts expanded and keeps the user-selected collapse state when the active session changes', () => {
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))

    const toggle = host.querySelector('[aria-label="折叠会话管理"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[aria-label="会话工作区"]')?.getAttribute('aria-hidden')).toBe('false')
    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('false')
    act(() => toggle.click())
    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('true')

    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[1].id} onSelect={vi.fn()} />,
    ))
    expect(host.querySelector('[aria-label="展开会话管理"]')).not.toBeNull()
    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('true')

    act(() => (host.querySelector('[aria-label="展开会话管理"]') as HTMLButtonElement).click())
    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('false')
  })

  // 动态阈值（项目数 < 3 时 ≤5 条，≥ 3 时 ≤3 条）+ 三态收折：
  // chevron = C↔D、标题按钮 = D↔E、E 态组内活动抬升 → 自动回落 D。
  const drawerSessions = (count: number, base: HubSession): HubSession[] =>
    Array.from({ length: count }, (_, index) => ({
      ...base,
      id: `drawer-${base.project_name ?? 'free'}-${index}`,
      title: `任务 ${index}`,
      updated_at: `2026-08-${String(20 - index).padStart(2, '0')}T09:00:00Z`,
    }))

  const sectionOf = (name: string) => Array.from(host.querySelectorAll('section'))
    .find((node) => node.textContent?.startsWith(name))

  const shownInDrawer = (name: string) => Array.from(sectionOf(name)?.querySelectorAll('[data-activity]') ?? [])
    .map((card) => card.textContent?.match(/任务 (\d+)/)?.[1])

  const linkOf = (key: string) => host.querySelector(`[data-testid="group-show-all-${key}"]`) as HTMLButtonElement | null

  it('uses a 5-session preview limit when fewer than 3 project groups exist (excluding free)', () => {
    const alpha5 = drawerSessions(5, sessions[0])
    const beta5 = drawerSessions(5, { ...sessions[0], project_name: 'beta', project_path: 'D:/projects/beta' })
    const free2 = drawerSessions(2, sessions[1])
    // 2 project groups (+ free group) => threshold stays 5, so 5-item drawers need no expand button
    act(() => root.render(
      <SessionRail sessions={[...alpha5, ...beta5, ...free2]} runtimes={{}} currentId={alpha5[0].id} onSelect={vi.fn()} />,
    ))
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '4'])
    expect(shownInDrawer('beta')).toEqual(['0', '1', '2', '3', '4'])
    expect(linkOf('project:alpha')).toBeNull()

    // Adding a 3rd project group drops the threshold to 3
    const gamma1 = drawerSessions(1, { ...sessions[0], project_name: 'gamma', project_path: 'D:/projects/gamma' })
    act(() => root.render(
      <SessionRail sessions={[...alpha5, ...beta5, ...gamma1, ...free2]} runtimes={{}} currentId={alpha5[0].id} onSelect={vi.fn()} />,
    ))
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2'])
    expect(linkOf('project:alpha')?.getAttribute('aria-label')).toBe('展开全部 5 个会话')
  })

  it('caps a single-project drawer at five newest sessions and toggles the rest', () => {
    const many = drawerSessions(7, sessions[0])
    act(() => root.render(
      <SessionRail sessions={[...many, sessions[1]]} runtimes={{}} currentId={many[0].id} onSelect={vi.fn()} />,
    ))

    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '4'])
    expect(linkOf('project:alpha')?.getAttribute('aria-label')).toBe('展开全部 7 个会话')

    act(() => linkOf('project:alpha')?.click())
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect(linkOf('project:alpha')?.getAttribute('aria-label')).toBe('收起（仅显示最近5个）')
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailGroupShowAll') || '{}')).toEqual({ 'project:alpha': true })

    act(() => linkOf('project:alpha')?.click())
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '4'])
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailGroupShowAll') || '{}')).toEqual({})
  })

  it('keeps the current session and all protected sessions visible past the preview edge', () => {
    const many = drawerSessions(7, sessions[0])
    act(() => root.render(
      <SessionRail sessions={[...many, sessions[1]]} runtimes={{}} currentId={many[6].id} onSelect={vi.fn()} />,
    ))
    // many[6] 是组内最旧：默认态把它顶入第 5 位，而不是整组跟着跳位
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '6'])

    // Older completed/error/active sessions jump to the front and never get collapsed (Option A fills to 5)
    act(() => root.render(
      <SessionRail
        sessions={[...many, sessions[1]]}
        runtimes={{
          [many[6].id]: { session_id: many[6].id, status: 'idle', run_id: null, stream_id: null, completed_run_id: 'r6', outcome: 'completed' },
          [many[5].id]: { session_id: many[5].id, status: 'running', run_id: 'r5', stream_id: null },
        }}
        currentId={many[1].id}
        onSelect={vi.fn()}
      />,
    ))
    expect(shownInDrawer('alpha')).toEqual(['6', '5', '0', '1', '2'])
  })

  it('shows a group header dot when a collapsed project group holds protected sessions', () => {
    localStorage.setItem('gahub.sessionRailGroupCollapse', JSON.stringify({ 'project:alpha': true }))
    const many = drawerSessions(3, sessions[0])
    act(() => root.render(
      <SessionRail
        sessions={many}
        runtimes={{
          [many[1].id]: { session_id: many[1].id, status: 'idle', run_id: null, stream_id: null, completed_run_id: 'r1', outcome: 'completed' },
        }}
        currentId={many[0].id}
        onSelect={vi.fn()}
      />,
    ))
    expect(shownInDrawer('alpha')).toEqual([])
    expect(sectionOf('alpha')?.querySelector('[data-group-attention="completed"]')).not.toBeNull()
  })

  it('collapses and reopens a drawer from the chevron without ever landing on show-all', () => {
    const many = drawerSessions(7, sessions[0])
    const mount = (rows: HubSession[]) => act(() => root.render(
      <SessionRail sessions={[...rows, sessions[1]]} runtimes={{}} currentId={rows[0].id} onSelect={vi.fn()} />,
    ))

    mount(many)
    act(() => linkOf('project:alpha')?.click())
    expect(shownInDrawer('alpha')).toHaveLength(7)

    // E → C：chevron 收起，show-all 标志同时清除
    const chevron = () => sectionOf('alpha')?.querySelector('button[aria-expanded]') as HTMLButtonElement
    act(() => chevron().click())
    expect(shownInDrawer('alpha')).toEqual([])
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailGroupShowAll') || '{}')).toEqual({})

    // C → D：展开恒回默认预览（不落回 E）
    act(() => chevron().click())
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '4'])

    // 再进 E 后，组内活动抬升（乐观 updated_at）→ 自动回落 D
    act(() => linkOf('project:alpha')?.click())
    expect(shownInDrawer('alpha')).toHaveLength(7)
    mount(many.map((item) => (item.id === many[6].id ? { ...item, updated_at: '2026-08-25T00:00:00Z' } : item)))
    expect(shownInDrawer('alpha')).toEqual(['6', '0', '1', '2', '3'])
    expect(linkOf('project:alpha')?.getAttribute('aria-label')).toBe('展开全部 7 个会话')
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailGroupShowAll') || '{}')).toEqual({})
  })

  it('restores a persisted show-all drawer on mount without treating the first paint as activation', () => {
    localStorage.setItem('gahub.sessionRailGroupShowAll', JSON.stringify({ 'project:alpha': true }))
    const many = drawerSessions(7, sessions[0])
    act(() => root.render(
      <SessionRail sessions={[...many, sessions[1]]} runtimes={{}} currentId={many[0].id} onSelect={vi.fn()} />,
    ))
    expect(shownInDrawer('alpha')).toHaveLength(7)
    expect(linkOf('project:alpha')?.getAttribute('aria-label')).toBe('收起（仅显示最近5个）')
  })

  it('reads a legacy collapsed=false flag as the default preview state', () => {
    localStorage.setItem('gahub.sessionRailGroupCollapse', JSON.stringify({ 'project:alpha': false }))
    const many = drawerSessions(6, sessions[0])
    act(() => root.render(
      <SessionRail sessions={[...many, sessions[1]]} runtimes={{}} currentId={many[0].id} onSelect={vi.fn()} />,
    ))
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '4'])
    expect(linkOf('project:alpha')?.getAttribute('aria-label')).toBe('展开全部 6 个会话')
  })

  it('reopens a legacy fully-collapsed drawer to the default preview', () => {
    localStorage.setItem('gahub.sessionRailGroupCollapse', JSON.stringify({ 'project:alpha': true }))
    const many = drawerSessions(6, sessions[0])
    act(() => root.render(
      <SessionRail sessions={[...many, sessions[1]]} runtimes={{}} currentId={many[0].id} onSelect={vi.fn()} />,
    ))
    expect(shownInDrawer('alpha')).toEqual([])
    act(() => (sectionOf('alpha')?.querySelector('button[aria-expanded]') as HTMLButtonElement).click())
    expect(shownInDrawer('alpha')).toEqual(['0', '1', '2', '3', '4'])
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailGroupCollapse') || '{}')).toEqual({})
  })

  it('opens all sessions directly from the collapsed header with an icon button', () => {
    localStorage.setItem('gahub.sessionRailGroupCollapse', JSON.stringify({ 'project:alpha': true }))
    const many = drawerSessions(7, sessions[0])
    act(() => root.render(
      <SessionRail sessions={[...many, sessions[1]]} runtimes={{}} currentId={many[0].id} onSelect={vi.fn()} />,
    ))
    const button = linkOf('project:alpha')!
    expect(shownInDrawer('alpha')).toEqual([])
    expect(button.closest('[data-project-header]')).not.toBeNull()
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(sectionOf('alpha')?.querySelector('[data-project-session-count]')?.textContent).toBe('7')
    act(() => button.click())
    expect(shownInDrawer('alpha')).toHaveLength(7)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('gahub.sessionRailGroupCollapse') || '{}')).toEqual({})
    act(() => button.click())
    expect(shownInDrawer('alpha')).toHaveLength(5)
  })

  it('keeps the pure free area uncapped and without the footer link', () => {
    const freeMany = drawerSessions(7, sessions[1])
    act(() => root.render(
      <SessionRail sessions={freeMany} runtimes={{}} currentId={freeMany[0].id} onSelect={vi.fn()} />,
    ))
    expect(host.querySelectorAll('[data-activity]')).toHaveLength(7)
    expect(host.querySelectorAll('[data-testid^="group-show-all"]')).toHaveLength(0)
  })

  it('shows no footer link on drawers at or under the preview size', () => {
    act(() => root.render(
      <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} />,
    ))
    expect(host.querySelectorAll('[data-testid^="group-show-all"]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-activity]')).toHaveLength(3)
  })

  it('separates orthogonal state dots from lifted active-row highlighting', () => {
    const stateSessions: HubSession[] = [
      { ...sessions[1], id: 'state-active', title: '运行任务', updated_at: '2026-08-05T12:00:00Z' },
      { ...sessions[1], id: 'state-completed', title: '完成任务', updated_at: '2026-08-05T11:00:00Z' },
      { ...sessions[1], id: 'state-error', title: '异常任务', updated_at: '2026-08-05T10:00:00Z' },
      { ...sessions[1], id: 'state-idle', title: '空闲任务', updated_at: '2026-08-05T09:00:00Z' },
    ]
    const stateRuntimes: Record<string, SessionRuntime> = {
      'state-active': { session_id: 'state-active', status: 'running', run_id: 'r-act', stream_id: null },
      'state-completed': { session_id: 'state-completed', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'r-ok', outcome: 'completed' },
      'state-error': { session_id: 'state-error', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'r-err', outcome: 'failed' },
      'state-idle': { session_id: 'state-idle', status: 'idle', run_id: null, stream_id: null },
    }

    const renderWithCurrent = (currentId: string) => {
      act(() => root.render(
        <SessionRail sessions={stateSessions} runtimes={stateRuntimes} currentId={currentId} onSelect={vi.fn()} />,
      ))
    }

    renderWithCurrent('state-idle')

    for (const id of ['state-active', 'state-completed', 'state-error']) {
      const row = host.querySelector(`[data-session-id="${id}"]`) as HTMLDivElement
      expect(row.getAttribute('data-current')).toBe('false')
      const classes = row.className.split(/\s+/)
      expect(classes).toContain('text-ink-muted')
      expect(classes).not.toContain('bg-status-success-soft')
      expect(classes).not.toContain('bg-status-info-soft')
      expect(classes).not.toContain('bg-status-danger-soft')
      expect(classes).not.toContain('bg-bg-card')
    }

    const idleActiveRow = host.querySelector('[data-session-id="state-idle"]') as HTMLDivElement
    expect(idleActiveRow.getAttribute('data-current')).toBe('true')
    const activeClasses = idleActiveRow.className.split(/\s+/)
    expect(activeClasses).toContain('bg-bg-card')
    expect(activeClasses).toContain('ring-accent/35')
    expect(activeClasses).toContain('before:bg-accent')
    expect(activeClasses).toContain('shadow-sm')
    expect(idleActiveRow.querySelector('button span span:last-child')?.className).toContain('font-semibold')

    const dotClasses = (id: string) =>
      (host.querySelector(`[data-session-id="${id}"] [data-status-dot]`) as HTMLElement).className.split(/\s+/)

    expect(dotClasses('state-active')).toContain('bg-[#D97706]')
    expect(dotClasses('state-active')).toContain('ga-session-dot-running')
    expect(dotClasses('state-completed')).toContain('bg-[#1F8A4C]')
    expect(dotClasses('state-completed')).not.toContain('ga-session-dot-running')
    expect(dotClasses('state-error')).toContain('bg-[#C93B2B]')
    expect(dotClasses('state-idle')).toContain('bg-[#A89C8B]/75')

    // Selected running row also receives the lifted card highlight without losing its running dot.
    renderWithCurrent('state-active')
    const activeSelectedRow = host.querySelector('[data-session-id="state-active"]') as HTMLDivElement
    expect(activeSelectedRow.getAttribute('data-current')).toBe('true')
    expect(activeSelectedRow.className.split(/\s+/)).toContain('bg-bg-card')
    expect(dotClasses('state-active')).toContain('bg-[#D97706]')
  })

  it('syncs inert between expanded rail and collapsed strip, and guards rename IME/Escape/rejections', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('rename failed'))
    const onWindowEscape = vi.fn()
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onWindowEscape(event)
    }
    window.addEventListener('keydown', handleWindowKeyDown)

    try {
      act(() => root.render(
        <SessionRail sessions={sessions} runtimes={runtimes} currentId={sessions[0].id} onSelect={vi.fn()} onRename={onRename} />,
      ))

      const aside = host.querySelector('aside[aria-label="会话工作区"]') as HTMLElement
      const attentionStrip = host.querySelector('[aria-label="最近活动会话"]') as HTMLElement
      expect(aside.inert).toBe(false)
      expect(attentionStrip.inert).toBe(true)

      act(() => (host.querySelector('[aria-label="折叠会话管理"]') as HTMLButtonElement).click())
      expect(aside.inert).toBe(true)
      expect(attentionStrip.inert).toBe(false)

      act(() => (host.querySelector('[aria-label="展开会话管理"]') as HTMLButtonElement).click())
      expect(aside.inert).toBe(false)

      const rowBtn = host.querySelector('[aria-current="page"]') as HTMLButtonElement
      act(() => { rowBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
      const input = host.querySelector('input[aria-label="重命名 研究任务"]') as HTMLInputElement
      expect(input).not.toBeNull()

      const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
      act(() => { input.dispatchEvent(composingEnter) })
      expect(host.querySelector('input[aria-label="重命名 研究任务"]')).not.toBeNull()

      const legacy229 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      Object.defineProperty(legacy229, 'keyCode', { value: 229 })
      act(() => { input.dispatchEvent(legacy229) })
      expect(host.querySelector('input[aria-label="重命名 研究任务"]')).not.toBeNull()

      // Escape cancels rename and does not propagate to global overlay shortcuts.
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(onWindowEscape).not.toHaveBeenCalled()
      expect(host.querySelector('input[aria-label="重命名 研究任务"]')).toBeNull()

      // Rejected onRename during blur must not leak an unhandled rejection.
      const rowBtnAgain = host.querySelector('[aria-current="page"]') as HTMLButtonElement
      act(() => { rowBtnAgain.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
      const inputAgain = host.querySelector('input[aria-label="重命名 研究任务"]') as HTMLInputElement
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(inputAgain, '会失败的名称')
        inputAgain.dispatchEvent(new Event('input', { bubbles: true }))
        inputAgain.blur()
      })
      await act(async () => {})
      expect(onRename).toHaveBeenCalledWith(sessions[0].id, '会失败的名称')
    } finally {
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  })
})
