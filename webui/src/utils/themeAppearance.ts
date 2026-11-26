import { storageKeys } from '@/config/storageKeys'
import { syncUiSetting, UI_SETTINGS_HYDRATED_EVENT } from '@/stores/uiSettingsStore'

export type UiThemeId =
  | 'crisp-green-soft'
  | 'crisp-green-solid'
  | 'crisp-brown-soft'
  | 'crisp-brown-solid'
  | 'warm-parchment'
  | 'dark-forest'

export type PaperTextureId = 'fiber' | 'cotton' | 'none'

export const DEFAULT_UI_THEME: UiThemeId = 'crisp-green-soft'
export const DEFAULT_PAPER_TEXTURE: PaperTextureId = 'fiber'
export const UI_THEME_CHANGED_EVENT = 'gahub:ui-theme-changed'

export interface UiThemePreset {
  id: UiThemeId
  name: string
  tag: string
  description: string
  isDark: boolean
  swatches: {
    canvas: string
    card: string
    text: string
    accent: string
    userBubble: string
  }
}

export const UI_THEME_PRESETS: readonly UiThemePreset[] = [
  {
    id: 'crisp-green-soft',
    name: '清朗宣纸 · 松墨绿',
    tag: '推荐 · 柔底气泡',
    description: '高对比暖雾宣纸底配松烟墨字与浅绿柔底用户气泡，久看长文最轻松。',
    isDark: false,
    swatches: { canvas: '#EFECE4', card: '#FAF8F3', text: '#1C1917', accent: '#1B5E47', userBubble: '#E1EFE9' },
  },
  {
    id: 'crisp-green-solid',
    name: '清朗宣纸 · 深绿气泡',
    tag: '清晰分明',
    description: '宣纸底与松墨绿主色，用户消息采用实底深绿气泡，一眼区分我与 Agent。',
    isDark: false,
    swatches: { canvas: '#EFECE4', card: '#FAF8F3', text: '#1C1917', accent: '#1B5E47', userBubble: '#1B5E47' },
  },
  {
    id: 'crisp-brown-soft',
    name: '清朗宣纸 · 焦糖棕',
    tag: '暖调柔底',
    description: '高对比清朗宣纸底延续复古焦糖棕强调色，配浅米柔底用户气泡。',
    isDark: false,
    swatches: { canvas: '#EFECE4', card: '#FAF8F3', text: '#1C1917', accent: '#6E4219', userBubble: '#EFE6D8' },
  },
  {
    id: 'crisp-brown-solid',
    name: '清朗宣纸 · 深棕气泡',
    tag: '经典加深',
    description: '复古深棕高对比升级版，保持实底深棕用户气泡与暖纸视觉锚点。',
    isDark: false,
    swatches: { canvas: '#EFECE4', card: '#FAF8F3', text: '#1C1917', accent: '#6E4219', userBubble: '#6E4219' },
  },
  {
    id: 'warm-parchment',
    name: '温润旧纸 · 护眼暖黄',
    tag: '传统暖黄',
    description: '保留柔和暖黄旧纸底色，同时全面替换为高对比松烟墨字与松墨绿强调。',
    isDark: false,
    swatches: { canvas: '#E6DEC9', card: '#F2EBDA', text: '#1C1917', accent: '#1B5E47', userBubble: '#DAE7DF' },
  },
  {
    id: 'dark-forest',
    name: '静谧深色 · 深墨森林',
    tag: '夜间护眼',
    description: '深墨炭森林底色配暖米白正文字与松玉绿强调，适合低光环境长时间使用。',
    isDark: true,
    swatches: { canvas: '#121715', card: '#171E1B', text: '#ECE8DF', accent: '#5EC29B', userBubble: '#1D3A2F' },
  },
]

export interface PaperTextureOption {
  id: PaperTextureId
  name: string
  tag: string
  description: string
}

