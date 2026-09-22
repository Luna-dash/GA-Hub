export interface AssistantTranscriptTurn {
  turn: number
  summary: string
  content: string
}

export interface AskUserPayload {
  question: string
  candidates: string[]
}

export interface AssistantTranscript {
  /** Content before the first turn marker (normally empty in GA messages). */
  leading: string
  turns: AssistantTranscriptTurn[]
  finalBody: string
  /** Index of the final rendered turn when it contains an ask_user call. */
  finalTurnIndex: number | null
  /** Parsed ask_user payload of the final turn (only when it carries
   *  candidates; rendered by AskUserCard instead of raw text). */
  finalAskUser: AskUserPayload | null
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

function askUserPayloadFromObject(payload: Record<string, unknown>): AskUserPayload | null {
  const question = typeof payload.question === 'string'
    ? payload.question.trim()
    : typeof payload.prompt === 'string'
      ? payload.prompt.trim()
      : ''
  if (!question) return null
  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : Array.isArray(payload.options)
      ? payload.options
      : []
  return { question, candidates: rawCandidates.map(candidateLabel).filter(Boolean) }
}

/** Text form of an ask_user payload — used by the copy chip and the
 *  no-picker fallback so the readable contract stays intact. */
export function renderAskUserPayload(payload: AskUserPayload): string {
  return payload.candidates.length > 0
    ? `${payload.question}\n\n可选项：\n${payload.candidates.map((candidate) => `- ${candidate}`).join('\n')}`
    : payload.question
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

/** Parse the last ask_user payload in *text*, or null when absent/unparseable. */
function extractAskUserPayload(text: string): AskUserPayload | null {
  const match = lastAskUserMatch(text)
  if (!match) return null
  const tail = text.slice((match.index ?? 0) + match[0].length)
  const encoded = readJsonObjectAfter(tail, 0)
  if (encoded) {
    try {
      const parsed = askUserPayloadFromObject(JSON.parse(encoded) as Record<string, unknown>)
      if (parsed) return parsed
    } catch {
      // fall through to the lenient scanner — GA allows raw newlines in strings
    }
  }
  // Lenient scan runs on the whole tail so a brace inside the question text
  // cannot truncate the payload the way a balanced-brace pre-slice would.
  let question = readLenientStringField(tail, 'question') || readLenientStringField(tail, 'prompt')
  question = question.trim()
  if (!question) return null
  let candidates = readLenientStringArrayField(tail, 'candidates')
  if (!candidates.length) candidates = readLenientStringArrayField(tail, 'options')
  return { question, candidates: candidates.map(candidateLabel).filter(Boolean) }
}

// 提炼层只负责"选哪个 turn"，不改写 markdown 本身。
// 结论区与展开 turn 渲染同一份原始内容，格式零损耗。

/**
 * 最终展示体 = turn 原始内容，仅两处**无损**加工：
 * 1. 剥 <summary>/<thinking> 协议元数据（摘要是折叠列表用的，不属于正文）；
 * 2. ask_user 工具转储替换——有候选的 payload 由 AskUserCard 卡片接管，
 *    本处整段移除（askReplacement=''）；其余情况替换为友好问答文本。
 *    替换范围 = ask_user 标记到其参数围栏闭合；转储后的残余内容保留。
 * （回归：ga更新任务 的目录树 ```text 围栏曾被全局剥壳正则吃掉、
 *   结论正文曾被问题文本整体替换——原始内容直出后此类加工不复存在。）
 */
function projectFinalBody(content: string, askReplacement: string | null = null): string {
  const withoutMeta = stripTraceMeta(content).trim()
  if (!withoutMeta) return ''
  const askMatch = lastAskUserMatch(withoutMeta)
  if (!askMatch) return withoutMeta
  const rendered = askReplacement !== null
    ? askReplacement
    : (() => {
        const payload = extractAskUserPayload(withoutMeta)
        return payload ? renderAskUserPayload(payload) : ''
      })()
  if (askReplacement === null && !rendered) return withoutMeta
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

// ---------------------------------------------------------------------------
// Fallback summary derivation.
//
// Some models occasionally miss the <summary> protocol (bad escapes, raw long
// prose, truncated markdown). For those turns we derive a cheap title from the
// leading prose — everything before the first tool dump — capped at 50 chars
// and preferring a complete sentence. Rules locked with the user 2026-09-22;
// tuned against the full archived corpus (423 derivable turns / 9266) with a
// frozen Python reference (temp/fallback_reference.py) this port must match —
// see assistantTranscriptFallback.test.ts for the conformance fixture.
// Error turns and empty/tool-only turns intentionally derive '' so they keep
// rendering as plain execution logs.
// ---------------------------------------------------------------------------

const FALLBACK_SUMMARY_LIMIT = 50

/** First cut points that end the leading prose block. */
const fallbackToolCutRes: RegExp[] = [
  /`{4,}/, // multiline tool fence (only its start matters)
  /🛠️/, // GA tool-call glyph
  /<\/arg_value>|<\/parameter>|DSML/, // escaped tool-call houses
  /^\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\]/m, // GA log lines
]

const fallbackErrorRe =
  /^\s*(?:[!！]{1,4}\s*)?(?:\[(?:ERROR|DANGER)\]|\[\s*!{2,}|流异常中断|Incomplete response|上一条回复|Error[:：])/i

/** Clause-level break characters for the no-sentence-end downgrade. */
const FALLBACK_PAUSE_CHARS = '，、；,;'

function fallbackStripMarkdown(text: string): string {
  return text.replace(/\*\*|__|`|~~/g, '')
}

/** Trim trailing whitespace/punctuation and unclosed brackets (≤2 rounds). */
function fallbackTrimTail(text: string, hard = false): string {
  let value = text.replace(/\s+$/, '')
  const strip = hard ? '，、；：,;:—～~-' : '，、；,;—～~-'
  const dropTrailing = () => {
    for (;;) {
      value = value.replace(/\s+$/, '')
      if (!value || !strip.includes(value.slice(-1))) return
      value = value.slice(0, -1)
    }
  }
  dropTrailing()
  for (let round = 0; round < 2; round += 1) {
    const open: number[] = []
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]
      if ('（({[【'.includes(char)) open.push(index)
      else if ('）)}]】'.includes(char) && open.length) open.pop()
    }
    if (!open.length) break
    value = value.slice(0, open[0])
    dropTrailing()
  }
  return value
}

