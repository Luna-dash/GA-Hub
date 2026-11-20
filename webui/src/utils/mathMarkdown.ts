/**
 * Normalize LaTeX math delimiters into remark-math's `$$...$$` syntax while
 * keeping inline vs. display semantics intact and protecting code/currency/shell.
 *
 * remark-math is configured with `singleDollarTextMath: false` so bare `$PATH`,
 * PowerShell `$env:FOO`, or `$5 ... $10` are never parsed by micromark as raw
 * dollar math. Here we safely convert:
 *   1. `\(...\)`        → inline `$$...$$` (same line, never forced into block)
 *   2. `\[...\]`        → display `$$\n...\n$$` (preserving blockquote prefix)
 *   3. standalone `$$x$$` on its own line → display `$$\n...\n$$`
 *   4. guarded `$...$`  → inline `$$...$$` (Pandoc + shell/currency guards)
 */

import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const markdownParser = unified().use(remarkParse).use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false }).freeze()

type SourceRange = { start: number; end: number }

function getMarkdownRanges(src: string) {
  const literals: SourceRange[] = []
  const tables: SourceRange[] = []
  type Node = {
    type: string
    position?: { start: { offset?: number }; end: { offset?: number } }
    children?: Node[]
    referenceType?: string
  }
  const pending: Node[] = [markdownParser.parse(src)]

  // For links, protect the destination/title but let
  // explicit link labels continue to participate in inline math.
  while (pending.length) {
    const node = pending.pop()!
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) continue

    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'definition'
      || node.type === 'image' || node.type === 'imageReference' || node.type === 'html') {
      literals.push({ start, end })
      continue
    }
    if (node.type === 'link' || node.type === 'linkReference') {
      // Shortcut/collapsed references use the label itself as the lookup key.
      if ((node.type === 'linkReference' && node.referenceType !== 'full')
        || src[start] !== '[' || !node.children?.length) {
        literals.push({ start, end })
        continue
      }
      const labelEnd = node.children.at(-1)?.position?.end.offset ?? start
      literals.push({ start: labelEnd, end })
    }
    if (node.type === 'table') tables.push({ start, end })
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i])
    }
  }
  literals.sort((a, b) => a.start - b.start)
  return { literals, tables }
}

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const TEX_TEXT_MACRO_RE = /\\(?:text|textrm|textbf|textit|mathrm|mathbf|operatorname|mbox)\s*\{[^{}]*\}/g
const DISPLAY_BRACKET_MATH_SIGNAL_RE = /[\\^_=<>+*{}|]/
const CURRENCY_FRAGMENT_RE = /^\d+(?:[.,]\d+)?(?:\s*[)%\],.;:!?]|$)/

/**
 * Normalize math delimiters in chat-mode markdown.
 * Skips Markdown code, link destinations/titles, existing math blocks, and `\$`.
 */
