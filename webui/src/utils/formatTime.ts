// Shared display formatter for epoch-second / Date timestamps.
//
// One wire-consistent rendering for "full local date-time" call sites
// (schedule cards, backup lists, archive rows). Formats with a distinct
// need — CronPreview's compact card line, MessageBubble's bubble clock,
// LiveChat's datetime-local input value, tokenStatsUi's date bucketing —
// keep their own shapes on purpose.
export function formatDateTime(input: number | Date): string {
  const date = typeof input === 'number' ? new Date(input * 1000) : input
  return date.toLocaleString('zh-CN', { hour12: false })
}
