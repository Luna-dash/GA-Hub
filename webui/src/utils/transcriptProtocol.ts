/** GA's detailed transcript protocol. One boundary scanner for live and replay.
 * Offsets always refer to the unmodified source. In-flight tokens are pending,
 * not prose. Historical complete compact calls remain readable; deliberately
 * truncated compact payloads are no longer guessed/accepted. */
export type TranscriptNode = {
  kind: 'text' | 'code' | 'tool' | 'summary' | 'thinking' | 'turn' | 'pending'
  start: number
  end: number
  raw: string
  name?: string
  headerEnd?: number
  turn?: number
  complete: boolean
  opaque?: { start: number; end: number }[]
  repairs?: number[]
}
const TOOL_Y = /🛠️?\s*Tool\s*[:：]\s*`([\w.-]+)`(?:[ \t]*📥[ \t]*args:)?/iy
const COMPACT_Y = /🛠️?\s*([\w.-]+)\s*\(/y
const TURN_Y = /(?:\*\*)?LLM Running \(Turn (\d+)\) \.\.\.(?:\*\*)?/iy
const META_Y = /<(summary|thinking|think|analysis)>/iy
const EDGE_Y = /[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/y
const WS_Y = /\s*/y
const ARGS_PREFIX_Y = /(?:📥\s*args:|`{1,})/y
const PENDING_TAIL_RE = /^(?:🛠️?\s*(?:T(?:o(?:o(?:l(?::\s*(?:`[\w.]*)?)?)?)?)?)?|<(?:s(?:u(?:m(?:m(?:a(?:r(?:y)?)?)?)?)?)?)?)$/i
const BACKTICK_TAIL_RE = /^`{1,3}$/
const PENDING_OPEN_TAGS = ['<thinking>', '<think>', '<analysis>']

function isWsCode(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 11 || ch === 12 || ch === 160
}

function skipWs(source: string, pos: number): number {
  while (pos < source.length && isWsCode(source.charCodeAt(pos))) pos++
  return pos
}

function skipInlineSpaces(source: string, pos: number): number {
  while (pos < source.length) {
    const ch = source.charCodeAt(pos)
    if (ch !== 32 && ch !== 9) break
    pos++
  }
  return pos
}

function isWordOrToolCode(ch: number): boolean {
  return ch === 0xD83D || ch === 95 || ch === 46 || ch === 45
    || (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
}

function balancedCall(source: string, start: number): number | null {
  let depth = 1, quoted = false, escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (escaped) { escaped = false; continue }
    if (quoted && ch === '\\') { escaped = true; continue }
    if (ch === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) return i + 1
  }
  return null
}

function fence(source: string, start: number, tool: boolean) {
  EDGE_Y.lastIndex = start
  const open = EDGE_Y.exec(source)!
  const size = open[1].length, char = open[1][0]
  const closeRe = new RegExp(`^[ \\t]*${char === '`' ? '`' : '~'}{${size},}[ \\t]*$`)
  // Only a known tool wrapper accepts a producer's result+closing-fence
  // concatenation. Backticks inside prose/code are never normalized.
  const gluedRe = tool && char === '`' ? new RegExp(`(?<!\x60)\x60{${size}}[ \\t]*$`) : null
  let pos = start + open[0].length
  while (pos < source.length) {
    const newline = source.indexOf('\n', pos)
    const end = newline < 0 ? source.length : newline + 1
    let lineEnd = end
    if (lineEnd > pos && source[lineEnd - 1] === '\n') lineEnd--
    if (lineEnd > pos && source[lineEnd - 1] === '\r') lineEnd--
    const line = source.slice(pos, lineEnd)
    if (closeRe.test(line)) return { end, complete: true, repair: null }
    if (gluedRe) {
      const glued = gluedRe.exec(line)
      if (glued && glued.index > 0) return { end, complete: true, repair: pos + glued.index }
    }
    pos = end
  }
  return { end: source.length, complete: false, repair: null }
}

