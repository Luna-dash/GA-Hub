import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import clsx from 'clsx'
import { RotateCcw } from '@/components/ActionIcons'
import { UI_SETTINGS_HYDRATED_EVENT } from '@/stores/uiSettingsStore'
import {
  DEFAULT_PAPER_TEXTURE,
  DEFAULT_UI_THEME,
  getPaperTexture,
  getUiTheme,
  PAPER_TEXTURE_OPTIONS,
  setPaperTexture,
  setUiTheme,
  UI_THEME_CHANGED_EVENT,
  UI_THEME_PRESETS,
  type PaperTextureId,
  type UiThemeId,
} from '@/utils/themeAppearance'

export function ThemeAppearancePanel() {
  const [theme, setThemeState] = useState<UiThemeId>(getUiTheme)
  const [paperTexture, setPaperTextureState] = useState<PaperTextureId>(getPaperTexture)

  useEffect(() => {
    const sync = () => {
      setThemeState(getUiTheme())
      setPaperTextureState(getPaperTexture())
    }
    window.addEventListener(UI_THEME_CHANGED_EVENT, sync)
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
    return () => {
      window.removeEventListener(UI_THEME_CHANGED_EVENT, sync)
      window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
    }
  }, [])

  const isDefault = theme === DEFAULT_UI_THEME && paperTexture === DEFAULT_PAPER_TEXTURE

  const handleSelectTheme = (id: UiThemeId) => {
    setThemeState(setUiTheme(id))
  }

  const handleSelectTexture = (id: PaperTextureId) => {
    setPaperTextureState(setPaperTexture(id))
  }

  const handleReset = () => {
    setThemeState(setUiTheme(DEFAULT_UI_THEME))
    setPaperTextureState(setPaperTexture(DEFAULT_PAPER_TEXTURE))
  }

  return (
    <div className="ga-paper-card p-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-ink">主题风格</div>
          <div className="text-[11px] text-ink-faint mt-0.5">
            提升纸面与正文对比度，切换后实时生效并持久保存
          </div>
        </div>
        <button
          type="button"
          onClick={handleReset}
          disabled={isDefault}
          className="ga-btn-sm shrink-0"
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          <span>恢复默认</span>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {UI_THEME_PRESETS.map((preset) => {
          const selected = preset.id === theme
          return (
            <button
              key={preset.id}
              type="button"
              data-theme-option={preset.id}
              aria-pressed={selected}
              onClick={() => handleSelectTheme(preset.id)}
              className={clsx(
                'flex flex-col gap-2 rounded-xl border p-3 text-left transition-all',
                selected
                  ? 'border-accent bg-accent-soft/45 ring-1 ring-accent/35 shadow-sm'
                  : 'border-line/75 bg-bg-soft/45 hover:border-accent/55 hover:bg-bg-soft/80',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="inline-flex items-center gap-1" aria-hidden="true">
                  {[
                    preset.swatches.canvas,
                    preset.swatches.card,
                    preset.swatches.userBubble,
                    preset.swatches.accent,
                  ].map((color, index) => (
                    <span
                      key={index}
                      className="h-3.5 w-3.5 rounded-full border border-line/80"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
                <span
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
                    selected ? 'bg-accent text-[var(--c-accent-fg)]' : 'bg-bg-card text-ink-muted border border-line/60',
                  )}
                >
                  {selected && <Check size={10} aria-hidden="true" />}
                  <span>{preset.tag}</span>
                </span>
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-ink">{preset.name}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{preset.description}</p>
              </div>
            </button>
          )
        })}
      </div>

      <hr className="ga-hairline" />

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-semibold text-ink">纸面纹理</div>
          <span className="text-[11px] text-ink-faint">
            {theme === 'dark-forest'
              ? '深色主题下自动关闭浅色纸纹；切回浅色主题后立即生效'
              : '静态无缝平铺纹理，滚动零重绘负担'}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {PAPER_TEXTURE_OPTIONS.map((option) => {
            const selected = option.id === paperTexture
            return (
              <button
                key={option.id}
                type="button"
                data-texture-option={option.id}
                aria-pressed={selected}
                onClick={() => handleSelectTexture(option.id)}
                className={clsx(
                  'flex flex-col gap-1.5 rounded-xl border p-3 text-left transition-all',
                  selected
                    ? 'border-accent bg-accent-soft/45 ring-1 ring-accent/35 shadow-sm'
                    : 'border-line/75 bg-bg-soft/45 hover:border-accent/55 hover:bg-bg-soft/80',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ink">{option.name}</span>
                  <span
                    className={clsx(
                      'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
                      selected ? 'bg-accent text-[var(--c-accent-fg)]' : 'bg-bg-card text-ink-muted border border-line/60',
                    )}
                  >
                    {selected && <Check size={10} aria-hidden="true" />}
                    <span>{option.tag}</span>
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-ink-muted">{option.description}</p>
              </button>
            )
          })}
        </div>
      </div>

      <div className="ga-paper-canvas rounded-xl border border-line/80 p-3.5 space-y-2.5">
        <div className="text-[11px] font-medium text-ink-faint">实时效果预览</div>
        <div className="max-w-lg rounded-lg border px-3 py-2 text-xs leading-relaxed bg-[var(--c-user-bubble-bg)] text-[var(--c-user-bubble-fg)] border-[var(--c-user-bubble-border)]">
          帮我核对主题配色与纸面纹理在高对比文字下的可读性。
        </div>
        <div className="ga-surface-card rounded-lg border border-line bg-bg-card px-3.5 py-2.5 text-xs text-ink space-y-2 shadow-sm">
          <div className="prose-chat leading-6">
            已切换至当前主题预设，正文采用高对比墨色，文件引用如{' '}
            <span className="path-link">styles/index.css</span> 与行内代码{' '}
            <code>themeAppearance</code> 清晰可辨。
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-status-success-line bg-status-success-soft px-2 py-0.5 font-medium text-status-success">
              对比度已优化
            </span>
            <span className="rounded-md border border-status-info-line bg-status-info-soft px-2 py-0.5 font-medium text-status-info">
              设置实时同步
            </span>
            <span className="ga-btn-sm-primary pointer-events-none">主要动作</span>
          </div>
        </div>
      </div>
    </div>
  )
}
