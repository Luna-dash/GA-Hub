// timeFormat — pure epoch-seconds formatters shared by Conductor surfaces.
// Timestamps from the hub/engine are epoch seconds (floats); the UI renders
// local time. Keep these pure so tests can pin `nowSeconds`.

export function formatClock(epochSeconds: number, nowSeconds = Date.now() / 1000): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
  const date = new Date(epochSeconds * 1000)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date(nowSeconds * 1000).toDateString()) return time
  return `${date.getMonth() + 1}-${date.getDate()} ${time}`
}

/** '刚刚' → 'N分钟前' → 'N小时前' → 'M-D HH:MM' (or last year's date). */
export function formatRelativeTime(epochSeconds: number, nowSeconds = Date.now() / 1000): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
  const diff = nowSeconds - epochSeconds
  if (diff < 90) return '刚刚'
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}分钟前`
  if (diff < 24 * 3600) return `${Math.floor(diff / 3600)}小时前`
  return formatClock(epochSeconds, nowSeconds)
}

/** Same compact shape as MessageBubble's streaming timer: M:SS / H:MM:SS. */
export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}
