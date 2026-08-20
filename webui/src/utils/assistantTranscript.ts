import { looksLikeToolTrace, stripWrapperFences } from './toolTrace'

export interface AssistantTranscriptTurn {
  turn: number
  summary: string
  content: string
}

export interface AssistantTranscript {
  turns: AssistantTranscriptTurn[]
  finalBody: string
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

/** ask_user is a user-facing question encoded as a tool call, not trace noise. */
function extractAskUserCandidate(text: string): string {
  const starts = [
    ...text.matchAll(/🛠️\s*Tool:\s*`?ask_user`?/gi),
    ...text.matchAll(/🛠️\s*ask_user\s*\(/gi),
  ]
  if (!starts.length) return ''
  const last = starts.reduce((latest, match) => (
    (match.index ?? -1) > (latest.index ?? -1) ? match : latest
  ))
  const encoded = readJsonObjectAfter(text, (last.index ?? 0) + last[0].length)
  if (!encoded) return ''

  try {
    const payload = JSON.parse(encoded) as Record<string, unknown>
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
  } catch {
    return ''
  }
}

function extractTurnCandidate(segment: string): string {
  const withoutMeta = stripTraceMeta(segment).trim()
  if (!withoutMeta) return ''

  const askUser = extractAskUserCandidate(withoutMeta)
  if (askUser) return askUser

  const toolStarts = [
    ...withoutMeta.matchAll(/^\s*🛠️\s*Tool:/gim),
    ...withoutMeta.matchAll(/^\s*🛠️\s*[a-zA-Z_][\w.]*\(/gm),
  ]

  if (!toolStarts.length) {
    const cleaned = stripWrapperFences(withoutMeta)
    return looksLikeToolTrace(cleaned) ? '' : cleaned
  }

  const lastToolStart = Math.max(...toolStarts.map((match) => match.index ?? -1))
  const tail = withoutMeta.slice(lastToolStart)
  const resultFences = [...tail.matchAll(/^\s*`{5,}\s*$/gm)]
  if (resultFences.length < 2) return ''

  // GA wraps each tool result in one five-backtick pair. Because `tail`
  // starts at the final tool call, the second fence is that result's close;
  // everything after it is the user-facing answer, including its own code.
  const closingFence = resultFences[1]
  const suffix = tail.slice((closingFence.index ?? 0) + closingFence[0].length).trim()
  if (!suffix) return ''
  const cleaned = stripWrapperFences(suffix)
  return looksLikeToolTrace(cleaned) ? '' : cleaned
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
    return { turns: [], finalBody: extractTurnCandidate(source) }
  }

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

  let finalBody = ''
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    finalBody = extractTurnCandidate(turns[index].content)
    if (finalBody) break
  }

  return { turns, finalBody }
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
