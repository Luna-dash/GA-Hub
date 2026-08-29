export const RAIL_TITLE_SCALE_KEY = 'gahub.rail-title-scale'
export const RAIL_TITLE_SCALE_EVENT = 'gahub:rail-title-scale'
export const RAIL_TITLE_SCALE_DEFAULT = 100
export const RAIL_TITLE_SCALE_MIN = 75
export const RAIL_TITLE_SCALE_MAX = 150
export const RAIL_TITLE_SCALE_STEP = 5

export function clampRailTitleScale(value: number): number {
  if (!Number.isFinite(value)) return RAIL_TITLE_SCALE_DEFAULT
  const stepped = Math.round(value / RAIL_TITLE_SCALE_STEP) * RAIL_TITLE_SCALE_STEP
  return Math.max(RAIL_TITLE_SCALE_MIN, Math.min(RAIL_TITLE_SCALE_MAX, stepped))
}

export function getRailTitleScale(): number {
  try {
    const stored = Number(localStorage.getItem(RAIL_TITLE_SCALE_KEY))
    return stored ? clampRailTitleScale(stored) : RAIL_TITLE_SCALE_DEFAULT
  } catch {
    return RAIL_TITLE_SCALE_DEFAULT
  }
}

export function setRailTitleScale(value: number): number {
  const scale = clampRailTitleScale(value)
  try { localStorage.setItem(RAIL_TITLE_SCALE_KEY, String(scale)) } catch {}
  window.dispatchEvent(new CustomEvent<number>(RAIL_TITLE_SCALE_EVENT, { detail: scale }))
  return scale
}
