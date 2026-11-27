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

type SourceRange = { start: number; end: number }

const TABLE_DELIMITER_ROW_RE = /^(?=.*\|)[ \t]*\|?[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*\|?[ \t]*$/
const REF_DEF_LINE_RE = /^[ ]{0,3}\[([^\]\r\n]+)\]:[ \t]*\S/

function normalizeRefLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Lightweight linear scanner replacing a full unified/remark AST pre-pass.
 * Identifies literal ranges (fenced code blocks, inline code spans, link
 * destinations/titles, reference definitions, images, HTML tags) and GFM
 * table ranges in O(n) without constructing a Markdown AST.
 */
function getMarkdownRanges(src: string) {
  const literals: SourceRange[] = []
  const tables: SourceRange[] = []
  const refDefs = new Set<string>()
  const len = src.length

  // Pass 1: line-level structures (fenced code blocks, ref definitions, GFM tables)
  const lineStarts: number[] = []
  const lineEnds: number[] = []
  let pos = 0
  while (pos <= len) {
    lineStarts.push(pos)
    const nl = src.indexOf('\n', pos)
    if (nl < 0) {
      lineEnds.push(len)
      break
    }
    lineEnds.push(nl > pos && src[nl - 1] === '\r' ? nl - 1 : nl)
    pos = nl + 1
  }

  const fenceLineMask = new Uint8Array(lineStarts.length)
  let inFenceChar = ''
  let inFenceLen = 0
  let fenceStartOffset = 0
  let prevWasBlankOrCode = true

  for (let lineIdx = 0; lineIdx < lineStarts.length; lineIdx++) {
    const start = lineStarts[lineIdx]
    const end = lineEnds[lineIdx]
    const line = src.slice(start, end)
    const quotePrefix = extractBlockquotePrefix(line)
    const body = line.slice(quotePrefix.length)

    if (inFenceChar) {
      fenceLineMask[lineIdx] = 1
      const closeMatch = new RegExp(`^[ ]{0,3}${inFenceChar}{${inFenceLen},}[ \\t]*$`).exec(body)
      if (closeMatch) {
        const blockEnd = lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] : len
        literals.push({ start: fenceStartOffset, end: blockEnd })
        inFenceChar = ''
        inFenceLen = 0
        prevWasBlankOrCode = true
      }
      continue
    }

    const openMatch = /^[ ]{0,3}(`{3,}|~{3,})/.exec(body)
    if (openMatch) {
      const marker = openMatch[1]
      const rest = body.slice(openMatch[0].length)
      // Backtick info strings cannot contain backticks per CommonMark.
      if (marker[0] !== '`' || !rest.includes('`')) {
        inFenceChar = marker[0]
        inFenceLen = marker.length
        fenceStartOffset = start
        fenceLineMask[lineIdx] = 1
        prevWasBlankOrCode = false
        continue
      }
    }

    if (!body.trim()) {
      prevWasBlankOrCode = true
      continue
    }

    // CommonMark indented code block: >=4 leading spaces or tab after blank/code line
    if (prevWasBlankOrCode && /^(?: {4}|\t)/.test(body)) {
      const blockEnd = lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] : len
      literals.push({ start, end: blockEnd })
      fenceLineMask[lineIdx] = 1
      prevWasBlankOrCode = true
      continue
    }

    prevWasBlankOrCode = false

    const refMatch = REF_DEF_LINE_RE.exec(body)
    if (refMatch) {
      refDefs.add(normalizeRefLabel(refMatch[1]))
      const defEnd = lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] : len
      literals.push({ start, end: defEnd })
    }
  }
  if (inFenceChar) {
    literals.push({ start: fenceStartOffset, end: len })
  }

  // Detect GFM tables on non-fenced lines
  let lineIdx = 1
  while (lineIdx < lineStarts.length) {
    if (fenceLineMask[lineIdx] || fenceLineMask[lineIdx - 1]) {
      lineIdx += 1
      continue
    }
    const delimLine = src.slice(lineStarts[lineIdx], lineEnds[lineIdx])
    const delimPrefix = extractBlockquotePrefix(delimLine)
    const delimBody = delimLine.slice(delimPrefix.length)
    if (TABLE_DELIMITER_ROW_RE.test(delimBody)) {
      const headerLine = src.slice(lineStarts[lineIdx - 1], lineEnds[lineIdx - 1])
      const headerPrefix = extractBlockquotePrefix(headerLine)
      if (headerPrefix.split('>').length === delimPrefix.split('>').length && headerLine.includes('|')) {
        const tableStart = lineStarts[lineIdx - 1]
        let endIdx = lineIdx
        while (endIdx + 1 < lineStarts.length && !fenceLineMask[endIdx + 1]) {
          const nextLine = src.slice(lineStarts[endIdx + 1], lineEnds[endIdx + 1])
          const nextPrefix = extractBlockquotePrefix(nextLine)
          const nextBody = nextLine.slice(nextPrefix.length)
          if (!nextBody.trim() || nextPrefix.split('>').length !== delimPrefix.split('>').length || !nextBody.includes('|')) {
            break
          }
          endIdx += 1
        }
        tables.push({ start: tableStart, end: lineEnds[endIdx] })
        lineIdx = endIdx + 2
        continue
      }
    }
    lineIdx += 1
  }

  // Pass 2: inline literals (code spans, images, link destinations/refs, HTML tags)
  literals.sort((a, b) => a.start - b.start)
  const blockLiterals = literals.slice()
  let blkIdx = 0
  let i = 0
  while (i < len) {
    while (blkIdx < blockLiterals.length && blockLiterals[blkIdx].end <= i) blkIdx += 1
    if (blkIdx < blockLiterals.length && i >= blockLiterals[blkIdx].start) {
      i = blockLiterals[blkIdx].end
      continue
    }
    const limit = blkIdx < blockLiterals.length ? blockLiterals[blkIdx].start : len
    const ch = src[i]

    if (ch === '\\' && i + 1 < limit) {
      i += 2
      continue
    }

    // Inline code span: exact matching run of backticks
    if (ch === '`') {
      let tickEnd = i + 1
      while (tickEnd < limit && src[tickEnd] === '`') tickEnd += 1
      const tickCount = tickEnd - i
      let scan = tickEnd
      let closeEnd = -1
      while (scan < limit) {
        if (src[scan] === '`') {
          let runEnd = scan + 1
          while (runEnd < limit && src[runEnd] === '`') runEnd += 1
          if (runEnd - scan === tickCount) {
            closeEnd = runEnd
            break
          }
          scan = runEnd
          continue
        }
        scan += 1
      }
      if (closeEnd > 0) {
        literals.push({ start: i, end: closeEnd })
        i = closeEnd
        continue
      }
      i = tickEnd
      continue
    }

    // Image or Link: ![alt](dest) / [label](dest) / [label][ref] / [label][] / [label]
    if ((ch === '!' && src[i + 1] === '[') || ch === '[') {
      const isImage = ch === '!'
      const openBracket = isImage ? i + 1 : i
      let scan = openBracket + 1
      let depth = 1
      while (scan < limit && depth > 0) {
        if (src[scan] === '\\' && scan + 1 < limit) {
          scan += 2
          continue
        }
        if (src[scan] === '[') depth += 1
        else if (src[scan] === ']') depth -= 1
        if (depth > 0) scan += 1
      }
      if (depth === 0 && scan < limit) {
        const closeBracket = scan
        const afterBracket = closeBracket + 1
        if (afterBracket < limit && src[afterBracket] === '(') {
          // Inline link/image destination (handle nested parens & quotes)
          let dScan = afterBracket + 1
          let pDepth = 1
          let quote = ''
          while (dScan < limit && pDepth > 0) {
            const dc = src[dScan]
            if (dc === '\\' && dScan + 1 < limit) {
              dScan += 2
              continue
            }
            if (quote) {
              if (dc === quote) quote = ''
            } else if (dc === '"' || dc === "'") {
              quote = dc
            } else if (dc === '(') {
              pDepth += 1
            } else if (dc === ')') {
              pDepth -= 1
            }
            if (pDepth > 0) dScan += 1
          }
          if (pDepth === 0) {
            const destEnd = dScan + 1
            if (isImage) {
              literals.push({ start: i, end: destEnd })
              i = destEnd
            } else {
              literals.push({ start: closeBracket, end: destEnd })
              i = openBracket + 1
            }
            continue
          }
        } else if (afterBracket < limit && src[afterBracket] === '[') {
          const refClose = src.indexOf(']', afterBracket + 1)
          if (refClose >= 0 && refClose < limit) {
            const refText = src.slice(afterBracket + 1, refClose)
            const refEnd = refClose + 1
            if (isImage) {
              literals.push({ start: i, end: refEnd })
              i = refEnd
              continue
            }
            if (!refText) {
              // Collapsed reference: [label][]
              const labelKey = normalizeRefLabel(src.slice(openBracket + 1, closeBracket))
              if (refDefs.has(labelKey)) {
                literals.push({ start: i, end: refEnd })
                i = refEnd
                continue
              }
            } else {
              // Full reference: [label][ref]
              literals.push({ start: closeBracket, end: refEnd })
              i = openBracket + 1
              continue
            }
          }
        } else if (!isImage) {
          // Shortcut reference: [label] matching a known definition
          const labelKey = normalizeRefLabel(src.slice(openBracket + 1, closeBracket))
          if (refDefs.has(labelKey)) {
            literals.push({ start: i, end: afterBracket })
            i = afterBracket
            continue
          }
        }
      }
    }

    // Inline HTML tag / autolink: <tag ...> or <https://...>
    if (ch === '<' && i + 2 < limit && /[A-Za-z/!]/.test(src[i + 1])) {
      const gt = src.indexOf('>', i + 2)
      if (gt > i && gt < limit && !src.slice(i, gt).includes('\n')) {
        literals.push({ start: i, end: gt + 1 })
        i = gt + 1
        continue
      }
    }

    i += 1
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
  if (!src || !/\$|\\[([]/.test(src)) return src

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

function startsBlankLine(src: string, newlineIndex: number): boolean {
  let j = newlineIndex + 1
  while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j += 1
  return src[j] === '\n'
}

function matchParenInlineMath(
  src: string,
  start: number,
): { body: string; nextIndex: number } | null {
  let i = start + 2
  while (i < src.length) {
    if (src[i] === '\n' && startsBlankLine(src, i)) return null
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
    if (src[i] === '\n' && startsBlankLine(src, i)) return null
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
    if (src[i] === '\n' && startsBlankLine(src, i)) return -1
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
