// Heuristics for agent tool-call / stdout traces that should NOT go through
// full chat markdown (math + syntax colors). Shared by MessageBubble and
// Conversations history extraction.

/** Strip outer markdown fences that wrap an entire tool block.
 *  只剥「首行开栏 + 末行闭栏」的最外层壳（可多层）；正文内部的合法
 *  代码块围栏一律保留——全局逐行剥壳曾把目录树 ```text 围栏吃掉。 */
export function stripWrapperFences(s: string): string {
  let text = (s || '').trim()
  let prev = ''
  while (text && text !== prev) {
    prev = text
    const open = /^`{3,}[a-zA-Z0-9_-]*[ \t]*\r?\n/.exec(text)
    if (!open) break
    if (!/\r?\n[ \t]*`{3,}[ \t]*$/.test(text)) break
    text = text
      .slice(open[0].length)
      .replace(/\r?\n[ \t]*`{3,}[ \t]*$/, '')
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
