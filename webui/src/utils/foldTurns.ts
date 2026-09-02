// foldTurns — 直播流式渲染的分段视图。
//
// 实现收敛：唯一的 turn/围栏/summary 解析引擎是 assistantTranscript 的
// parseAssistantTranscript（锚定围栏保护）。此前这里维护着第二套非锚定
// 正则，正文里合法的 4+ 反引号块会在流式期间被错误配对吞掉、完成后又
// "变好"（回归：ga更新任务 目录树；双引擎正则漂移）。
// 直播与完成后的差异只剩"最后一个 turn 是生长中的正文段"，不再换引擎。

import { parseAssistantTranscript } from '@/utils/assistantTranscript'

export type Segment =
  | { type: 'text'; content: string }
  | { type: 'fold'; title: string; content: string }

// Strip CLOSED <summary>...</summary> blocks. Half-open ones (still
// streaming) are left intact so partial tokens don't render as plain
// "<summary>" text for one frame and then disappear when the close
// tag arrives — that flicker is more annoying than a brief tag.
function stripClosedSummary(s: string): string {
  return s.replace(/<summary>[\s\S]*?<\/summary>\s*/g, '')
}

export function foldTurns(text: string): Segment[] {
  if (!text) return []
  const transcript = parseAssistantTranscript(text)

  const segments: Segment[] = []
  if (transcript.leading.trim()) {
    segments.push({ type: 'text', content: transcript.leading })
  }
  if (!transcript.turns.length) {
    // 没有 turn 标记：整段作为生长中的正文（保持直播语义——不做
    // ask_user 替换/结论选择，那属于完成后的投影层）。
    segments.push({ type: 'text', content: stripClosedSummary(text) })
    return segments
  }

  transcript.turns.forEach((turn, index) => {
    if (index < transcript.turns.length - 1) {
      segments.push({ type: 'fold', title: turn.summary || '执行记录', content: turn.content })
    } else {
      // 最后一个 turn 是直播中的正文段；turn 标记由引擎剥除，
      // 直播与完成后的外观因此一致（不再显示 "LLM Running (Turn N)" 原文）。
      segments.push({ type: 'text', content: turn.content })
    }
  })
  return segments
}

/** Shorten very long single-line previews (used in conversation list). */
export function previewText(s: string, n = 80): string {
  const flat = (s || '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}

/** Format a unix epoch (seconds) as relative time, fallback to local string. */
export function relTime(ts: number): string {
  if (!ts) return ''
  const d = Math.floor(Date.now() / 1000) - ts
  if (d < 60) return `${d}秒前`
  if (d < 3600) return `${Math.floor(d / 60)}分前`
  if (d < 86400) return `${Math.floor(d / 86400)}小时前`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}天前`
  return new Date(ts * 1000).toLocaleString()
}
