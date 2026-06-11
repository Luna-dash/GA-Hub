import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '@/api/client'
import { useAgentStore } from '@/stores/agentStore'
import { useChatStore } from '@/stores/chatStore'

type NavIconName =
  | 'chat'
  | 'feishu'
  | 'conversations'
  | 'memory'
  | 'llms'
  | 'conductor'
  | 'goalHive'
  | 'mykey'
  | 'tasks'
  | 'autonomous'
  | 'settings'

interface NavItem {
  to: string
  label: string
  icon: NavIconName
}

const items: NavItem[] = [
  { to: '/chat', label: '实时聊天', icon: 'chat' },
  { to: '/feishu', label: '飞书助手', icon: 'feishu' },
  { to: '/conversations', label: '对话管理', icon: 'conversations' },
  { to: '/memory', label: '记忆文档', icon: 'memory' },
  { to: '/llms', label: '模型链路', icon: 'llms' },
  { to: '/conductor', label: '协同编排', icon: 'conductor' },
  { to: '/goal-hive', label: '目标蜂巢', icon: 'goalHive' },
  { to: '/mykey', label: '密钥管家', icon: 'mykey' },
  { to: '/tasks', label: '任务队列', icon: 'tasks' },
  { to: '/autonomous', label: '自主进化', icon: 'autonomous' },
]

