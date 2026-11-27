// Setup / Settings — pick or change the GenericAgent project directory.
//
// In setup mode (backend has no GA_ROOT), the SPA forces this page.
// In normal mode, it's reachable at /settings via the sidebar.

import { useEffect, useRef, useState } from 'react'
import { ALargeSmall, Bell, Download, Globe, HardDrive, KeyRound, MessagesSquare, PanelLeft, Settings2, Type } from 'lucide-react'
import { ArrowDown, ArrowUp, BellOff, Eye, EyeOff, FolderOpen, RefreshIcon, RotateCcw, Save, SendHorizontal } from '@/components/ActionIcons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { NovaSettingsPanel } from '@/components/NovaSettingsPanel'
import { StorageSettingsPanel } from '@/components/StorageSettingsPanel'
import { UpdateSettingsPanel } from '@/components/UpdateSettingsPanel'
import { FontAppearancePanel } from '@/components/FontAppearancePanel'
import { ThemeAppearancePanel } from '@/components/ThemeAppearancePanel'
import type { ChatRetryConfig } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { notify, useNotifyStore } from '@/utils/notify'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import {
  CHAT_FONT_SCALE_DEFAULT, CHAT_FONT_SCALE_MAX, CHAT_FONT_SCALE_MIN, CHAT_FONT_SCALE_STEP,
  chatFontPercent, getChatFontScale, setChatFontScale,
} from '@/utils/chatAppearance'
import {
  RAIL_TITLE_SCALE_DEFAULT, RAIL_TITLE_SCALE_MAX, RAIL_TITLE_SCALE_MIN, RAIL_TITLE_SCALE_STEP,
  railTitlePercent, getRailTitleScale, setRailTitleScale,
} from '@/utils/railAppearance'
import {
  defaultNavPreferences,
  NAV_ITEMS,
  type NavPreference,
} from '@/config/navigation'
import { getNavPreferences, setNavPreferences } from '@/stores/navPreferenceStore'
import { UI_SETTINGS_HYDRATED_EVENT } from '@/stores/uiSettingsStore'
import { isTauriDesktop, restartDesktopBackend, selectDirectory } from '@/utils/desktop'
import { waitForDesktopRestart } from '@/utils/backendRestart'
import { getMyKeyShowUpload, setMyKeyShowUpload } from '@/utils/mykeySyncUi'
import { errorMessageFromError } from '@/utils/sessionUi'
import { queryKeys } from '@/queries/queryKeys'
const SETTINGS_TABS = [
  { id: 'general', label: '目录与环境', description: 'GenericAgent 项目目录与 Python 执行环境', icon: Settings2 },
  { id: 'display', label: '外观与显示', description: '切换主题风格、纸面纹理及会话与栏目标题字号缩放', icon: ALargeSmall },
  { id: 'fonts', label: '字体方案', description: '管理字体包、本地字体导入与加粗表现', icon: Type },
  { id: 'navigation', label: '侧栏导航', description: '勾选要显示的页面入口并调整排序', icon: PanelLeft },
  { id: 'chat', label: '自动重试', description: '配置实时会话与定时任务的网络异常重试策略', icon: MessagesSquare },
  { id: 'remote', label: '远程连接', description: '关联 Nova 账号与查看本机设备码', icon: Globe },
  { id: 'updates', label: '程序更新', description: '检查版本、校验安装包并安全切换升级', icon: Download },
  { id: 'storage', label: '存储与缓存', description: '查看本机缓存占用并按需手动清理临时文件', icon: HardDrive },
  { id: 'sync', label: '密钥同步', description: '控制 LLM 管理页中上传 mykey 的显示开关', icon: KeyRound },
  { id: 'notifications', label: '桌面通知', description: '管理后台完成或需要互动时的桌面消息提醒', icon: Bell },
] as const

type SettingsTab = typeof SETTINGS_TABS[number]['id']

