export interface AssistantTranscriptTurn {
  turn: number
  summary: string
  content: string
}

export interface AssistantTranscript {
  /** Content before the first turn marker (normally empty in GA messages). */
  leading: string
  turns: AssistantTranscriptTurn[]
  finalBody: string
  /** Index of the final rendered turn when it contains an ask_user call. */
  finalTurnIndex: number | null
  /** True when the last turn dangles (tool dump only — e.g. manual stop) and
   *  the conclusion fell back to an earlier turn. */
  stopped: boolean
}

const FINAL_MARKER_RE = /\n*(?:`{3,5}[^\r\n]*\r?\n?)?\[Info\]\s*Final response to user\.\s*(?:\r?\n?`{3,5})?\s*$/i
const PLACEHOLDER_PREFIX = '\u0000GAHUB_FENCE_'

function turnMarkerRe(): RegExp {
  return /(?:\*\*)?LLM Running \(Turn (\d+)\) \.{3}(?:\*\*)?/g
}

/** Remove GA's trailing protocol signal without touching similarly named prose. */
export function stripFinalResponseMarker(text: string): string {
  return (text || '').replace(FINAL_MARKER_RE, '').trim()
}

function protectToolFences(text: string): { safe: string; restore: (value: string) => string } {
  const placeholders: string[] = []
  const stash = (value: string) => {
    placeholders.push(value)
    return `${PLACEHOLDER_PREFIX}${placeholders.length - 1}\u0000`
  }

  // GA tool arguments/results use four or five backticks. Protect them so a
  // log line that happens to mention a Turn marker cannot split the transcript.
  let safe = text.replace(/^(`{4,})[^\r\n]*(?:\r?\n|$)[\s\S]*?^\1[ \t]*$/gm, stash)
  safe = safe.replace(/^`{4,}[^\r\n]*(?:\r?\n|$)[\s\S]*$/m, stash)

  return {
    safe,
    restore: (value: string) => value.replace(
      new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)\\u0000`, 'g'),
      (_, index: string) => placeholders[Number(index)] ?? '',
    ),
  }
}

function stripFencedBlocks(text: string): string {
  return text.replace(/^(`{3,})[^\r\n]*(?:\r?\n|$)[\s\S]*?^\1[ \t]*$/gm, ' ')
}

function normalizeSummary(text: string): string {
  return (text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' · ')
}

function extractSummary(text: string): string {
  const searchable = stripFencedBlocks(text).replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
  const match = /<summary>\s*([\s\S]*?)\s*<\/summary>/i.exec(searchable)
  return normalizeSummary(match?.[1] || '')
}

function stripTraceMeta(text: string): string {
  return (text || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<summary>[\s\S]*?<\/summary>\s*/gi, '')
    .trim()
}

function readJsonObjectAfter(text: string, offset: number): string {
  const start = text.indexOf('{', offset)
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return ''
}

function candidateLabel(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  const label = [row.label, row.title, row.value].find((item) => typeof item === 'string')
  const description = typeof row.description === 'string' ? row.description.trim() : ''
  return `${typeof label === 'string' ? label.trim() : ''}${label && description ? '：' : ''}${description}`
}

/** GA dumps tool args as a pretty block that allows RAW newlines inside
 * string values (real archives confirm), which strict JSON.parse rejects.
 * Scan the known ask_user fields directly instead of requiring valid JSON. */
function readLenientStringField(source: string, key: string): string {
  const match = new RegExp(`"${key}"\\s*:\\s*"`, 'i').exec(source)
  if (!match) return ''
  let index = match.index + match[0].length
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '\\' && index + 1 < source.length) {
      const next = source[index + 1]
      if (next === 'n') value += '\n'
      else if (next === 't') value += '\t'
      else value += next
      index += 2
      continue
    }
    if (char === '"') break
    value += char
    index += 1
  }
  return value.trim()
}

