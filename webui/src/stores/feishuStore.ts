// feishuStore — persistent Feishu bot message state
//
// Why a global store?
//   Switching tabs unmounts FeishuBot, killing local useState. The
//   messages are pushed via EventSocket and need to survive navigation.
//   Unlike WechatBot (which polls the backend for full history), Feishu
//   messages are streamed incrementally, so we persist them client-side.

import { create } from 'zustand'

export interface FeishuMsg {
  taskId: string
  chatId: string
  role: 'user' | 'assistant'
  type: 'user' | 'summary' | 'final'
  content: string
  ts: number
}

interface FeishuState {
  msgs: FeishuMsg[]
  addMsgs: (msgs: FeishuMsg[]) => void
  setMsgs: (msgs: FeishuMsg[]) => void
  clear: () => void
}

export const useFeishuStore = create<FeishuState>((set) => ({
  msgs: [],
  addMsgs: (msgs) =>
    set((state) => {
      // 用Set快速查重，避免O(n²)
      const existingKeys = new Set(
        state.msgs.map(m => `${m.taskId}:${m.type}:${m.content}`)
      )
      const toAdd = msgs.filter(
        msg => !existingKeys.has(`${msg.taskId}:${msg.type}:${msg.content}`)
      )
      if (toAdd.length === 0) return state
      return { msgs: [...state.msgs, ...toAdd] }
    }),
  setMsgs: (msgs) => set({ msgs }),
  clear: () => set({ msgs: [] }),
}))