export function scanTranscript(source: string): TranscriptNode[] {
  const nodes: TranscriptNode[] = []
  const len = source.length
  let pos = 0, textStart = 0
  const push = (kind: TranscriptNode['kind'], start: number, end: number, extra: Partial<TranscriptNode> = {}) => {
    nodes.push({ kind, start, end, raw: source.slice(start, end), complete: true, ...extra })
  }
  const flush = () => { if (pos > textStart) push('text', textStart, pos) }
  while (pos < len) {
    const ch = source.charCodeAt(pos)
    const lineStart = pos === 0 || source.charCodeAt(pos - 1) === 10
    if (ch === 42 || ch === 76 || ch === 108) {
      TURN_Y.lastIndex = pos
      const turn = TURN_Y.exec(source)
      if (turn) {
        flush(); push('turn', pos, pos + turn[0].length, { turn: Number(turn[1]) })
        pos += turn[0].length; textStart = pos; continue
      }
    }
    if (ch === 60) {
      META_Y.lastIndex = pos
      const meta = META_Y.exec(source)
      if (meta) {
        const closeRe = new RegExp(`</${meta[1]}>`, 'ig')
        closeRe.lastIndex = pos + meta[0].length
        const close = closeRe.exec(source)
        const end = close ? close.index + close[0].length : len
        flush(); push(meta[1].toLowerCase() === 'summary' ? 'summary' : 'thinking', pos, end, { complete: !!close })
        pos = end; textStart = pos; continue
      }
    }

    const ws = isWsCode(ch)
    let header: RegExpExecArray | null = null
    if (ch === 0xD83D || ch === 84 || ch === 116 || ws) {
      const probe = ws ? skipWs(source, pos) : pos
      const probeCh = probe < len ? source.charCodeAt(probe) : 0
      if (probeCh === 0xD83D || probeCh === 84 || probeCh === 116) {
        TOOL_Y.lastIndex = pos
        header = TOOL_Y.exec(source)
        if (header) {
          const afterHeader = pos + header[0].length
          WS_Y.lastIndex = afterHeader
          const suffixStart = afterHeader + WS_Y.exec(source)![0].length
          const remLen = len - suffixStart
          if (remLen > 0 && remLen <= 8 && '📥 args:'.startsWith(source.slice(suffixStart))) {
            header[0] = source.slice(pos)
          } else if (remLen > 0) {
            ARGS_PREFIX_Y.lastIndex = suffixStart
            if (!ARGS_PREFIX_Y.test(source)) header = null
          }
        }
      }
    }

    const adjacentTool = nodes.at(-1)?.kind === 'tool' && nodes.at(-1)?.end === pos
    let compact: RegExpExecArray | null = null
    if (!header && (lineStart || adjacentTool) && (ws || isWordOrToolCode(ch))) {
      COMPACT_Y.lastIndex = pos
      compact = COMPACT_Y.exec(source)
    }
    if (header || compact) {
      flush()
      const start = pos, name = (header?.[1] || compact![1])
      const headerEnd = header ? pos + header[0].length : balancedCall(source, pos + compact![0].length)
      let end = headerEnd ?? len, complete = headerEnd !== null
      const opaque: { start: number; end: number }[] = [], repairs: number[] = []
      // Detailed args/results are fenced blocks immediately after a call.
      // Whitespace is part of the call only when followed by its wrapper.
      while (complete) {
        WS_Y.lastIndex = end
        const next = end + WS_Y.exec(source)![0].length
        EDGE_Y.lastIndex = next
        const edge = EDGE_Y.exec(source)
        if (edge && edge[1][0] === '`' && edge[1].length >= 4) {
          const block = fence(source, next, true)
          opaque.push({ start: next, end: block.end })
          if (block.repair !== null) repairs.push(block.repair)
          end = block.end; complete = block.complete; continue
        }
        // A wrapper can arrive one backtick at a time.
        if (next < len && len - next <= 3 && BACKTICK_TAIL_RE.test(source.slice(next))) {
          opaque.push({ start: next, end: len }); end = len; complete = false
        }
        break
      }
      push('tool', start, end, { name, headerEnd: compact ? start + compact[0].length : headerEnd ?? undefined, complete, opaque, repairs })
      pos = end; textStart = pos; continue
    }
    if (lineStart && (ch === 96 || ch === 126 || ch === 32 || ch === 9)) {
      const fenceCheck = ch === 32 || ch === 9 ? skipInlineSpaces(source, pos) : pos
      const fenceCh = fenceCheck < len ? source.charCodeAt(fenceCheck) : 0
      if (fenceCh === 96 || fenceCh === 126) {
        EDGE_Y.lastIndex = pos
        if (EDGE_Y.test(source)) {
          flush(); const block = fence(source, pos, false)
          push('code', pos, block.end, { complete: block.complete })
          pos = block.end; textStart = pos; continue
        }
      }
    }
    // Delay only protocol prefixes at the very end, not arbitrary text.
    if (ch === 60 && len - pos <= 10) {
      const tailLower = source.slice(pos).toLowerCase()
      if (PENDING_OPEN_TAGS.some(tag => tag.startsWith(tailLower))) {
        flush(); push('pending', pos, len, { complete: false }); pos = len; textStart = pos; break
      }
    }
    if (len - pos <= 256 && (ch === 60 || ch === 0xD83D || ch === 84 || ch === 116 || ws)) {
      if (PENDING_TAIL_RE.test(source.slice(pos))) {
        flush(); push('pending', pos, len, { complete: false }); pos = len; textStart = pos; break
      }
    }
    pos++
  }
  flush()
  return nodes
}

/** Hide opaque blocks without altering protocol headers or prose. */
export function protectTranscript(source: string) {
  const nodes = scanTranscript(source)
  const ranges = nodes.flatMap(node => node.kind === 'code'
    ? [{ start: node.start, end: node.end }]
    : node.kind === 'tool' ? (node.opaque || []) : [])
  const values: string[] = []
  let safe = '', pos = 0
  for (const range of ranges) {
    safe += source.slice(pos, range.start) + `\u0000GA_TOOL_FENCE_${values.length}\u0000`
    values.push(source.slice(range.start, range.end)); pos = range.end
  }
  safe += source.slice(pos)
  return { safe, restore: (value: string) => value.replace(/\u0000GA_TOOL_FENCE_(\d+)\u0000/g, (_, i: string) => values[Number(i)] ?? '') }
}

/** Plain Markdown presentation of the same nodes. Repairs affect display only. */
export function transcriptRecordMarkdown(source: string): string {
  const inserts = new Set<number>()
  for (const node of scanTranscript(source)) {
    for (const at of node.repairs || []) inserts.add(at)
    if (node.kind === 'tool' && node.start > 0 && source[node.start - 1] !== '\n') inserts.add(node.start)
  }
  let result = source
  for (const at of [...inserts].sort((a, b) => b - a)) result = result.slice(0, at) + '\n' + result.slice(at)
  return result
}
