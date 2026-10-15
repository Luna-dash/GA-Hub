import { scanTranscript } from './transcriptProtocol'
import { extractAskUserPayload, type AskUserPayload } from './assistantTranscript'

export type RunningPart = { kind: 'text'; text: string } | { kind: 'tools'; labels: string[] }
export interface RunningTurnContent { parts: RunningPart[]; askUser: AskUserPayload | null; thinking: boolean }

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
  let text = '', thinking = false
  const flush = () => {
    if (text.trim()) parts.push({ kind: 'text', text: text.trim() })
    text = ''
  }
  for (const node of scanTranscript(content)) {
    if (node.kind === 'text' || node.kind === 'code') { text += node.raw; continue }
    if (node.kind === 'thinking' && node.raw.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '').trim()) thinking = true
    if (node.kind !== 'tool') continue
    flush()
    const last = parts.at(-1)
    if (last?.kind === 'tools') last.labels.push(label(node.name!))
    else parts.push({ kind: 'tools', labels: [label(node.name!)] })
  }
  flush()
  return { parts, askUser: extractAskUserPayload(content), thinking }
}

/** Presentation only: inspect protocol text, never tool results or fenced examples. */
export function runningTurnTitle(summary: string, content: string): string {
  const nodes = scanTranscript(content)
  const text = nodes.filter(node => node.kind === 'text').map(node => node.raw).join('').trim()
  const message = text.replace(/^(?:[!！]+\s*)?(?:\[(?:Error|Warn)\]\s*|Error:\s*)/i, '')
  if (/^Response truncated:\s*max_tokens/i.test(message)) return '输出达到上限 · 自动续接'
  if (/^(?:流异常中断|自动重连|reconnecting)/i.test(message)) return '连接中断 · 自动重连'
  if (/^(?:自动重试|retrying)/i.test(message)) return '自动重试'
  if (/^(?:[!！]+\s*Error|\[(?:Error|Warn)\]|Error:|错误[:：]|ConnectionError|HTTP\s+\d{3}|Incomplete response)/i.test(text)) {
    if (/Incomplete response/i.test(text)) return '响应不完整 · 自动重试'
    const http = /HTTP\s+(\d{3})/i.exec(text)
    if (http) return `请求失败 · HTTP ${http[1]}`
    if (/ConnectionError|连接|network|timeout|timed out/i.test(text)) return '连接异常'
    return '执行出错'
  }
  if (summary.trim()) return summary
  const tools = nodes.filter(node => node.kind === 'tool').map(node => label(node.name!))
  if (tools.length) return formatToolHint(tools)
  if (nodes.some(node => node.kind === 'thinking')) return '正在思考'
  return '执行记录'
}

export function formatToolHint(labels: string[]): string {
  const counts = new Map<string, number>()
  for (const item of labels) counts.set(item, (counts.get(item) || 0) + 1)
  return [...counts].map(([item, count]) => count > 1 ? `${item} ×${count}` : item).join(' · ')
}
