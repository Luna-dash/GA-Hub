import { api } from '@/api/client'
import { storageKeys } from '@/config/storageKeys'

const key = (id: string) => storageKeys.themeInstructionsPrefix + id

export function readRecentInstructions(id: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(id)) ?? '[]')
    return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim()))].slice(0, 5) : []
  } catch { return [] }
}

/** Throw on write failure so the page can explain that the task ran but was not saved. */
export function writeRecentInstructions(id: string, values: string[]): string[] {
  const next = [...new Set(values.map(v => v.trim()).filter(Boolean))].slice(0, 5)
  if (next.length) localStorage.setItem(key(id), JSON.stringify(next))
  else localStorage.removeItem(key(id))
  return next
}

/** Read the original session; never substitute today's default for a missing request. */
export async function readRunInstruction(id: string, runId: string): Promise<string> {
  let before: number | undefined
  let revision: string | null | undefined
  while (true) {
    const page = await api.getSessionMessages(id, { limit: 100, before })
    if (revision !== undefined && revision !== page.revision) throw new Error('会话历史已变化，请重新取回指令。')
    revision = page.revision
    const request = page.items.find(item => item.run_id === runId && item.role === 'user')
    if (request?.content.trim()) return request.content
    if (!page.has_more || page.next_before == null) break
    if (before !== undefined && page.next_before >= before) break
    before = page.next_before
  }
  throw new Error('未在会话历史中找到这次运行的原指令，请前往过程与历史核对，或使用本次调整。')
}

/** Only explicit error lines, never a tool/process dump masquerading as an error. */
export function themeFailureReason(raw: string): string {
  return raw.split(/\r?\n/).filter(line => /^\s*(?:!{3}\s*Error\b|\[Error\]|\[stream aborted:|(?:Error|Exception|错误|失败原因)[:：])/i.test(line)).join('\n')
}