/** The first meaningful prose line before any tool dump; '' when none. */
function fallbackLeadLine(raw: string): string {
  let text = raw
  // Strip full thinking blocks up front (mirrors extractSummary's pre-pass).
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
  // Clear DSML residue before label peeling so it cannot shield opening labels.
  text = text.replace(/(?:\s*[｜|]+\s*DSML[^>]*>?)+/gi, ' ')
  // Peel opening label shells such as '<summary>' or '<parameter ...>'.
  text = text.replace(/^(?:\s*<[A-Za-z][^<>]{0,80}>)+\s*/, '')
  text = text.replace(/^(\s*<thinking>[\s\S]*?<\/thinking>)+\s*/i, '')
  let cut = -1
  for (const pattern of fallbackToolCutRes) {
    const match = pattern.exec(text)
    if (match && (cut < 0 || match.index < cut)) cut = match.index
  }
  if (cut >= 0) text = text.slice(0, cut)
  text = text.replace(/(?:\s*<\/[A-Za-z][^<>]{0,80}>)+\s*$/, '')
  text = text.replace(/\s*[｜|]+\s*DSML.*$/i, '')
  // Strip summary/parameter/arg_value label residue anywhere (attributes included).
  text = text.replace(/<\/?(?:summary|parameter|arg_value|antml:[a-z_]+)(?:\s[^<>]{0,200})?>/gi, ' ')
  text = text.replace(/(?:\s*[｜|]+\s*DSML[^>]*>?)+/gi, ' ')
  let line = ''
  for (const candidate of text.split(/\r?\n/)) {
    const trimmed = candidate.trim()
    if (!trimmed) continue
    if (/^[|>#*=\-•·`]+\s*$/.test(trimmed)) continue // heading/list decoration only
    line = trimmed
    break
  }
  if (!line) return ''
  return line.replace(/^\s*[#>*\-•·]+\s*/, '').replace(/\s+/g, ' ').trim()
}

/** 50-char sentence-first cut of the lead line; '' means derive nothing. */
function fallbackDerive(text: string): string {
  if (text.length < 2 || !/[0-9A-Za-z\u4e00-\u9fff]/.test(text)) return ''
  const stdEnd = /[。！？]/.exec(text)
  const colonEnd = /：[ \t\r]*(?=\n|$)/.exec(text)
  let stop = -1
  let stopKind = ''
  if (stdEnd) {
    stop = stdEnd.index
    stopKind = 'std'
  }
  if (colonEnd && (stop < 0 || colonEnd.index < stop)) {
    stop = colonEnd.index
    stopKind = 'colon'
  }
  if (stop >= 0 && stop < FALLBACK_SUMMARY_LIMIT) {
    let segment = text.slice(0, stop + 1)
    // A line-ending colon reads as a sentence end but must render as 。
    if (stopKind === 'colon') segment = `${segment.slice(0, -1)}。`
    const derived = fallbackTrimTail(fallbackStripMarkdown(segment))
    if (derived.length >= 2) return derived
  }
  const window = text.slice(0, FALLBACK_SUMMARY_LIMIT)
  let clauseCut = -1
  for (const char of FALLBACK_PAUSE_CHARS) {
    const index = window.lastIndexOf(char)
    if (index > clauseCut) clauseCut = index
  }
  if (clauseCut >= 10) {
    const derived = fallbackTrimTail(fallbackStripMarkdown(window.slice(0, clauseCut + 1)))
    if (derived.length >= 2) return `${derived}…`
  }
  const spaceCut = window.lastIndexOf(' ')
  if (spaceCut >= 20) {
    const derived = fallbackTrimTail(fallbackStripMarkdown(window.slice(0, spaceCut)))
    if (derived.length >= 2) return `${derived}…`
  }
  let derived = fallbackTrimTail(fallbackStripMarkdown(window), true)
  if (text.length > FALLBACK_SUMMARY_LIMIT) derived += '…'
  if (!derived || derived.length < 2 || !/[0-9A-Za-z\u4e00-\u9fff]/.test(derived)) return ''
  return derived
}

/**
 * Derive a fallback title for a turn whose model output missed the <summary>
 * protocol. Returns '' when the turn has no usable prose (error output,
 * tool-only or empty). Emoji are preserved.
 */
export function fallbackSummary(raw: string): string {
  const trimmed = raw.trim()
  if (fallbackErrorRe.test(trimmed)) return ''
  const lead = fallbackLeadLine(trimmed)
  if (!lead) return ''
  return fallbackDerive(lead)
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
    const payload = extractAskUserPayload(source)
    const finalAskUser = payload && payload.candidates.length > 0 ? payload : null
    return {
      leading: '',
      turns: [],
      finalBody: projectFinalBody(source, finalAskUser ? '' : null),
      finalTurnIndex: null,
      finalAskUser,
      stopped: false,
    }
  }

  const leading = stripTraceMeta(restore(safe.slice(0, matches[0].index ?? 0)))

  const turns = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? safe.length) : safe.length
    const rawContent = restore(safe.slice(start, end)).trim()
    return {
      turn: Number(match[1]),
      summary: extractSummary(rawContent) || fallbackSummary(rawContent),
      content: stripTraceMeta(rawContent),
    }
  })

  // 选择器：从后往前找第一个有实质内容的 turn，原样上屏；ask_user turn 从
  // 折叠列表排除（它就是结论区本体）。只有工具转储、没有任何正文的尾轮 =
  // 被停止截断的悬空轮（LLM 尾巴不会写入存档）——不当结论，回退上一轮。
  let finalBody = ''
  let finalTurnIndex: number | null = null
  let finalAskUser: AskUserPayload | null = null
  let stopped = false
  let terminalIndex = turns.length - 1
  while (terminalIndex >= 0 && !turns[terminalIndex].content.trim()) terminalIndex -= 1
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!turns[index].content.trim()) continue
    if (index === terminalIndex && isDanglingToolTurn(turns[index].content)) {
      stopped = true
      continue
    }
    // 有候选的 ask_user 交给 AskUserCard 交互卡片：finalBody 里挖掉转储段
    // （askReplacement=''），组件用结构化 payload 渲染；无候选/解析失败保持
    // 文本兜底（原行为）。
    const payload = lastAskUserMatch(turns[index].content)
      ? extractAskUserPayload(turns[index].content)
      : null
    finalAskUser = payload && payload.candidates.length > 0 ? payload : null
    finalBody = projectFinalBody(turns[index].content, finalAskUser ? '' : null)
    finalTurnIndex = lastAskUserMatch(turns[index].content) ? index : null
    break
  }

  return { leading, turns, finalBody, finalTurnIndex, finalAskUser, stopped }
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
