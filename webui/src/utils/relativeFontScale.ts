// v2 scales are relative to the captured desktop baseline, not the old 100%.
// Keep legacy keys intact so older desktop builds remain visually unchanged.
export function readRelativeFontScale(
  key: string,
  legacyKey: string,
  baseline: number,
  min: number,
  max: number,
): number {
  const bound = (value: number) => Math.max(min, Math.min(max, value))
  try {
    const current = localStorage.getItem(key)
    if (current !== null) {
      const value = Number(current)
      return current.trim() && Number.isFinite(value) && value > 0 ? bound(value) : 100
    }
    const legacy = localStorage.getItem(legacyKey)
    if (legacy !== null && legacy.trim()) {
      const value = Number(legacy)
      if (Number.isFinite(value) && value > 0) {
        // Do not round to the slider step during migration: preserve the size.
        const relative = bound(value / baseline * 100)
        try { localStorage.setItem(key, String(relative)) } catch { /* read-only storage */ }
        return relative
      }
    }
  } catch { /* Storage is optional (private mode / blocked access). */ }
  return 100
}
