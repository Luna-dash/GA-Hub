import { scanTranscript } from './transcriptProtocol'
import { extractAskUserPayload, type AskUserPayload } from './assistantTranscript'

export type RunningPart = { kind: 'text'; text: string } | { kind: 'tools'; labels: string[] }
export interface RunningTurnContent { parts: RunningPart[]; askUser: AskUserPayload | null }

const LABELS: Record<string, string> = {
  file_read: '读取文件', file_write: '写入文件', file_patch: '修改文件',
  code_run: '执行脚本', web_scan: '查看网页', web_execute_js: '浏览器操作',
  ask_user: '请求用户确认', update_working_checkpoint: '更新工作记录',
  start_long_term_update: '整理记忆',
}
function label(name: string): string {
  return LABELS[name.split('.').at(-1) || name] || '调用工具'
}

/** Compact view of shared protocol nodes; no truncated-live parser. */
export function projectRunningTurn(content: string): RunningTurnContent {
  const parts: RunningPart[] = []
  let text = ''
  const flush = () => {
    if (text.trim()) parts.push({ kind: 'text', text: text.trim() })
    text = ''
  }
  for (const node of scanTranscript(content)) {
    if (node.kind === 'text' || node.kind === 'code') { text += node.raw; continue }
    if (node.kind !== 'tool') continue
    flush()
    const last = parts.at(-1)
    if (last?.kind === 'tools') last.labels.push(label(node.name!))
    else parts.push({ kind: 'tools', labels: [label(node.name!)] })
  }
  flush()
  return { parts, askUser: extractAskUserPayload(content) }
}

export function formatToolHint(labels: string[]): string {
  const counts = new Map<string, number>()
  for (const item of labels) counts.set(item, (counts.get(item) || 0) + 1)
  return [...counts].map(([item, count]) => count > 1 ? `${item} ×${count}` : item).join(' · ')
}
