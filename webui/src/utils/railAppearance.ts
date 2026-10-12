import { storageKeys } from '@/config/storageKeys'
import { readRelativeFontScale } from './relativeFontScale'

export const RAIL_TITLE_SCALE_KEY = storageKeys.railTitleScaleRelative
export const RAIL_TITLE_BASELINE = 60
export const railTitlePercent = (scale: number): number => RAIL_TITLE_BASELINE * scale / 100
export const RAIL_TITLE_SCALE_EVENT = 'gahub:rail-title-scale'
export const RAIL_TITLE_SCALE_DEFAULT = 100
// Percent of the captured desktop title size; allow both smaller and larger.
export const RAIL_TITLE_SCALE_MIN = 75
export const RAIL_TITLE_SCALE_MAX = 200
export const RAIL_TITLE_SCALE_STEP = 5

export function clampRailTitleScale(value: number): number {
  if (!Number.isFinite(value)) return RAIL_TITLE_SCALE_DEFAULT
  const stepped = Math.round(value / RAIL_TITLE_SCALE_STEP) * RAIL_TITLE_SCALE_STEP
  return Math.max(RAIL_TITLE_SCALE_MIN, Math.min(RAIL_TITLE_SCALE_MAX, stepped))
}

export function getRailTitleScale(): number {
  return readRelativeFontScale(RAIL_TITLE_SCALE_KEY, storageKeys.railTitleScale,
    RAIL_TITLE_BASELINE, RAIL_TITLE_SCALE_MIN, RAIL_TITLE_SCALE_MAX)
}

export function setRailTitleScale(value: number): number {
  const scale = clampRailTitleScale(value)
  try { localStorage.setItem(RAIL_TITLE_SCALE_KEY, String(scale)) } catch {}
  window.dispatchEvent(new CustomEvent<number>(RAIL_TITLE_SCALE_EVENT, { detail: scale }))
  return scale
}