function NavIcon({ name }: { name: NavIconName }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 2.15,
  }
  const filledDot = { fill: 'currentColor', stroke: 'none' }

  return (
    <svg className="ga-nav-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'chat' && (
        <>
          <path {...common} d="M5 6.2h14v8.7H12l-4.3 3.3v-3.3H5z" />
          <path {...common} d="M8.4 9.5h7.2M8.4 12.2h4.8" />
        </>
      )}
      {name === 'feishu' && (
        <>
          <path {...common} d="M4.4 12.1 19.2 5.2l-4.1 14.1-3.6-5.1z" />
          <path {...common} d="M19.2 5.2 11.5 14.2" />
          <path {...common} d="M4.4 12.1l7.1 2.1" />
        </>
      )}
      {name === 'conversations' && (
        <>
          <path {...common} d="M4.8 6.2h10.8v6.9H9.3l-3.4 2.8v-2.8H4.8z" />
          <path {...common} d="M9 15.2h5.9l3.2 2.6v-2.6h1.1V8.7h-2" />
        </>
      )}
      {name === 'memory' && (
        <>
          <path {...common} d="M6.2 5.2h7.3a2.4 2.4 0 0 1 2.4 2.4v12H8.1a2 2 0 0 1-2-2z" />
          <path {...common} d="M8.9 5.2v14M11.2 8.3h3.1M11.2 11.3h4.7" />
          <path {...common} d="M15.9 7.6h1.7a1.3 1.3 0 0 1 1.3 1.3v10.7h-3" />
        </>
      )}
      {name === 'llms' && (
        <>
          <path {...common} d="M12 4.7 18.5 8v8L12 19.3 5.5 16V8z" />
          <path {...common} d="M12 8.3v7.4M8.7 10.2h6.6M8.7 13.8h6.6" />
          <circle {...filledDot} cx="12" cy="12" r="1.25" />
        </>
      )}
      {name === 'conductor' && (
        <>
          <path {...common} d="M6 6.1h4.2v4.2H6zM13.8 6.1H18v4.2h-4.2zM9.9 15h4.2v4.2H9.9z" />
          <path {...common} d="M10.2 8.2h3.6M12 10.3V15" />
        </>
      )}
      {name === 'goalHive' && (
        <>
          <path {...common} d="M12 3.9 16.1 6.3v4.8L12 13.5 7.9 11.1V6.3z" />
          <path {...common} d="M7.8 12.9 11.9 15.3v4.2l-4.1-2.3-4-2.4v-4.2z" />
          <path {...common} d="M16.2 12.9v4.3l-4.1 2.3v-4.2z" />
        </>
      )}
      {name === 'mykey' && (
        <>
          <circle {...common} cx="8.5" cy="10" r="3.5" />
          <path {...common} d="M11 12.5 18.6 20M15 16.4l2.1-2.1M17.1 18.5l1.5-1.5" />
          <circle {...filledDot} cx="8.5" cy="10" r="0.85" />
        </>
      )}
      {name === 'tasks' && (
        <>
          <path {...common} d="M6.4 5.6h11.2v13.2H6.4z" />
          <path {...common} d="M8.8 9.2l1.2 1.2 2.2-2.4M13.8 9.8h2.2M8.8 14.5l1.2 1.2 2.2-2.4M13.8 15.1h2.2" />
        </>
      )}
      {name === 'autonomous' && (
        <>
          <path {...common} d="M18.5 11.2a6.5 6.5 0 0 0-11-4.1L6 8.5M5.5 12.8a6.5 6.5 0 0 0 11 4.1l1.5-1.4" />
          <path {...common} d="M6 4.8v3.7h3.7M18 19.2v-3.7h-3.7" />
          <circle {...common} cx="12" cy="12" r="2.5" />
          <circle {...filledDot} cx="12" cy="12" r="0.8" />
        </>
      )}
      {name === 'settings' && (
        <>
          <path {...common} d="M12 5.2v2M12 16.8v2M5.2 12h2M16.8 12h2M7.2 7.2l1.4 1.4M15.4 15.4l1.4 1.4M16.8 7.2l-1.4 1.4M8.6 15.4l-1.4 1.4" />
          <circle {...common} cx="12" cy="12" r="4.1" />
          <circle {...filledDot} cx="12" cy="12" r="1.1" />
        </>
      )}
    </svg>
  )
}
export function SidebarNav() {
  const qc = useQueryClient()
  const status = useAgentStore((s) => s.status)
  const streaming = useChatStore((s) => s.streaming)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState('')
  const [mixinMenuOpen, setMixinMenuOpen] = useState(false)
  const [singleMenuOpen, setSingleMenuOpen] = useState(false)
  const { data: llmsData } = useQuery({
    queryKey: ['llms'],
    queryFn: api.llms,
    refetchInterval: 8000,
  })
  const llms = llmsData?.llms ?? []
  const currentLlm = llms.find((l) => l.current)
  const mixinLlms = llms.filter((l) => l.kind === 'mixin')
  const singleLlms = llms.filter((l) => l.kind !== 'mixin')
  const truncateLlmLabel = (text: string, maxChars = 28) => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized
  }
  const formatMixinLabel = (l: (typeof llms)[number], displayNo: number) => {
    const raw = l.name || l.model || ''
    const cleaned = raw
      .replace(/^\s*(?:mixin\s*session|mixinsession|session)(?:\s*#?\s*\d+)?\s*[:：·\-—|/]?\s*/i, '')
      .trim()
    const parts = cleaned.split('|').map((p) => p.trim()).filter(Boolean)
    const summary = parts.length > 1 ? `${truncateLlmLabel(parts[0], 24)} +${parts.length - 1}` : truncateLlmLabel(cleaned || l.model || '未命名')
    return `${displayNo}. ${summary}`
  }
  const formatSingleLabel = (l: (typeof llms)[number], displayNo: number) => {
    const alias = (l.name || '').includes('/') ? l.name.split('/').slice(1).join('/') : l.name
    const label = truncateLlmLabel(alias || l.model || l.name || '未命名')
    return `${displayNo}. ${label}`
  }
  const mixinPlaceholder = mixinLlms.length ? '选择 Mixin 会话…' : '暂无 Mixin 会话'
  const singlePlaceholder = singleLlms.length ? '选择单模型…' : '暂无单模型'
  const currentMixinDisplayNo = currentLlm?.kind === 'mixin'
    ? mixinLlms.findIndex((l) => l.index === currentLlm?.index) + 1
    : 0
  const selectedMixinLabel = currentLlm && currentLlm.kind === 'mixin' && currentMixinDisplayNo > 0
    ? formatMixinLabel(currentLlm, currentMixinDisplayNo)
    : mixinPlaceholder
  const currentSingleDisplayNo = currentLlm?.kind !== 'mixin'
    ? singleLlms.findIndex((l) => l.index === currentLlm?.index) + 1
    : 0
  const selectedSingleLabel = currentLlm && currentLlm.kind !== 'mixin' && currentSingleDisplayNo > 0
    ? formatSingleLabel(currentLlm, currentSingleDisplayNo)
    : singlePlaceholder
  const agentRunning = status?.is_running ?? false
  const llmDisabled = streaming || agentRunning || switching || llms.length === 0
  const singleMenuDisabled = llmDisabled || singleLlms.length === 0
  const llmDisabledTitle = streaming || agentRunning
    ? '当前回复进行中，请先停止或等待完成后再切换 LLM'
    : switching
      ? '正在切换 LLM…'
      : llms.length === 0
        ? '尚未加载到 LLM 列表'
        : '全局切换 LLM'
  const openCommandPalette = () => window.dispatchEvent(new Event('gahub:command-palette'))
  const switchLlm = async (idx: number) => {
    if (idx === currentLlm?.index || llmDisabled) return
    setSwitchError('')
    setSwitching(true)
    try {
      await api.switchLLM(idx)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['llms'] }),
        qc.invalidateQueries({ queryKey: ['status'] }),
      ])
    } catch (e: any) {
      setSwitchError(e?.body?.detail || e?.message || String(e))
    } finally {
      setSwitching(false)
    }
  }
  const pickSingleLlm = (idx: number) => {
    setSingleMenuOpen(false)
    void switchLlm(idx)
  }
  const pickMixinLlm = (idx: number) => {
    setMixinMenuOpen(false)
    void switchLlm(idx)
  }
  return (
    <aside className="ga-sidebar w-56 shrink-0 flex flex-col shadow-[6px_0_14px_rgba(21,27,18,0.18)]">
      <div className="ga-sidebar-brand-row border-b border-white/10 flex items-center">
        <div className="ga-brand-mark min-w-0" aria-label="GA Hub">
          <div className="ga-brand-core">
            <div className="ga-brand-orb" aria-hidden="true">
              <span className="ga-brand-ga">GA</span>
            </div>
            <span className="ga-brand-hub">HUB</span>
          </div>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              clsx('ga-brand-settings', isActive && 'active')
            }
            aria-label="系统设置"
            title="系统设置"
          >
            <NavIcon name="settings" />
          </NavLink>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto py-2 ga-sidebar-nav">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              clsx('ga-sidebar-item', isActive && 'active')
            }
          >
            <span className="ga-nav-icon" aria-hidden="true"><NavIcon name={it.icon} /></span>
            <span className="ga-nav-label">{it.label}</span>
            <span className="ga-nav-chev" aria-hidden="true">›</span>
          </NavLink>
        ))}
      </nav>

      <div className="px-3 pb-3 pt-2 space-y-2">
        <div className="ga-sidebar-llm-card" title={llmDisabledTitle}>
          <div className="ga-sidebar-llm-field">
            <div className="ga-sidebar-llm-field-head">
              <span>Mixin 会话</span>
              <span>{mixinLlms.length} 个</span>
            </div>
            <div className="ga-sidebar-llm-combobox">
              <button
                type="button"
                className="ga-sidebar-llm-select ga-sidebar-llm-trigger"
                disabled={llmDisabled || mixinLlms.length === 0}
                aria-label="Mixin Session 选择"
                aria-haspopup="listbox"
                aria-expanded={mixinMenuOpen}
                onClick={() => !(llmDisabled || mixinLlms.length === 0) && setMixinMenuOpen((open) => !open)}
              >
                <span>{selectedMixinLabel}</span>
              </button>
              <span className="ga-sidebar-llm-arrow" aria-hidden="true">▴</span>
              {mixinMenuOpen && !(llmDisabled || mixinLlms.length === 0) && (
                <>
                  <div className="ga-sidebar-llm-backdrop" onClick={() => setMixinMenuOpen(false)} />
                  <div className="ga-sidebar-llm-menu" role="listbox" aria-label="Mixin Session 选择列表">
                    {mixinLlms.map((l, i) => (
                      <button
                        key={l.index}
                        type="button"
                        role="option"
                        aria-selected={l.index === currentLlm?.index}
                        className={clsx('ga-sidebar-llm-option', l.index === currentLlm?.index && 'active')}
                        onClick={() => pickMixinLlm(l.index)}
                        title={l.name || l.model || '未命名'}
                      >
                        <span>{formatMixinLabel(l, i + 1)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="ga-sidebar-llm-field">
            <div className="ga-sidebar-llm-field-head">
              <span>单模型</span>
              <span>{singleLlms.length} 个</span>
            </div>
            <div className="ga-sidebar-llm-combobox">
              <button
                type="button"
                className="ga-sidebar-llm-select ga-sidebar-llm-trigger"
                disabled={singleMenuDisabled}
                aria-label="单个 API 选择"
                aria-haspopup="listbox"
                aria-expanded={singleMenuOpen}
                onClick={() => !singleMenuDisabled && setSingleMenuOpen((open) => !open)}
              >
                <span>{selectedSingleLabel}</span>
              </button>
              <span className="ga-sidebar-llm-arrow" aria-hidden="true">▴</span>
              {singleMenuOpen && !singleMenuDisabled && (
                <>
                  <div className="ga-sidebar-llm-backdrop" onClick={() => setSingleMenuOpen(false)} />
                  <div className="ga-sidebar-llm-menu" role="listbox" aria-label="单个 API 选择列表">
                    {singleLlms.map((l, i) => (
                      <button
                        key={l.index}
                        type="button"
                        role="option"
                        aria-selected={l.index === currentLlm?.index}
                        className={clsx('ga-sidebar-llm-option', l.index === currentLlm?.index && 'active')}
                        onClick={() => pickSingleLlm(l.index)}
                        title={l.name || l.model || '未命名'}
                      >
                        <span>{formatSingleLabel(l, i + 1)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          {switchError && <div className="mt-1 text-[11px] text-[#FFB59D] line-clamp-2" title={switchError}>{switchError}</div>}
        </div>
        <button
          type="button"
          onClick={openCommandPalette}
          className="w-full rounded-xl border border-white/10 bg-white/6 px-3 py-2 text-left text-xs text-[#EFE5CA] hover:bg-white/10 hover:border-white/20 transition flex items-center justify-between gap-2"
        >
          <span>命令面板</span>
          <kbd className="px-1.5 py-0.5 rounded-md border border-white/12 bg-black/16 font-mono text-[11px] text-[#EFE5CA]/80">Ctrl K</kbd>
        </button>
      </div>
    </aside>
  )
}
