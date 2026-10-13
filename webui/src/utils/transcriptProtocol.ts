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
const TOOL = /^🛠️?\s*Tool\s*[:：]\s*`([\w.-]+)`(?:[ \t]*📥[ \t]*args:)?/i
const COMPACT = /^🛠️?\s*([\w.-]+)\s*\(/
const TURN = /^(?:\*\*)?LLM Running \(Turn (\d+)\) \.\.\.(?:\*\*)?/i
const EDGE = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/

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
  const open = EDGE.exec(source.slice(start))!
  const size = open[1].length, char = open[1][0]
  let pos = start + open[0].length
  while (pos < source.length) {
    const newline = source.indexOf('\n', pos)
    const end = newline < 0 ? source.length : newline + 1
    const line = source.slice(pos, end).replace(/\r?\n$/, '')
    const close = new RegExp(`^[ \\t]*${char === '`' ? '`' : '~'}{${size},}[ \\t]*$`).exec(line)
    if (close) return { end, complete: true, repair: null }
    // Only a known tool wrapper accepts a producer's result+closing-fence
    // concatenation. Backticks inside prose/code are never normalized.
    if (tool && char === '`') {
      const glued = new RegExp(`(?<!\x60)\x60{${size}}[ \\t]*$`).exec(line)
      if (glued && glued.index > 0) return { end, complete: true, repair: pos + glued.index }
    }
    pos = end
  }
  return { end: source.length, complete: false, repair: null }
}

export function scanTranscript(source: string): TranscriptNode[] {
  const nodes: TranscriptNode[] = []
  let pos = 0, textStart = 0
  const push = (kind: TranscriptNode['kind'], start: number, end: number, extra: Partial<TranscriptNode> = {}) => {
    nodes.push({ kind, start, end, raw: source.slice(start, end), complete: true, ...extra })
  }
  const flush = () => { if (pos > textStart) push('text', textStart, pos) }
  while (pos < source.length) {
    const rest = source.slice(pos)
    const lineStart = pos === 0 || source[pos - 1] === '\n'
    const turn = TURN.exec(rest)
    if (turn) {
      flush(); push('turn', pos, pos + turn[0].length, { turn: Number(turn[1]) })
      pos += turn[0].length; textStart = pos; continue
    }
    const meta = /^<(summary|thinking|think|analysis)>/i.exec(rest)
    if (meta) {
      const close = new RegExp(`</${meta[1]}>`, 'i').exec(rest.slice(meta[0].length))
      const end = close ? pos + meta[0].length + close.index + close[0].length : source.length
      flush(); push(meta[1].toLowerCase() === 'summary' ? 'summary' : 'thinking', pos, end, { complete: !!close })
      pos = end; textStart = pos; continue
    }
    let header = TOOL.exec(rest)
    if (header) {
      const suffix = rest.slice(header[0].length).trimStart()
      const argsPending = suffix.length > 0 && '📥 args:'.startsWith(suffix)
      if (argsPending) header[0] = rest
      else if (!/^(?:📥\s*args:|`{1,}|$)/.test(suffix)) header = null
    }
    const adjacentTool = nodes.at(-1)?.kind === 'tool' && nodes.at(-1)?.end === pos
    const compact = header || (!lineStart && !adjacentTool) ? null : COMPACT.exec(rest)
    if (header || compact) {
      flush()
      const start = pos, name = (header?.[1] || compact![1])
      const headerEnd = header ? pos + header[0].length : balancedCall(source, pos + compact![0].length)
      let end = headerEnd ?? source.length, complete = headerEnd !== null
      const opaque: { start: number; end: number }[] = [], repairs: number[] = []
      // Detailed args/results are fenced blocks immediately after a call.
      // Whitespace is part of the call only when followed by its wrapper.
      while (complete) {
        const white = /^\s*/.exec(source.slice(end))![0].length
        const next = end + white, edge = EDGE.exec(source.slice(next))
        if (edge && edge[1][0] === '`' && edge[1].length >= 4) {
          const block = fence(source, next, true)
          opaque.push({ start: next, end: block.end })
          if (block.repair !== null) repairs.push(block.repair)
          end = block.end; complete = block.complete; continue
        }
        // A wrapper can arrive one backtick at a time.
        if (next < source.length && /^`{1,3}$/.test(source.slice(next))) {
          opaque.push({ start: next, end: source.length }); end = source.length; complete = false
        }
        break
      }
      push('tool', start, end, { name, headerEnd: compact ? start + compact[0].length : headerEnd ?? undefined, complete, opaque, repairs })
      pos = end; textStart = pos; continue
    }
    if (lineStart && EDGE.test(rest)) {
      flush(); const block = fence(source, pos, false)
      push('code', pos, block.end, { complete: block.complete })
      pos = block.end; textStart = pos; continue
    }
    // Delay only protocol prefixes at the very end, not arbitrary text.
    if (rest.startsWith('<') && ['<thinking>', '<think>', '<analysis>'].some(tag => tag.startsWith(rest.toLowerCase()))) {
      flush(); push('pending', pos, source.length, { complete: false }); pos = source.length; textStart = pos; break
    }
    if (/^(?:🛠️?\s*(?:T(?:o(?:o(?:l(?::\s*(?:`[\w.]*)?)?)?)?)?)?|<(?:s(?:u(?:m(?:m(?:a(?:r(?:y)?)?)?)?)?)?)?)$/i.test(rest)) {
      flush(); push('pending', pos, source.length, { complete: false }); pos = source.length; textStart = pos; break
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
