import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { useConductorStore } from '@/stores/conductorStore'
import { useHubEvent } from '@/hooks/useHubEvent'
import { queryKeys } from '@/queries/queryKeys'
import type { ConductorWorkflow } from '@/api/types'

const EMPTY_WORKFLOWS: ConductorWorkflow[] = []

export function useConductorData(onChatMessage: () => void) {
  const qc = useQueryClient()
  const hydrateSubagents = useConductorStore(s => s.hydrateSubagents)
  const hydrateChatMessages = useConductorStore(s => s.hydrateChatMessages)
  // Bootstrap snapshots also repair state after page remounts and hard resyncs.
  const { data: subagentSnapshot } = useQuery({
    queryKey: queryKeys.conductor.subagents,
    queryFn: async () => {
      const expectedRevision = useConductorStore.getState().subagentsRevision
      const res = await api.conductorSubagents()
      return { ...res, expectedRevision }
    },
    refetchOnMount: 'always',
  })

  const { data: workflowSnapshot } = useQuery({
    queryKey: queryKeys.conductor.workflows,
    queryFn: api.conductorWorkflows,
    refetchOnMount: 'always',
    // SSE is the fast path; this is a quiet recovery path for sleep/wake and
    // half-open connections where the browser has not observed a close yet.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const {
    data: chatSnapshot,
    isLoading: isChatLoading,
    isError: isChatError,
    refetch: refetchChat,
  } = useQuery({
    queryKey: queryKeys.conductor.chat,
    queryFn: async () => {
      const generation = useConductorStore.getState().generation
      return { items: (await api.conductorChat(200)).items, generation }
    },
    refetchOnMount: 'always',
  })

  useEffect(() => {
    if (subagentSnapshot) {
      hydrateSubagents(
        subagentSnapshot.items,
        subagentSnapshot.expectedRevision,
        subagentSnapshot,
      )
    }
  }, [hydrateSubagents, subagentSnapshot])

  useEffect(() => {
    if (chatSnapshot) {
      hydrateChatMessages(chatSnapshot.items, chatSnapshot.generation)
    }
  }, [chatSnapshot, hydrateChatMessages])

  useHubEvent('conductor:', (event) => {
    if (event.topic === 'conductor:chat' && event.payload.item) {
      onChatMessage()
      if (event.payload.item.role === 'user') {
        void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
      }
    }
    if (
      event.topic === 'conductor:workflow_completed'
      || event.topic === 'conductor:workflow_failed'
      || event.topic === 'conductor:workflow_cancelled'
      || event.topic === 'conductor:workflow_killed'
    ) {
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
      // A terminal transition also flips the badge (started workers freed).
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.status })
    }
    if (
      event.topic.startsWith('conductor:subagent_')
      && !event.topic.endsWith('_running')
    ) {
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
      // The mounted dossier must show the worker's freshest snapshot the
      // moment its lifecycle changes (delivery, acceptance, failure).
      const workerId = event.payload?.id
      if (typeof workerId === 'string') {
        void qc.invalidateQueries({ queryKey: queryKeys.conductor.subagent(workerId) })
      }
    }
  })

  return { workflows: workflowSnapshot?.items ?? EMPTY_WORKFLOWS, isChatLoading, isChatError, refetchChat }
}