export const PAPER_TEXTURE_OPTIONS: readonly PaperTextureOption[] = [
  {
    id: 'fiber',
    name: '宣纸细纤维',
    tag: '纸纹 A · 推荐',
    description: '仅在外层画布铺设柔和宣纸纤维，正文卡片与代码块保持纯净锐利。',
  },
  {
    id: 'cotton',
    name: '全域绵纸颗粒',
    tag: '纸纹 B',
    description: '画布与正文卡片统一带极轻冷压绵纸手感，材质一体感更强。',
  },
  {
    id: 'none',
    name: '关闭纹理（纯净）',
    tag: '无纹理',
    description: '完全平坦纯色表面，最大化文字对比锐度与视觉简洁度。',
  },
]

const VALID_THEME_IDS = new Set<string>(UI_THEME_PRESETS.map((preset) => preset.id))
const VALID_TEXTURE_IDS = new Set<string>(PAPER_TEXTURE_OPTIONS.map((option) => option.id))

let hydrationBound = false

export function normalizeUiTheme(value: unknown): UiThemeId {
  return typeof value === 'string' && VALID_THEME_IDS.has(value)
    ? (value as UiThemeId)
    : DEFAULT_UI_THEME
}

export function normalizePaperTexture(value: unknown): PaperTextureId {
  return typeof value === 'string' && VALID_TEXTURE_IDS.has(value)
    ? (value as PaperTextureId)
    : DEFAULT_PAPER_TEXTURE
}

export function getUiTheme(): UiThemeId {
  try {
    return normalizeUiTheme(window.localStorage.getItem(storageKeys.uiTheme))
  } catch {
    return DEFAULT_UI_THEME
  }
}

export function getPaperTexture(): PaperTextureId {
  try {
    return normalizePaperTexture(window.localStorage.getItem(storageKeys.uiPaperTexture))
  } catch {
    return DEFAULT_PAPER_TEXTURE
  }
}

export function applyThemeAppearance(
  theme: UiThemeId = getUiTheme(),
  paperTexture: PaperTextureId = getPaperTexture(),
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = normalizeUiTheme(theme)
  root.dataset.paperTexture = normalizePaperTexture(paperTexture)
}

export function setUiTheme(value: UiThemeId): UiThemeId {
  const next = normalizeUiTheme(value)
  try {
    window.localStorage.setItem(storageKeys.uiTheme, next)
  } catch {
    // Ignore storage write errors; backend sync still proceeds.
  }
  syncUiSetting(storageKeys.uiTheme, next)
  applyThemeAppearance(next, getPaperTexture())
  window.dispatchEvent(
    new CustomEvent(UI_THEME_CHANGED_EVENT, {
      detail: { theme: next, paperTexture: getPaperTexture() },
    }),
  )
  return next
}

export function setPaperTexture(value: PaperTextureId): PaperTextureId {
  const next = normalizePaperTexture(value)
  try {
    window.localStorage.setItem(storageKeys.uiPaperTexture, next)
  } catch {
    // Ignore storage write errors; backend sync still proceeds.
  }
  syncUiSetting(storageKeys.uiPaperTexture, next)
  applyThemeAppearance(getUiTheme(), next)
  window.dispatchEvent(
    new CustomEvent(UI_THEME_CHANGED_EVENT, {
      detail: { theme: getUiTheme(), paperTexture: next },
    }),
  )
  return next
}

export function initThemeAppearance(): void {
  applyThemeAppearance(getUiTheme(), getPaperTexture())
  if (!hydrationBound && typeof window !== 'undefined') {
    hydrationBound = true
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, () => {
      const theme = getUiTheme()
      const paperTexture = getPaperTexture()
      applyThemeAppearance(theme, paperTexture)
      window.dispatchEvent(
        new CustomEvent(UI_THEME_CHANGED_EVENT, {
          detail: { theme, paperTexture },
        }),
      )
    })
  }
}
