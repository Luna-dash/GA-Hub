import { storageKeys } from '@/config/storageKeys'
import { readRelativeFontScale } from './relativeFontScale'

export const CHAT_FONT_SCALE_KEY = storageKeys.chatFontScaleRelative
export const CHAT_FONT_BASELINE = 90
export const chatFontPercent = (scale: number): number => CHAT_FONT_BASELINE * scale / 100
export const CHAT_FONT_SCALE_EVENT = 'gahub:chat-font-scale'
export const CHAT_FONT_SCALE_DEFAULT = 100
export const CHAT_FONT_SCALE_MIN = 75
export const CHAT_FONT_SCALE_MAX = 200
export const CHAT_FONT_SCALE_STEP = 5

export function clampChatFontScale(value: number): number {
  if (!Number.isFinite(value)) return CHAT_FONT_SCALE_DEFAULT
  const stepped = Math.round(value / CHAT_FONT_SCALE_STEP) * CHAT_FONT_SCALE_STEP
  return Math.max(CHAT_FONT_SCALE_MIN, Math.min(CHAT_FONT_SCALE_MAX, stepped))
}

export function getChatFontScale(): number {
  return readRelativeFontScale(CHAT_FONT_SCALE_KEY, storageKeys.chatFontScale,
    CHAT_FONT_BASELINE, CHAT_FONT_SCALE_MIN, CHAT_FONT_SCALE_MAX)
}

export function setChatFontScale(value: number): number {
  const scale = clampChatFontScale(value)
  try { localStorage.setItem(CHAT_FONT_SCALE_KEY, String(scale)) } catch {}
  window.dispatchEvent(new CustomEvent<number>(CHAT_FONT_SCALE_EVENT, { detail: scale }))
  return scale
}