export function normalizeMathDelimiters(src: string): string {
  if (!src || !/[\\$]/.test(src)) return src

  const { literals, tables } = getMarkdownRanges(src)
  let literalIndex = 0
  let tableIndex = 0
  let out = ''
  let i = 0
  const len = src.length

  function isTableRowAt(index: number): boolean {
    while (tableIndex < tables.length && tables[tableIndex].end <= index) tableIndex++
    if (tables[tableIndex]?.start <= index) return true
    // Pipes inside a formula can make the raw header's column count disagree
    // with its delimiter row, so GFM may not recognize the table until we
    // normalize the header. Check the following line as a fallback.
    const lineStart = findLineStart(src, index)
    if (/^[ \t]*\|/.test(src.slice(lineStart, index + 1))) return true
    const lineEnd = findLineEnd(src, index)
    const quotePrefix = extractBlockquotePrefix(src.slice(lineStart, lineEnd))
    const nextStart = advancePastLine(src, lineEnd)
    const nextLine = src.slice(nextStart, findLineEnd(src, nextStart))
    const nextPrefix = extractBlockquotePrefix(nextLine)
    if (nextPrefix.split('>').length !== quotePrefix.split('>').length) return false
    return /^(?=.*\|)[ \t]*\|?[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*\|?[ \t]*$/.test(nextLine.slice(nextPrefix.length))
  }

  while (i < len) {
    while (literalIndex < literals.length && literals[literalIndex].end <= i) literalIndex++
    const nextLiteral = literals[literalIndex]
    if (nextLiteral && i >= nextLiteral.start) {
      out += src.slice(i, nextLiteral.end)
      i = nextLiteral.end
      continue
    }
    const literalStart = nextLiteral?.start ?? len
    const atLineStart = i === 0 || src[i - 1] === '\n'

    if (atLineStart) {
      const displayEnd = matchMultilineDollarBlock(src, i)
      if (displayEnd > i) {
        out += src.slice(i, displayEnd)
        i = displayEnd
        continue
      }

      const singleLineBlock = matchStandaloneDollarLine(src, i)
      if (singleLineBlock && singleLineBlock.nextIndex <= literalStart) {
        out += singleLineBlock.replacement
        i = singleLineBlock.nextIndex
        continue
      }
    }

    const ch = src[i]

    if (ch === '\\' && i + 1 < len) {
      const next = src[i + 1]
      if (next === '\\' || next === '$') {
        out += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (next === '(') {
        const inlineMatch = matchParenInlineMath(src, i)
        if (inlineMatch && inlineMatch.nextIndex <= literalStart) {
          out += formatInlineMath(inlineMatch.body, isTableRowAt(i))
          i = inlineMatch.nextIndex
          continue
        }
      }
      if (next === '[') {
        const displayMatch = matchBracketDisplayMath(src, i)
        if (displayMatch && displayMatch.nextIndex <= literalStart) {
          const lineStart = findLineStart(src, i)
          const beforeOnLine = src.slice(lineStart, i)
          const hasTextBefore = /\S/.test(beforeOnLine.replace(/^(?:[ \t]*>[ \t]?)+/, ''))
          const quotePrefix = extractBlockquotePrefix(beforeOnLine)
          const indentPrefix = hasTextBefore ? quotePrefix : beforeOnLine
          const afterLineEnd = findLineEnd(src, displayMatch.nextIndex)
          const afterOnLine = src.slice(displayMatch.nextIndex, afterLineEnd)
          const hasTextAfter = /\S/.test(afterOnLine)

          if (hasTextBefore) out += '\n'
          out += `${hasTextBefore ? quotePrefix : ''}$$\n${formatDisplayBody(displayMatch.body, indentPrefix)}\n${indentPrefix}$$`
          if (hasTextAfter) {
            out += `\n${quotePrefix}`
            // Trim one leading space when text follows `\] ` on the same line.
            i = src[displayMatch.nextIndex] === ' ' ? displayMatch.nextIndex + 1 : displayMatch.nextIndex
          } else {
            i = displayMatch.nextIndex
          }
          continue
        }
      }
      out += ch
      i += 1
      continue
    }

    // Existing inline `$$...$$`: copy verbatim so inner `$` / `\(` aren't re-parsed.
    if (ch === '$' && src[i + 1] === '$') {
      const close = findClosingDoubleDollar(src, i + 2)
      if (close >= 0 && close + 2 <= literalStart) {
        const body = src.slice(i + 2, close)
        if (isTableRowAt(i)) {
          out += `$$${escapeTablePipes(body)}$$`
        } else {
          out += src.slice(i, close + 2)
        }
        i = close + 2
        continue
      }
      out += '$$'
      i += 2
      continue
    }

    // Single-dollar inline math with strict shell / currency guards.
    if (ch === '$') {
      const singleMatch = matchGuardedSingleDollar(src, i)
      if (singleMatch && singleMatch.nextIndex <= literalStart) {
        out += formatInlineMath(singleMatch.body, isTableRowAt(i))
        i = singleMatch.nextIndex
        continue
      }
    }

    out += ch
    i += 1
  }

  return out
}

function findLineStart(src: string, index: number): number {
  const prevNl = src.lastIndexOf('\n', index - 1)
  return prevNl < 0 ? 0 : prevNl + 1
}

function findLineEnd(src: string, index: number): number {
  const nl = src.indexOf('\n', index)
  if (nl < 0) return src.length
  return nl > index && src[nl - 1] === '\r' ? nl - 1 : nl
}

function advancePastLine(src: string, index: number): number {
  const nl = src.indexOf('\n', index)
  return nl < 0 ? src.length : nl + 1
}

function extractBlockquotePrefix(s: string): string {
  const m = /^(?:[ \t]*>[ \t]?)+/.exec(s)
  return m ? m[0] : ''
}

function escapeTablePipes(body: string): string {
  // Consume an escaped character or a single bare pipe, not the preceding
  // character: adjacent pipes must each be protected from GFM's cell splitter.
  return body.replace(/\\[\s\S]|\|/g, (token) => token === '|' ? '\\vert ' : token)
}

function formatInlineMath(rawBody: string, inTableRow: boolean): string {
  const collapsed = rawBody.trim().replace(/\r?\n[ \t]*/g, ' ')
  const body = inTableRow ? escapeTablePipes(collapsed) : collapsed
  const padStart = body.startsWith('$') ? ' ' : ''
  const padEnd = body.endsWith('$') ? ' ' : ''
  return `$$${padStart}${body}${padEnd}$$`
}

function formatDisplayBody(rawBody: string, prefix: string): string {
  const trimmed = rawBody.trim()
  if (!prefix) return trimmed
  const lines = trimmed.split(/\r?\n/)
  return lines
    .map((line, idx) => {
      if (idx === 0) return `${prefix}${line}`
      // Preserve lines that already carry a blockquote/indent prefix.
      if (prefix.includes('>') && /^[ \t]*>/.test(line)) return line
      if (/^[ \t]+/.test(line)) return line
      return `${prefix}${line}`
    })
    .join('\n')
}

function matchMultilineDollarBlock(src: string, start: number): number {
  const lineEnd = findLineEnd(src, start)
  const firstLine = src.slice(start, lineEnd)
  if (!/^(?:[ \t]*>[ \t]?)*[ \t]*\$\$[ \t]*$/.test(firstLine)) return start

  let pos = advancePastLine(src, lineEnd)
  while (pos < src.length) {
    const end = findLineEnd(src, pos)
    if (/^(?:[ \t]*>[ \t]?)*[ \t]*\$\$[ \t]*$/.test(src.slice(pos, end))) {
      return advancePastLine(src, end)
    }
    pos = advancePastLine(src, end)
  }
  return src.length
}

function matchStandaloneDollarLine(
  src: string,
  start: number,
): { replacement: string; nextIndex: number } | null {
  const lineEnd = findLineEnd(src, start)
  const line = src.slice(start, lineEnd)
  const m = /^((?:[ \t]*>[ \t]?)*[ \t]*)\$\$([^\r\n]+?)\$\$[ \t]*$/.exec(line)
  if (!m) return null
  const prefix = m[1]
  const body = m[2].trim()
  // Reject lines with multiple `$$...$$` segments like `$$a$$ + $$b$$`.
  if (!body || m[2].includes('$$')) return null
  return {
    replacement: `${prefix}$$\n${prefix}${body}\n${prefix}$$`,
    nextIndex: lineEnd,
  }
}

function matchParenInlineMath(
  src: string,
  start: number,
): { body: string; nextIndex: number } | null {
  let i = start + 2
  while (i < src.length) {
    if (src[i] === '\n') {
      // Stop at blank line (paragraph boundary).
      let j = i + 1
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j += 1
      if (src[j] === '\n') return null
    }
    if (src[i] === '\\' && i + 1 < src.length) {
      if (src[i + 1] === ')') {
        const body = src.slice(start + 2, i)
        if (!body.trim() || body.includes('$$')) return null
        return { body, nextIndex: i + 2 }
      }
      if (src[i + 1] === '\\') {
        i += 2
        continue
      }
    }
    i += 1
  }
  return null
}

function matchBracketDisplayMath(
  src: string,
  start: number,
): { body: string; nextIndex: number } | null {
  let i = start + 2
  while (i < src.length) {
    if (src[i] === '\\' && i + 1 < src.length) {
      if (src[i + 1] === ']') {
        const body = src.slice(start + 2, i)
        if (!body.trim()) return null
        const lineStart = findLineStart(src, start)
        const lineEnd = findLineEnd(src, i + 2)
        const standalone =
          !/\S/.test(src.slice(lineStart, start).replace(/^(?:[ \t]*>[ \t]?)+/, ''))
          && !/\S/.test(src.slice(i + 2, lineEnd))
        const isMath = body.includes('\n') || standalone || DISPLAY_BRACKET_MATH_SIGNAL_RE.test(body)
        if (!isMath) return null
        return { body, nextIndex: i + 2 }
      }
      if (src[i + 1] === '\\') {
        i += 2
        continue
      }
    }
    i += 1
  }
  return null
}

function findClosingDoubleDollar(src: string, start: number): number {
  let i = start
  while (i < src.length) {
    if (src[i] === '\n') {
      let j = i + 1
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j += 1
      if (src[j] === '\n') return -1
    }
    if (src[i] === '\\' && i + 1 < src.length) {
      i += 2
      continue
    }
    if (src[i] === '$' && src[i + 1] === '$') return i
    i += 1
  }
  return -1
}

function matchGuardedSingleDollar(
  src: string,
  start: number,
): { body: string; nextIndex: number } | null {
  const prev = start > 0 ? src[start - 1] : ''
  if (/[A-Za-z0-9_$\\]/.test(prev)) return null

  const next = src[start + 1] || ''
  if (!next || next === '$' || next === ' ' || next === '\t' || next === '\r' || next === '\n') {
    return null
  }

  let braceDepth = 0
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\r' || ch === '\n') return null
    if (ch === '\\' && i + 1 < src.length) {
      i += 2
      continue
    }
    if (ch === '{') {
      braceDepth += 1
      i += 1
      continue
    }
    if (ch === '}') {
      braceDepth -= 1
      if (braceDepth < 0) return null
      i += 1
      continue
    }
    if (ch === '$') {
      if (src[i + 1] === '$') return null
      const beforeClose = src[i - 1]
      if (beforeClose === ' ' || beforeClose === '\t') return null
      const afterClose = src[i + 1] || ''
      if (/[A-Za-z0-9_$]/.test(afterClose)) return null
      if (braceDepth !== 0) return null

      const body = src.slice(start + 1, i)
      if (!isLikelyInlineLatex(body)) return null
      return { body, nextIndex: i + 1 }
    }
    i += 1
  }
  return null
}

function isLikelyInlineLatex(body: string): boolean {
  if (!body) return false
  if (CURRENCY_FRAGMENT_RE.test(body) && !/^\d+(?:\.\d+)?$/.test(body)) return false

  const stripped = body.replace(TEX_TEXT_MACRO_RE, '')
  if (CJK_RE.test(stripped)) {
    if (/^\d/.test(body)) return false
    if (/\s/.test(stripped) || !/[\\^_=<>+*{}|]/.test(stripped)) return false
  }
  return true
}
