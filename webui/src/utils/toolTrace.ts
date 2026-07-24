// Heuristics for agent tool-call / stdout traces that should NOT go through
// full chat markdown (math + syntax colors). Shared by MessageBubble and
// Conversations history extraction.

/** Strip outer markdown fences that sometimes wrap an entire tool block. */
export function stripWrapperFences(s: string): string {
  let text = (s || '').trim()
  let prev = ''
  while (text && text !== prev) {
    prev = text
    text = text
      .replace(/^\s*`{3,}[a-zA-Z0-9_-]*\s*$/gm, '')
      .replace(/^\s*`{3,}[a-zA-Z0-9_-]*\s*\r?\n/, '')
      .replace(/\r?\n\s*`{3,}\s*$/g, '')
      .trim()
  }
  return text
}

/**
 * True when `s` looks like a tool invocation dump / stdout rather than
 * natural-language assistant prose. Used to pick MarkdownView mode=plain.
 */
export function looksLikeToolTrace(s: string): boolean {
  const text = stripWrapperFences(s).trim()
  if (!text) return true
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || ''
  if (
    /^`{3,}\s*$/.test(firstLine) ||
    /^🛠️\s*Tool:/i.test(firstLine) ||
    /^🛠️\s*[a-zA-Z_][\w.]*\(/.test(firstLine) ||
    /^\[Action\]/i.test(firstLine) ||
    /^\[(Info|Warn|Error|Status|Stdout|Stderr|系统)\]/i.test(firstLine) ||
    /^\{[\s\S]*\}\s*$/.test(text)
  ) {
    return true
  }
  // Dense tool/runtime dumps (code_run etc.) even without the 🛠️ prefix.
  const head = text.slice(0, 800)
  if (
    /\b(code_run|file_read|file_write|file_patch|web_scan|web_execute_js)\b/.test(head) &&
    /\b(stdout|stderr|exit_code|RUNNING_PIDS|ErrorActionPreference)\b/i.test(head)
  ) {
    return true
  }
  if (/^(stdout|stderr)\s*[:=]/im.test(text) && text.split(/\r?\n/).length >= 3) {
    return true
  }
  return false
}
