import { extractAskUserPayload, type AskUserPayload } from './assistantTranscript'

export type RunningPart = { kind: 'text'; text: string } | { kind: 'tools'; labels: string[] }
export interface RunningTurnContent { parts: RunningPart[]; askUser: AskUserPayload | null }

const LABELS: Record<string, string> = {
  file_read: '读取文件', file_write: '写入文件', file_patch: '修改文件',
  code_run: '执行脚本', web_scan: '查看网页', web_execute_js: '浏览器操作',
  ask_user: '请求用户确认', update_working_checkpoint: '更新工作记录',
  start_long_term_update: '整理记忆',
}
const TOOL = /🛠️?\s*(?:Tool:\s*`([^`]+)`|([\w.]+)\s*\()/g

function label(name: string): string {
  const short = name.split('.').at(-1) || name
  return LABELS[short] || '调用工具'
}

/** Read one compact call, respecting quoted/newline args. Incomplete payloads stay hidden. */
function compactEnd(source: string, start: number): number {
  let depth = 1
  let quoted = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quoted) { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (char === '(') depth += 1
    if (char === ')' && --depth === 0) return i + 1
  }
  // Live compact traces may deliberately truncate JSON to "...)", even inside a string.
  const lineEnd = source.indexOf('\n', start)
  const end = lineEnd < 0 ? source.length : lineEnd
  if (/\.\.\.\)\s*$/.test(source.slice(start, end))) return end
  return source.length
}

/** Display-only projection. Never changes archived/final content or tool execution. */
export function projectRunningTurn(content: string): RunningTurnContent {
  const parts: RunningPart[] = []
  const lines = content.split(/\r?\n/)
  let text: string[] = []
  let fence: { char: string; size: number; hidden: boolean } | null = null
  let afterTool = false
  const flush = () => {
    const value = text.join('\n').trim()
    if (value) parts.push({ kind: 'text', text: value })
    text = []
  }
  const addTool = (name: string) => {
    flush()
    const last = parts.at(-1)
    if (last?.kind === 'tools') last.labels.push(label(name))
    else parts.push({ kind: 'tools', labels: [label(name)] })
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // A tool fence can arrive one backtick at a time. Delay only the
    // unfinished last line; completed three-backtick prose stays visible.
    if (afterTool && !fence && i === lines.length - 1 && /^\s*`{1,3}\s*$/.test(line)) continue
    const edge = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (!fence.hidden) text.push(line)
      if (edge && edge[1][0] === fence.char && edge[1].length >= fence.size && !edge[2].trim()) fence = null
      continue
    }
    if (edge) {
      // GA args/results use 4/5-backtick wrappers. Three-backtick prose/code is retained.
      const hidden = afterTool && edge[1][0] === '`' && edge[1].length >= 4
      fence = { char: edge[1][0], size: edge[1].length, hidden }
      if (!hidden) { afterTool = false; text.push(line) }
      continue
    }
    // A streaming tool header may stop before its name/backtick/parenthesis.
    // Likewise a tool fence can arrive one backtick at a time. Neither is prose.
    if (afterTool && /^\s*[`~]{1,2}\s*$/.test(line)) continue
    if (/^\s*🛠️?/.test(line)) {
      const tail = lines.slice(i).join('\n')
      TOOL.lastIndex = 0
      let match: RegExpExecArray | null
      let consumed = 0
      while ((match = TOOL.exec(tail))) {
        // Only a call at the line start, or immediately after another compact call.
        if (tail.slice(consumed, match.index).trim()) break
        addTool(match[1] || match[2])
        if (match[1]) {
          const newline = tail.indexOf('\n', TOOL.lastIndex)
          consumed = newline < 0 ? tail.length : newline
          break
        }
        consumed = compactEnd(tail, TOOL.lastIndex)
        TOOL.lastIndex = consumed
      }
      if (!consumed) {
        // Name/header still streaming: hide it until a tool is identifiable.
        consumed = line.length
      }
      const consumedText = tail.slice(0, consumed)
      i += (consumedText.match(/\n/g) || []).length
      const endLine = consumedText.lastIndexOf('\n')
      const remainder = lines[i].slice(consumed - (endLine < 0 ? 0 : endLine + 1))
      if (remainder.trim()) text.push(remainder)
      afterTool = true
      continue
    }
    if (!line.trim()) { text.push(line); continue }
    afterTool = false
    text.push(line)
  }
  flush()
  return { parts, askUser: extractAskUserPayload(content.replace(/(🛠️?\s*Tool:\s*`)functions\.(ask_user`)/g, '$1$2')) }
}

export function formatToolHint(labels: string[]): string {
  const counts = new Map<string, number>()
  for (const item of labels) counts.set(item, (counts.get(item) || 0) + 1)
  return [...counts].map(([item, count]) => count > 1 ? `${item} ×${count}` : item).join(' · ')
}
