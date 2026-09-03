import { beforeEach, describe, expect, it } from 'vitest'
import type { ConductorChatMessage, ConductorSubagent } from '@/api/types'
import { useConductorStore } from './conductorStore'

function chat(id: string, ts: number, msg = id): ConductorChatMessage {
  return { id, ts, msg, role: 'conductor' }
}

function subagent(id: string, status: string): ConductorSubagent {
  return {
    id,
    status,
    prompt: id,
    reply: '',
    created_at: 1,
    updated_at: 1,
    review_status: 'none',
    review_note: '',
    attempt: 1,
    generation: 1,
  }
}

describe('conductorStore', () => {
  beforeEach(() => {
    useConductorStore.getState().clear()
  })

  it('merges chat snapshots by id without rolling back live items', () => {
    const generation = useConductorStore.getState().generation
    useConductorStore.getState().addChatMessage(chat('live', 30, 'new value'))
    useConductorStore.getState().hydrateChatMessages([
      chat('history', 10),
      chat('live', 30, 'stale value'),
      chat('middle', 20),
    ], generation)

    expect(useConductorStore.getState().chatMessages).toEqual([
      chat('history', 10),
      chat('middle', 20),
      chat('live', 30, 'new value'),
    ])
  })

  it('keeps only the newest 200 chat messages', () => {
    const generation = useConductorStore.getState().generation
    const items = Array.from({ length: 205 }, (_, index) => chat(String(index), index))
    useConductorStore.getState().hydrateChatMessages(items, generation)

    const messages = useConductorStore.getState().chatMessages
    expect(messages).toHaveLength(200)
    expect(messages[0].id).toBe('5')
    expect(messages.at(-1)?.id).toBe('204')
  })

  it('rejects an HTTP subagent snapshot after a live revision arrives', () => {
    const initialRevision = useConductorStore.getState().subagentsRevision
    useConductorStore.getState().replaceSubagents([subagent('live', 'running')])
    useConductorStore.getState().hydrateSubagents(
      [subagent('stale', 'stopped')],
      initialRevision,
    )

    expect(useConductorStore.getState().subagents).toEqual([
      subagent('live', 'running'),
    ])
  })

  it('hydrates subagents when no newer revision exists', () => {
    const expectedRevision = useConductorStore.getState().subagentsRevision
    useConductorStore.getState().hydrateSubagents(
      [subagent('snapshot', 'stopped')],
      expectedRevision,
    )

    expect(useConductorStore.getState().subagents).toEqual([
      subagent('snapshot', 'stopped'),
    ])
    expect(useConductorStore.getState().subagentsRevision).toBe(expectedRevision + 1)
  })

  it('does not let an in-flight snapshot revive state after clear', () => {
    const expectedRevision = useConductorStore.getState().subagentsRevision
    const expectedGeneration = useConductorStore.getState().generation
    useConductorStore.getState().addChatMessage(chat('old', 1))
    useConductorStore.getState().clear()
    useConductorStore.getState().hydrateSubagents(
      [subagent('stale', 'running')],
      expectedRevision,
    )
    useConductorStore.getState().hydrateChatMessages(
      [chat('stale-chat', 2)],
      expectedGeneration,
    )

    expect(useConductorStore.getState().subagents).toEqual([])
    expect(useConductorStore.getState().chatMessages).toEqual([])
  })
})
