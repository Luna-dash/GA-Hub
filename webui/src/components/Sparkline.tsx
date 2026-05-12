// Sparkline — tiny inline SVG line chart for dashboard trend strips.
//
// Designed to fit in a label row — no axes, no tooltips, no labels.
// Pass `values` (numeric series) and we render a smoothed area + line.
// `peak` overrides the y-axis ceiling so multiple sparklines can share scale.

interface Props {
  values: number[]
  width?: number
  height?: number
  peak?: number
  className?: string
  strokeClass?: string         // text-{color} class — line color follows currentColor
  /** Subtle area fill below the line. Pass undefined to disable. */
  fillOpacity?: number
}

export function Sparkline({
  values,
  width = 120,
  height = 28,
  peak,
  className,
  strokeClass = 'text-accent',
  fillOpacity = 0.18,
}: Props) {
  const n = values.length
  if (n === 0) {
    return (
      <svg width={width} height={height} className={className} aria-hidden />
    )
  }
  const max = peak ?? Math.max(1, ...values)
  const dx = n > 1 ? width / (n - 1) : 0
  const points: Array<[number, number]> = values.map((v, i) => {
    const x = i * dx
    const y = height - (v / max) * (height - 2) - 1
    return [x, y]
  })
  const linePath = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ')
  const areaPath =
    n > 1
      ? `${linePath} L${(n - 1) * dx} ${height} L0 ${height} Z`
      : ''

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`${strokeClass} ${className || ''}`}
      aria-hidden
    >
      {areaPath && (
        <path d={areaPath} fill="currentColor" opacity={fillOpacity} />
      )}
      <path d={linePath} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  )
}

// ── helpers ──────────────────────────────────────────────────────

/**
 * Bucket a list of unix-epoch (sec or ms) timestamps into `bucketCount`
 * equal-sized bins covering `[now - windowSec, now]`. Returns the per-bucket
 * count, oldest-first.
 *
 * Used by the dashboard to turn `agentStore.recent` (a flat event list) into
 * a per-minute density strip.
 */
export function bucketTimestamps(
  timestamps: number[],
  windowSec: number,
  bucketCount: number,
): number[] {
  const nowSec = Math.floor(Date.now() / 1000)
  const start = nowSec - windowSec
  const bucketSize = windowSec / bucketCount
  const out = new Array<number>(bucketCount).fill(0)
  for (const raw of timestamps) {
    const t = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw)
    if (t < start || t > nowSec) continue
    const idx = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((t - start) / bucketSize)),
    )
    out[idx]++
  }
  return out
}