export default function Settings({ initialMode = 'settings' }: { initialMode?: 'settings' | 'setup' }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const qc = useQueryClient()
  const { data: setup } = useQuery({ queryKey: queryKeys.setup, queryFn: api.setupStatus })
  const [input, setInput] = useState('')
  const [pythonInput, setPythonInput] = useState('')
  const [validating, setValidating] = useState(false)
  const [picking, setPicking] = useState(false)
  const [validResult, setValidResult] = useState<{ valid: boolean; resolved: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const gaRootDirtyRef = useRef(false)
  const pythonDirtyRef = useRef(false)
  const lastSyncedSetupRef = useRef<{ gaRoot: string; pythonPath: string } | null>(null)

  useEffect(() => {
    if (!setup) return
    const nextGaRoot = setup.ga_root || ''
    const nextPythonPath = setup.python_path || ''
    const last = lastSyncedSetupRef.current
    if (!last || (!gaRootDirtyRef.current && last.gaRoot !== nextGaRoot)) {
      setInput(nextGaRoot)
    }
    if (!last || (!pythonDirtyRef.current && last.pythonPath !== nextPythonPath)) {
      setPythonInput(nextPythonPath)
    }
    lastSyncedSetupRef.current = { gaRoot: nextGaRoot, pythonPath: nextPythonPath }
  }, [setup])

  const validate = async (path: string) => {
    if (!path.trim()) { setValidResult(null); return }
    setValidating(true)
    try {
      const r = await api.setupValidate(path)
      setValidResult(r)
    } catch (e: any) {
      setValidResult({ valid: false, resolved: path })
      toast.error('路径校验请求失败：' + errorMessageFromError(e))
    } finally {
      setValidating(false)
    }
  }

  const pickGaRoot = async () => {
    setPicking(true)
    try {
      const result = await selectDirectory()
      if (result.cancelled) return
      if (!result.ok || !result.path) {
        toast.error(`目录选择失败：${result.error || '未知错误'}`)
        return
      }
      gaRootDirtyRef.current = true
      setInput(result.path)
      setValidResult(null)
      await validate(result.path)
    } catch (e: any) {
      toast.error(`目录选择失败：${errorMessageFromError(e)}`)
    } finally {
      setPicking(false)
    }
  }

  const save = async () => {
    setSaveMsg(null); setSaveErr(null); setSaving(true)
    try {
      const r = await api.setupSave(input.trim(), pythonInput.trim())
      gaRootDirtyRef.current = false
      pythonDirtyRef.current = false
      lastSyncedSetupRef.current = { gaRoot: r.ga_root || input.trim(), pythonPath: pythonInput.trim() }
      setSaveMsg(isTauriDesktop()
        ? `✓ 已保存：${r.ga_root}\n点击「重启后端」立即生效。`
        : `✓ 已保存：${r.ga_root}\n请重启后端以加载新配置（浏览器模式：Ctrl+C 后重新执行 python -m server.run）。`)
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.setup }),
        qc.invalidateQueries({ queryKey: queryKeys.servicePanel }),
      ])
    } catch (e: any) {
      setSaveErr(errorMessageFromError(e, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  // Desktop only: the Tauri shell owns the sidecar, so it can stop and
  // respawn it in place (same port/token), then we reload into normal mode.
  const restartBackend = async () => {
    setRestarting(true); setSaveErr(null)
    try {
      await restartDesktopBackend()
      await waitForDesktopRestart()
      window.location.reload()
    } catch (e: any) {
      toast.error('重启后端失败：' + errorMessageFromError(e))
      setRestarting(false)
    }
  }

  const inSetup = initialMode === 'setup' || !setup?.configured

  return (
    <PageShell
      title={inSetup ? '初始设置' : '设置'}
    >
      <div className={inSetup ? 'ga-page-dossier-narrow' : 'ga-page-dossier grid grid-cols-[5.5rem_minmax(0,1fr)] sm:grid-cols-[12rem_minmax(0,1fr)] items-start gap-5 sm:gap-6'}>
        {!inSetup && (
          <div role="tablist" aria-label="设置分类" aria-orientation="vertical" className="ga-paper-card sticky top-5 flex flex-col gap-0.5 p-1.5">
            {SETTINGS_TABS.map(({ id, label, icon: Icon }, index) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-controls={`settings-panel-${id}`}
                aria-selected={activeTab === id}
                tabIndex={activeTab === id ? 0 : -1}
                onClick={() => setActiveTab(id)}
                onKeyDown={(event) => {
                  const next = event.key === 'ArrowDown' ? (index + 1) % SETTINGS_TABS.length
                    : event.key === 'ArrowUp' ? (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? SETTINGS_TABS.length - 1 : null
                  if (next === null) return
                  event.preventDefault()
                  setActiveTab(SETTINGS_TABS[next].id)
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
                }}
                className={`flex flex-col sm:flex-row items-center gap-1 sm:gap-2.5 rounded-lg px-2 sm:px-3 py-2 text-xs sm:text-sm text-center sm:text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${activeTab === id ? 'bg-accent/15 text-accent font-medium' : 'text-ink-muted hover:bg-bg-soft hover:text-ink'}`}
              >
                <Icon size={16} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="min-w-0 space-y-4">
          {!inSetup && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h2 className="text-base font-semibold text-ink">{SETTINGS_TABS.find(tab => tab.id === activeTab)!.label}</h2>
                <p className="text-xs text-ink-faint">{SETTINGS_TABS.find(tab => tab.id === activeTab)!.description}</p>
              </div>
              <hr className="ga-hairline" />
            </div>
          )}
          <div id="settings-panel-general" role={inSetup ? undefined : 'tabpanel'} aria-labelledby={inSetup ? undefined : 'settings-tab-general'} tabIndex={inSetup ? undefined : 0} hidden={!inSetup && activeTab !== 'general'} className="space-y-4">
            {/* current summary */}
            <div className="ga-paper-card px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-3 divide-y md:divide-y-0 md:divide-x divide-line/35">
              <div className="min-w-0">
                <div className="text-[11px] text-ink-faint">GenericAgent 路径</div>
                <div className="mt-0.5 font-mono text-xs break-all">
                  {setup?.ga_root
                    ? <span className="text-status-success font-medium">{setup.ga_root}</span>
                    : <span className="text-status-danger font-medium">尚未配置</span>}
                </div>
              </div>
              <div className="min-w-0 pt-2 md:pt-0 md:pl-3">
                <div className="text-[11px] text-ink-faint">Admin 数据目录</div>
                <div className="mt-0.5 font-mono text-xs text-ink break-all">{setup?.admin_data || '—'}</div>
              </div>
              <div className="min-w-0 pt-2 md:pt-0 md:pl-3">
                <div className="text-[11px] text-ink-faint">当前 Python {setup?.resolved_python_source ? `(${setup.resolved_python_source})` : ''}</div>
                <div className="mt-0.5 font-mono text-xs text-ink break-all">
                  {setup?.resolved_python || '回退当前进程'}
                </div>
              </div>
            </div>

            {/* picker */}
            <div className="ga-paper-card p-4 space-y-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-semibold text-ink">选择目录与执行环境</div>
                <span className="text-[11px] text-ink-faint">需含 <code className="font-mono">agentmain.py</code> 与 <code className="font-mono">memory/</code></span>
              </div>

              <div>
                <div className="text-xs text-ink-faint mb-1">GenericAgent 项目目录</div>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={input}
                    onChange={(e) => { gaRootDirtyRef.current = true; setInput(e.target.value); setValidResult(null) }}
                    onBlur={(e) => validate(e.target.value)}
                    placeholder="/path/to/GenericAgent"
                    className="min-w-0 w-full sm:w-auto flex-auto bg-bg-soft border border-line rounded-lg px-3 py-1.5 text-sm font-mono outline-none focus:border-accent"
                  />
                  {isTauriDesktop() && (
                    <button
                      type="button"
                      onClick={pickGaRoot}
                      disabled={picking || validating}
                      className="ga-btn"
                    ><FolderOpen className="h-3.5 w-3.5" aria-hidden="true" /><span>{picking ? '选择中…' : '浏览…'}</span></button>
                  )}
                  <button
                    type="button"
                    onClick={() => validate(input)}
                    disabled={validating}
                    className="ga-btn"
                  ><RefreshIcon spinning={validating} size={13} /><span>{validating ? '检测中…' : '检测'}</span></button>
                </div>
                {validResult && (
                  <div className={`mt-1.5 text-xs ${validResult.valid ? 'text-status-success' : 'text-status-danger'}`}>
                    {validResult.valid
                      ? `✓ 有效目录（${validResult.resolved}）`
                      : '✗ 缺少 agentmain.py 或 memory/'}
                  </div>
                )}
              </div>

              <div>
                <div className="text-xs text-ink-faint mb-1">Python 解释器（可选，留空自动检测）</div>
                <input
                  value={pythonInput}
                  onChange={(e) => { pythonDirtyRef.current = true; setPythonInput(e.target.value) }}
                  placeholder="/path/to/python"
                  className="w-full bg-bg-soft border border-line rounded-lg px-3 py-1.5 text-sm font-mono outline-none focus:border-accent"
                />
              </div>

              <div className="pt-1 flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !input.trim()}
                  className="ga-btn-primary px-4"
                ><Save className="h-3.5 w-3.5" aria-hidden="true" /><span>{saving ? '保存中…' : '保存配置'}</span></button>
                {isTauriDesktop() && saveMsg && !saving && (
                  <button
                    type="button"
                    onClick={restartBackend}
                    disabled={restarting}
                    className="ga-btn border-accent/70 text-accent hover:bg-accent/10 hover:text-accent"
                  ><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /><span>{restarting ? '重启中…' : '重启后端'}</span></button>
                )}
                {saveMsg && <span className="text-xs text-status-success whitespace-pre-line">{saveMsg}</span>}
                {saveErr && <span className="text-xs text-status-danger whitespace-pre-line">{saveErr}</span>}
              </div>
            </div>

            {inSetup && setup?.configured && (
              <div className="rounded-xl border border-status-warning-line bg-status-warning-soft px-4 py-3 text-xs text-status-warning">
                {isTauriDesktop()
                  ? '✓ 配置已保存，点击上方「重启后端」即可进入。'
                  : '✓ 配置已保存，请重启后端以进入正常模式。'}
              </div>
            )}
          </div>
          {!inSetup && <>
            <div id="settings-panel-display" role="tabpanel" aria-labelledby="settings-tab-display" tabIndex={0} hidden={activeTab !== 'display'} className="space-y-4">
              <ThemeAppearancePanel />
              <ChatAppearancePanel />
            </div>
            <div id="settings-panel-fonts" role="tabpanel" aria-labelledby="settings-tab-fonts" tabIndex={0} hidden={activeTab !== 'fonts'}>
              <FontAppearancePanel />
            </div>
            <div id="settings-panel-navigation" role="tabpanel" aria-labelledby="settings-tab-navigation" tabIndex={0} hidden={activeTab !== 'navigation'}>
              <NavManagementPanel />
            </div>
            <div id="settings-panel-chat" role="tabpanel" aria-labelledby="settings-tab-chat" tabIndex={0} hidden={activeTab !== 'chat'}>
              <ChatRetryPanel />
            </div>
            <div id="settings-panel-remote" role="tabpanel" aria-labelledby="settings-tab-remote" tabIndex={0} hidden={activeTab !== 'remote'}>
              <NovaSettingsPanel active={!inSetup && activeTab === 'remote'} />
            </div>
            <div id="settings-panel-updates" role="tabpanel" aria-labelledby="settings-tab-updates" tabIndex={0} hidden={activeTab !== 'updates'}>
              <UpdateSettingsPanel active={!inSetup && activeTab === 'updates'} />
            </div>
            <div id="settings-panel-storage" role="tabpanel" aria-labelledby="settings-tab-storage" tabIndex={0} hidden={activeTab !== 'storage'}>
              <StorageSettingsPanel active={!inSetup && activeTab === 'storage'} />
            </div>
            <div id="settings-panel-sync" role="tabpanel" aria-labelledby="settings-tab-sync" tabIndex={0} hidden={activeTab !== 'sync'}>
              <MyKeySyncPanel />
            </div>
            <div id="settings-panel-notifications" role="tabpanel" aria-labelledby="settings-tab-notifications" tabIndex={0} hidden={activeTab !== 'notifications'}>
              <NotifyPanel />
            </div>
          </>}
        </div>
      </div>
    </PageShell>
  )
}


function NavManagementPanel() {
  const [preferences, setPreferences] = useState<NavPreference[]>(getNavPreferences)

  const update = (next: NavPreference[]) => {
    const saved = setNavPreferences(next)
    setPreferences(saved)
  }

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= preferences.length) return
    const next = [...preferences]
    ;[next[index], next[target]] = [next[target], next[index]]
    update(next)
  }

  return (
    <div className="ga-paper-card p-4">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div>
          <div className="text-sm font-semibold text-ink">导航栏</div>
          <div className="text-[11px] text-ink-faint">勾选显示与排序（设置入口常驻）</div>
        </div>
        <button
          type="button"
          onClick={() => update(defaultNavPreferences())}
          className="ga-btn-sm shrink-0"
        ><RotateCcw className="h-3 w-3" aria-hidden="true" /><span>恢复默认</span></button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {preferences.map((preference, index) => {
          const item = NAV_ITEMS.find((candidate) => candidate.id === preference.id)
          if (!item) return null
          return (
            <div key={item.id} className="ga-paper-subcard flex items-center gap-2 px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={preference.visible}
                onChange={(event) => update(preferences.map((entry, i) => i === index ? { ...entry, visible: event.target.checked } : entry))}
                aria-label={`显示${item.label}`}
              />
              <span className="flex-1 text-xs font-medium text-ink truncate">{item.label}</span>
              <button type="button" disabled={index === 0} onClick={() => move(index, -1)} className="ga-btn-icon-sm" aria-label={`上移${item.label}`} title={`上移${item.label}`}><ArrowUp className="h-3 w-3" aria-hidden="true" /></button>
              <button type="button" disabled={index === preferences.length - 1} onClick={() => move(index, 1)} className="ga-btn-icon-sm" aria-label={`下移${item.label}`} title={`下移${item.label}`}><ArrowDown className="h-3 w-3" aria-hidden="true" /></button>
            </div>
          )
        })}
      </div>
    </div>
  )
}


function MyKeySyncPanel() {
  const [showUpload, setShowUpload] = useState(getMyKeyShowUpload)

  useEffect(() => {
    const sync = () => setShowUpload(getMyKeyShowUpload())
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
    return () => window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
  }, [])

  const toggle = async () => {
    if (showUpload) {
      setShowUpload(setMyKeyShowUpload(false))
      return
    }
    // 开启前手动确认：上传会以本机内容覆盖同步服务器版本。
    const ok = await dialog.confirm(
      '显示「上传 mykey」按钮？',
      '上传会用当前本机 mykey.py 加密覆盖同步服务器上的版本，其他设备下载后将获得该版本。'
      + '\n\n确认要在 LLM 管理页显示上传按钮吗？',
      { confirmText: '确认显示' },
    )
    if (!ok) return
    setShowUpload(setMyKeyShowUpload(true))
    toast.success('已显示上传按钮')
  }

  return (
    <div className="ga-paper-card p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-ink">mykey 同步</div>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium border ${showUpload ? 'border-status-warning-line bg-status-warning-soft text-status-warning' : 'border-line/50 bg-bg-soft text-ink-faint'}`}>
            {showUpload ? '已显示上传入口' : '默认仅下载'}
          </span>
        </div>
        <div className="text-xs text-ink-faint mt-1">
          上传会以本机配置覆盖云端并影响其他设备，按需手动开启。
        </div>
      </div>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={showUpload}
        className={showUpload ? 'ga-btn-primary shrink-0' : 'ga-btn shrink-0'}
      >
        {showUpload ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
        <span>{showUpload ? '上传按钮已显示 · 点击隐藏' : '显示上传按钮…'}</span>
      </button>
    </div>
  )
}


function ChatAppearancePanel() {
  const [scale, setScale] = useState(getChatFontScale)
  const [titleScale, setTitleScale] = useState(getRailTitleScale)

  useEffect(() => {
    const sync = () => {
      setScale(getChatFontScale())
      setTitleScale(getRailTitleScale())
    }
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
    return () => window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
  }, [])

  const updateScale = (value: number) => setScale(setChatFontScale(value))
  const updateTitleScale = (value: number) => setTitleScale(setRailTitleScale(value))

  return (
    <div className="ga-paper-card p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-ink">会话显示</div>
        <span className="text-[11px] text-ink-faint">按本机桌面基准百分比调整</span>
      </div>
      <div className="space-y-4">
        <div className="rounded-xl border border-line/70 bg-bg-soft/55 p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span className="text-sm font-medium text-ink">会话字体</span>
            <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:max-w-md sm:flex-1">
              <input
                type="range"
                min={CHAT_FONT_SCALE_MIN}
                max={CHAT_FONT_SCALE_MAX}
                step={CHAT_FONT_SCALE_STEP}
                value={scale}
                onChange={(e) => updateScale(Number(e.target.value))}
                aria-label="会话字体缩放"
                className="w-0 min-w-0 flex-1 accent-accent"
              />
              <output className="w-12 shrink-0 text-right text-sm font-mono font-medium tabular-nums text-accent">{Math.round(scale)}%</output>
            </div>
            <button
              type="button"
              onClick={() => updateScale(CHAT_FONT_SCALE_DEFAULT)}
              disabled={scale === CHAT_FONT_SCALE_DEFAULT}
              className="ga-btn-sm shrink-0"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span>恢复默认</span>
            </button>
          </div>
          <div className="rounded-lg border border-line/65 bg-bg-card px-3 py-2 text-ink truncate" style={{ fontSize: `${chatFontPercent(scale)}%` }}>
            预览：GA 会话输出示例
          </div>
        </div>

        <div className="rounded-xl border border-line/70 bg-bg-soft/55 p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span className="text-sm font-medium text-ink">栏目标题</span>
            <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:max-w-md sm:flex-1">
              <input
                type="range"
                min={RAIL_TITLE_SCALE_MIN}
                max={RAIL_TITLE_SCALE_MAX}
                step={RAIL_TITLE_SCALE_STEP}
                value={titleScale}
                onChange={(e) => updateTitleScale(Number(e.target.value))}
                aria-label="会话管理栏标题字号缩放"
                className="w-0 min-w-0 flex-1 accent-accent"
              />
              <output className="w-12 shrink-0 text-right text-sm font-mono font-medium tabular-nums text-accent">{Math.round(titleScale)}%</output>
            </div>
            <button
              type="button"
              onClick={() => updateTitleScale(RAIL_TITLE_SCALE_DEFAULT)}
              disabled={titleScale === RAIL_TITLE_SCALE_DEFAULT}
              className="ga-btn-sm shrink-0"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span>恢复默认</span>
            </button>
          </div>
          <div className="rounded-lg border border-line/65 bg-bg-card px-3 py-2 font-medium text-ink truncate" style={{ fontSize: `${railTitlePercent(titleScale)}%` }}>
            预览：会话管理栏条目标题
          </div>
        </div>
      </div>
    </div>
  )
}

function ChatRetryPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: queryKeys.agent.chatRetryConfig, queryFn: api.chatRetryConfig })
  const [cfg, setCfg] = useState<ChatRetryConfig>({ enabled: true, max_attempts: 2, scheduled_max_attempts: 6, backoff_base_seconds: 2, backoff_factor: 2, backoff_max_seconds: 60, scheduled_backoff_base_seconds: 5, scheduled_backoff_max_seconds: 600 })
  const retryDirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (data && !retryDirtyRef.current) setCfg(data)
  }, [data])

  const updateCfg = (patch: Partial<ChatRetryConfig>) => {
    retryDirtyRef.current = true
    setCfg((current) => ({ ...current, ...patch }))
  }

  const hasBlankNumber = Object.values(cfg).some(Number.isNaN)

  const save = async () => {
    if (hasBlankNumber) return
    setSaving(true)
    setMsg('')
    try {
      const saved = await api.saveChatRetryConfig({
        enabled: !!cfg.enabled,
        max_attempts: Math.max(0, Math.min(5, Math.floor(Number(cfg.max_attempts) || 0))),
        scheduled_max_attempts: Math.max(0, Math.min(10, Math.floor(Number(cfg.scheduled_max_attempts ?? 6) || 0))),
        backoff_base_seconds: Math.max(0, Math.min(600, Number(cfg.backoff_base_seconds) || 0)),
        backoff_factor: Math.max(1, Math.min(10, Number(cfg.backoff_factor) || 2)),
        backoff_max_seconds: Math.max(0, Math.min(600, Number(cfg.backoff_max_seconds) || 0)),
        scheduled_backoff_base_seconds: Math.max(0, Math.min(600, Number(cfg.scheduled_backoff_base_seconds) || 0)),
        scheduled_backoff_max_seconds: Math.max(0, Math.min(600, cfg.scheduled_backoff_max_seconds ?? 600)),
      })
      setCfg(saved)
      retryDirtyRef.current = false
      await qc.invalidateQueries({ queryKey: queryKeys.agent.chatRetryConfig })
      setMsg('已保存')
    } catch (e: any) {
      setMsg(`保存失败：${errorMessageFromError(e)}`)
    } finally {
      setSaving(false)
      window.setTimeout(() => setMsg(''), 3500)
    }
  }

  return (
    <div className="ga-paper-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/45 bg-bg-soft/45 px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-sm font-semibold text-ink">实时聊天自动重试</div>
          <label className="inline-flex items-center gap-1.5 rounded-full border border-line/80 bg-bg-card px-2.5 py-0.5 text-xs font-medium text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={!!cfg.enabled}
              onChange={(e) => updateCfg({ enabled: e.target.checked })}
              disabled={isLoading || saving}
            />
            <span>{cfg.enabled ? '已开启' : '已关闭'}</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className={`text-xs ${msg.startsWith('保存失败') ? 'text-status-danger' : 'text-status-success'}`}>{msg}</span>}
          <button
            type="button"
            onClick={save}
            disabled={saving || isLoading || hasBlankNumber}
            className="ga-btn-primary"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{saving ? '保存中…' : '保存'}</span>
          </button>
        </div>
      </div>

      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="ga-paper-subcard p-3.5 space-y-2.5">
          <div className="text-xs font-semibold text-ink">实时会话</div>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block text-xs text-ink-faint" title="普通对话的最大自动重试次数">
              <span>最大次数</span>
              <input
                type="number"
                min={0}
                max={5}
                value={Number.isNaN(cfg.max_attempts) ? '' : (cfg.max_attempts)}
                onChange={(e) => updateCfg({ max_attempts: e.currentTarget.valueAsNumber })}
                disabled={isLoading || saving || !cfg.enabled}
                className="mt-1 w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-faint">
              <span>基础间隔（秒）</span>
              <input type="number" min={0} max={600} step="1" value={Number.isNaN(cfg.backoff_base_seconds) ? '' : (cfg.backoff_base_seconds ?? 2)} onChange={(e) => updateCfg({ backoff_base_seconds: e.currentTarget.valueAsNumber })} disabled={isLoading || saving || !cfg.enabled} className="mt-1 w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-faint">
              <span>退避倍率</span>
              <input type="number" min={1} max={10} step="0.5" value={Number.isNaN(cfg.backoff_factor) ? '' : (cfg.backoff_factor ?? 2)} onChange={(e) => updateCfg({ backoff_factor: e.currentTarget.valueAsNumber })} disabled={isLoading || saving || !cfg.enabled} className="mt-1 w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-faint">
              <span>最长等待（秒）</span>
              <input type="number" min={0} max={600} step="1" value={Number.isNaN(cfg.backoff_max_seconds) ? '' : (cfg.backoff_max_seconds ?? 60)} onChange={(e) => updateCfg({ backoff_max_seconds: e.currentTarget.valueAsNumber })} disabled={isLoading || saving || !cfg.enabled} className="mt-1 w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50" />
            </label>
          </div>
        </div>

        <div className="ga-paper-subcard p-3.5 space-y-2.5">
          <div className="text-xs font-semibold text-ink">定时 / 无人值守任务</div>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block text-xs text-ink-faint" title="无人值守任务的最大自动重试次数">
              <span>最大次数</span>
              <input
                type="number"
                min={0}
                max={10}
                value={Number.isNaN(cfg.scheduled_max_attempts) ? '' : (cfg.scheduled_max_attempts ?? 6)}
                onChange={(e) => updateCfg({ scheduled_max_attempts: e.currentTarget.valueAsNumber })}
                disabled={isLoading || saving || !cfg.enabled}
                className="mt-1 w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
              />
            </label>
            <label className="block text-xs text-ink-faint" title="无人值守任务的起始重试间隔">
              <span>基础间隔（秒）</span>
              <input type="number" min={0} max={600} step="1" value={Number.isNaN(cfg.scheduled_backoff_base_seconds) ? '' : (cfg.scheduled_backoff_base_seconds ?? 5)} onChange={(e) => updateCfg({ scheduled_backoff_base_seconds: e.currentTarget.valueAsNumber })} disabled={isLoading || saving || !cfg.enabled} className="mt-1 w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50" />
            </label>
            <label className="block text-xs text-ink-faint col-span-2 sm:col-span-1" title="无人值守任务的单次最长等待，默认 10 分钟">
              <span>最长等待（秒）</span>
              <input type="number" min={0} max={600} step="1" value={Number.isNaN(cfg.scheduled_backoff_max_seconds) ? '' : (cfg.scheduled_backoff_max_seconds ?? 600)} onChange={(e) => updateCfg({ scheduled_backoff_max_seconds: e.currentTarget.valueAsNumber })} disabled={isLoading || saving || !cfg.enabled} className="mt-1 w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50" />
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

function NotifyPanel() {
  const optedIn = useNotifyStore((s) => s.optedIn)
  const backendName = useNotifyStore((s) => s.backendName)
  const setOptIn = useNotifyStore((s) => s.setOptIn)
  const refresh = useNotifyStore((s) => s.refresh)
  const [testing, setTesting] = useState<null | string>(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = () => {
    setOptIn(!optedIn)
  }

  const test = async () => {
    setTesting('发送中…')
    try {
      const shown = await notify('测试提醒', { body: '会话有新结果或需要互动时，将使用此消息窗提醒。', force: true })
      setTesting(shown ? '主题消息窗正常' : '提醒已关闭')
    } catch (e) {
      setTesting(`网络异常：${(e as Error).message}`)
    } finally {
      window.setTimeout(() => setTesting(null), 3500)
    }
  }

  // No platform support — backend reports an unsupported OS. Show a hint
  // and disable the toggle. This shouldn't happen in practice (we cover
  // macOS / Windows / Linux), but be honest if it does.
  const unsupported = backendName.startsWith('unsupported')

  return (
    <div className="ga-paper-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-ink">桌面通知</div>
            {backendName && <span className="rounded-full bg-bg-soft px-2 py-0.5 text-[11px] text-ink-faint ring-1 ring-line/45">{backendName}</span>}
          </div>
          <div className="text-xs text-ink-faint mt-0.5">
            窗口失焦或最小化时以主题消息窗提醒，不展示输出细节。
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={toggle}
            disabled={unsupported}
            aria-pressed={optedIn}
            className={optedIn ? 'ga-btn-primary' : 'ga-btn'}
          >
            {optedIn ? <Bell className="h-3.5 w-3.5" aria-hidden="true" /> : <BellOff className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{optedIn ? '已开启 · 点击关闭' : '开启桌面通知'}</span>
          </button>
          {optedIn && !unsupported && (
            <button type="button" onClick={test} className="ga-btn-sm">
              <SendHorizontal className="h-3 w-3" aria-hidden="true" />
              <span>发一条测试</span>
            </button>
          )}
        </div>
      </div>

      {testing && <div className="text-xs text-ink-muted">{testing}</div>}

      {unsupported && (
        <div className="text-xs text-status-warning">
          当前系统暂不支持（{backendName}）。仅支持 macOS / Windows / Linux。
        </div>
      )}
    </div>
  )
}
