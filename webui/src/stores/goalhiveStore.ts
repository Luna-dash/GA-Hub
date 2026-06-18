import { create } from 'zustand'

export interface GoalHiveMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: number
  streaming: boolean
}

interface GoalHiveState {
  messages: GoalHiveMessage[]
  conn: 'connecting' | 'open' | 'closed'
  mode: 'goal' | 'hive'
  setMessages: (messages: GoalHiveMessage[]) => void
  setConn: (conn: 'connecting' | 'open' | 'closed') => void
  setMode: (mode: 'goal' | 'hive') => void
}

export const useGoalHiveStore = create<GoalHiveState>((set) => ({
  messages: [],
  conn: 'closed',
  mode: 'goal',
  setMessages: (messages) => set({ messages }),
  setConn: (conn) => set({ conn }),
  setMode: (mode) => set({ mode }),
}))