function readLenientStringArrayField(source: string, key: string): string[] {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`, 'i').exec(source)
  if (!match) return []
  let index = match.index + match[0].length
  const items: string[] = []
  while (index < source.length) {
    const char = source[index]
    if (char === ']') break
    if (char === '"') {
      index += 1
      let value = ''
      while (index < source.length) {
        const itemChar = source[index]
        if (itemChar === '\\' && index + 1 < source.length) {
          const next = source[index + 1]
          if (next === 'n') value += '\n'
          else if (next === 't') value += '\t'
          else value += next
          index += 2
          continue
        }
        if (itemChar === '"') break
        value += itemChar
        index += 1
      }
      index += 1
      if (value.trim()) items.push(value)
      continue
    }
    index += 1
  }
  return items
}

function askUserFromObject(payload: Record<string, unknown>): string {
  const question = typeof payload.question === 'string'
    ? payload.question.trim()
    : typeof payload.prompt === 'string'
      ? payload.prompt.trim()
      : ''
  if (!question) return ''
  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : Array.isArray(payload.options)
      ? payload.options
      : []
  const candidates = rawCandidates.map(candidateLabel).filter(Boolean)
  return candidates.length > 0
    ? `${question}\n\n可选项：\n${candidates.map((candidate) => `- ${candidate}`).join('\n')}`
    : question
}

function lastAskUserMatch(text: string): RegExpMatchArray | null {
  const starts = [
    ...text.matchAll(/🛠️\s*Tool:\s*`?ask_user`?/gi),
    ...text.matchAll(/🛠️\s*ask_user\s*\(/gi),
  ]
  if (!starts.length) return null
  return starts.reduce((latest, match) => (
    (match.index ?? -1) > (latest.index ?? -1) ? match : latest
  ))
}

/** Render the last ask_user payload in *text*, or '' when absent/unparseable. */
function extractAskUserCandidate(text: string): string {
  const match = lastAskUserMatch(text)
  if (!match) return ''
  const tail = text.slice((match.index ?? 0) + match[0].length)
  const encoded = readJsonObjectAfter(tail, 0)
  if (encoded) {
    try {
      const rendered = askUserFromObject(JSON.parse(encoded) as Record<string, unknown>)
      if (rendered) return rendered
    } catch {
      // fall through to the lenient scanner — GA allows raw newlines in strings
    }
  }
  // Lenient scan runs on the whole tail so a brace inside the question text
  // cannot truncate the payload the way a balanced-brace pre-slice would.
  let question = readLenientStringField(tail, 'question') || readLenientStringField(tail, 'prompt')
  question = question.trim()
  if (!question) return ''
  let candidates = readLenientStringArrayField(tail, 'candidates')
  if (!candidates.length) candidates = readLenientStringArrayField(tail, 'options')
  const labels = candidates.map(candidateLabel).filter(Boolean)
  return labels.length > 0
    ? `${question}\n\n可选项：\n${labels.map((candidate) => `- ${candidate}`).join('\n')}`
    : question
}

// 提炼层只负责"选哪个 turn"，不改写 markdown 本身。
// 结论区与展开 turn 渲染同一份原始内容，格式零损耗。

/**
 * 最终展示体 = turn 原始内容，仅两处**无损**加工：
 * 1. 剥 <summary>/<thinking> 协议元数据（摘要是折叠列表用的，不属于正文）；
 * 2. ask_user 工具转储替换为友好问答渲染——它是 UI 交互件不是 markdown，
 *    替换范围 = ask_user 标记到其参数围栏闭合；转储后的残余内容保留。
 * （回归：ga更新任务 的目录树 ```text 围栏曾被全局剥壳正则吃掉、
 *   结论正文曾被问题文本整体替换——原始内容直出后此类加工不复存在。）
 */
function projectFinalBody(content: string): string {
  const withoutMeta = stripTraceMeta(content).trim()
  if (!withoutMeta) return ''
  const askMatch = lastAskUserMatch(withoutMeta)
  if (!askMatch) return withoutMeta
  const rendered = extractAskUserCandidate(withoutMeta)
  if (!rendered) return withoutMeta
  const start = askMatch.index ?? 0
  const tail = withoutMeta.slice(start)
  const fence = /^`{4,}[^\r\n]*\r?\n[\s\S]*?^`{4,}[ \t]*$/m.exec(tail)
  const end = fence ? start + (fence.index ?? 0) + fence[0].length : withoutMeta.length
  const before = withoutMeta.slice(0, start).trimEnd()
  const after = withoutMeta.slice(end).trim()
  return [before, rendered, after].filter(Boolean).join('\n\n')
}

/** True when a turn consists ONLY of tool dumps (4/5-backtick fences +
 *  🛠️/bracket status lines) with no prose and no ask_user — the shape of a
 *  turn cut off by the stop button (its LLM tail never reaches the archive).
 *  ask_user turns are questions, never "dangling". */
function isDanglingToolTurn(content: string): boolean {
  if (lastAskUserMatch(content)) return false
  const stripped = content
    .replace(/^(`{4,})[^\r\n]*(?:\r?\n|$)[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/^`{4,}[^\r\n]*(?:\r?\n|$)[\s\S]*$/m, '')
    .replace(/^\s*🛠️[^\r\n]*$/gm, '')
    .replace(/^\s*\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\][^\r\n]*$/gim, '')
    .trim()
  return stripped === ''
}

/**
 * Project a raw GA assistant transcript into cheap, user-facing semantics.
 * This scans strings only; Markdown parsing remains the rendering layer's job.
 */
export function parseAssistantTranscript(text: string): AssistantTranscript {
  const source = stripFinalResponseMarker(text)
  const { safe, restore } = protectToolFences(source)
  const matches = [...safe.matchAll(turnMarkerRe())]

  if (!matches.length) {
    return { leading: '', turns: [], finalBody: projectFinalBody(source), finalTurnIndex: null, stopped: false }
  }

  const leading = stripTraceMeta(restore(safe.slice(0, matches[0].index ?? 0)))

  const turns = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? safe.length) : safe.length
    const rawContent = restore(safe.slice(start, end)).trim()
    return {
      turn: Number(match[1]),
      summary: extractSummary(rawContent),
      content: stripTraceMeta(rawContent),
    }
  })

  // 选择器：从后往前找第一个有实质内容的 turn，原样上屏；ask_user turn 从
  // 折叠列表排除（它就是结论区本体）。只有工具转储、没有任何正文的尾轮 =
  // 被停止截断的悬空轮（LLM 尾巴不会写入存档）——不当结论，回退上一轮。
  let finalBody = ''
  let finalTurnIndex: number | null = null
  let stopped = false
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!turns[index].content.trim()) continue
    if (isDanglingToolTurn(turns[index].content)) {
      stopped = true
      continue
    }
    finalBody = projectFinalBody(turns[index].content)
    finalTurnIndex = lastAskUserMatch(turns[index].content) ? index : null
    break
  }

  return { leading, turns, finalBody, finalTurnIndex, stopped }
}

export function stripAssistantTranscriptTags(text: string): string {
  return stripFinalResponseMarker(text)
    .replace(/<summary>[\s\S]*?<\/summary>/gi, ' ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(turnMarkerRe(), ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
