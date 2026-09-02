// 会话提交侧与展示侧共用的附件标记协议。
//
// 此前 FILE_HINT 字符串在 LiveChat（构造，且 submit/schedule 各一份）与
// MessageBubble（清洗）三处手抄——改一处漏另一处会让剥离悄悄失效。
// 单一来源是结构要求：构造端和清洗端必须引用同一个常量。
export const FILE_HINT =
  'If you need to show files to user, use [FILE:filepath] in your response.'

/** 把用户可见文本 + 附件组装为发给 LLM 的完整 prompt（附件以标记行追加）。 */
export function buildSessionPromptText(
  text: string,
  attachments: ReadonlyArray<{ path: string }>,
): string {
  const t = text.trim()
  const fileMarkers = attachments.map((a) => `[用户发送文件: ${a.path}]`).join('\n')
  const fileHint = attachments.length ? `${FILE_HINT}\n\n` : ''
  return fileHint + t + (fileMarkers ? (t ? '\n' : '') + fileMarkers : '')
}
