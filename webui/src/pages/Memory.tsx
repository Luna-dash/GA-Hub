// Memory: tabs for global_mem.txt, insight, SOPs (markdown).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { VersionedMemoryEditor } from '@/components/VersionedMemoryEditor'
import { BookOpen, CopyIcon, FileCode2, FileText, Layers, Search, Sparkles, X } from '@/components/ActionIcons'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { PageShell } from '@/components/PageShell'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
import { writeClipboard } from '@/utils/clipboard'
import { errorMessageFromError } from '@/utils/sessionUi'

type Tab = 'sop' | 'skill' | 'insight' | 'global'

export function filterSops<T extends { name: string }>(sops: T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  return needle ? sops.filter((s) => s.name.toLowerCase().startsWith(needle)) : sops
}

export default function Memory() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const [tab, setTab] = usePageState<Tab>('memory.tab', 'sop')
  const [activeSop, setActiveSop] = usePageState<string | null>('memory.sopActive', null)
  const [sopQuery, setSopQuery] = usePageState('memory.sopQuery', '')
  const appliedLocation = useRef<{ key: string } | null>(null)
  const dirtyRef = useRef(false)
  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
  }, [])

  const changeSelection = useCallback((nextTab: Tab, nextSop: string | null = null, onSettled?: (accepted: boolean) => void) => {
    const switchingTab = nextTab !== tab
    const switchingSop = nextSop !== null && nextSop !== activeSop
    const navigation = appliedLocation.current
    const finish = (accepted: boolean) => {
      // An old dialog must not apply its result to a newer navigation.
      if (appliedLocation.current !== navigation) return
      if (accepted) {
        if (switchingTab || switchingSop) dirtyRef.current = false
        if (switchingTab) setTab(nextTab)
        if (switchingSop) setActiveSop(nextSop)
      }
      onSettled?.(accepted)
    }
    if ((switchingTab || switchingSop) && dirtyRef.current) {
      void dialog.confirm(
        '放弃未保存的修改？',
        switchingTab
          ? '当前记忆文档有未保存的编辑，切换标签将丢失这些修改。'
          : '当前 SOP 文档有未保存的编辑，切换文档将丢失这些修改。',
        { confirmText: '放弃修改', tone: 'danger' },
      ).then(finish)
    } else {
      finish(true)
    }
  }, [tab, activeSop, setTab, setActiveSop])

  useEffect(() => () => { appliedLocation.current = null }, [location.key])
  useEffect(() => {
    // Apply each navigation once, even when usePageState setters are recreated.
    if (appliedLocation.current?.key === location.key) return
    appliedLocation.current = { key: location.key }
    const requestedTab = searchParams.get('tab') as Tab | null
    const validTab = requestedTab && ['sop', 'skill', 'insight', 'global'].includes(requestedTab) ? requestedTab : null
    const nextTab = validTab ?? tab
    const nextSop = nextTab === 'sop' ? searchParams.get('sop') || null : null
    if (!validTab && !nextSop) return

    changeSelection(nextTab, nextSop, (accepted) => {
      // Clear consumed (or rejected) SOP links without removing unrelated params.
      if (!nextSop && accepted) return
      if (accepted && nextSop) setSopQuery('')
      const next = new URLSearchParams(searchParams)
      if (nextSop) next.delete('sop')
      next.delete('tab')
      setSearchParams(next, { replace: true })
    })
  }, [location.key, searchParams, tab, changeSelection, setSopQuery, setSearchParams])

  const tabTitle = (t: Tab) => t === 'sop' ? 'SOP 文档' : t === 'skill' ? 'Skill 脚本' : t === 'insight' ? 'L1：洞察记忆 (global_mem_insight.txt)' : 'L2：全局记忆 (global_mem.txt)'
  const tabMeta: Record<Tab, { label: string; desc: string; icon: typeof BookOpen }> = {
    sop: { label: 'SOP 标准流程', desc: '按任务场景沉淀可执行 Markdown 操作规程，供 Agent 检索遵循。', icon: BookOpen },
    skill: { label: 'Skill 工具脚本', desc: '只读检视 memory/skill 下的技能定义与脚本实现。', icon: FileCode2 },
    insight: { label: 'L1 洞察记忆', desc: '高优经验与近期关键洞察（memory/global_mem_insight.txt），对话中自动注入。', icon: Sparkles },
    global: { label: 'L2 全局记忆', desc: '长期事实、偏好与项目约束底座（memory/global_mem.txt）。', icon: Layers },
  }
  const activeMeta = tabMeta[tab]
  const LayerIcon = activeMeta.icon

  return (
    <PageShell
      title="记忆体系"
      actions={
        <div className="ga-segmented text-sm" role="tablist" aria-label="记忆层级">
          {(['sop', 'skill', 'insight', 'global'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              title={tabTitle(t)}
              onClick={() => changeSelection(t)}
              className={`ga-segmented-btn w-16 text-sm ${tab === t ? 'ga-segmented-btn-active' : ''}`}
            >
              {t === 'sop' ? 'SOP' : t === 'skill' ? 'SKILL' : t === 'insight' ? 'L1' : 'L2'}
            </button>
          ))}
        </div>
      }
    >
      <div className="h-full flex flex-col overflow-hidden">
        <div className="shrink-0 border-b border-line/55 bg-bg-card/55 px-5 py-2 flex items-center gap-2 text-xs text-ink-muted">
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bg-card text-accent shadow-xs ring-1 ring-line/45">
            <LayerIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="font-medium text-ink">{activeMeta.label}</span>
          <span className="text-ink-faint">·</span>
          <span className="truncate">{activeMeta.desc}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === 'sop' && <SopList active={activeSop} q={sopQuery} setQ={setSopQuery} selectSop={(name) => changeSelection('sop', name)} onDirtyChange={handleDirtyChange} />}
          {tab === 'skill' && <SkillList />}
          {tab === 'insight' && <Insight onDirtyChange={handleDirtyChange} />}
          {tab === 'global' && <GlobalMem onDirtyChange={handleDirtyChange} />}
        </div>
      </div>
    </PageShell>
  )
}

function memoryWriteError(error: unknown): void {
  if ((error as { status?: number })?.status === 409) {
    toast.error('保存冲突：磁盘版本已变化，草稿仍保留，请重载后合并')
    return
  }
  toast.error('保存失败：' + errorMessageFromError(error))
}

function MemoryLoadingCard({ label }: { label: string }) {
  return (
    <div className="mx-auto w-full max-w-5xl p-5 sm:p-6 h-full">
      <div className="ga-paper-card h-full grid place-items-center text-sm text-ink-faint" role="status">
        正在载入 {label}…
      </div>
    </div>
  )
}

function GlobalMem({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: queryKeys.memory.global, queryFn: api.globalMem })
  if (isLoading || !data) return <MemoryLoadingCard label="global_mem.txt" />
  return (
    <div className="mx-auto w-full max-w-5xl p-5 sm:p-6 h-full min-h-0">
      <VersionedMemoryEditor
        label="memory/global_mem.txt"
        snapshot={data}
        onSave={api.setGlobalMem}
        onDirtyChange={onDirtyChange}
        onReload={async () => {
          const latest = await api.globalMem()
          qc.setQueryData(queryKeys.memory.global, latest)
          return latest
        }}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: queryKeys.memory.global })
          toast.success('已保存 global_mem.txt')
        }}
        onError={memoryWriteError}
      />
    </div>
  )
}

function Insight({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: queryKeys.memory.insight, queryFn: api.insight })
  if (isLoading || !data) return <MemoryLoadingCard label="global_mem_insight.txt" />
  return (
    <div className="mx-auto w-full max-w-5xl p-5 sm:p-6 h-full min-h-0">
      <VersionedMemoryEditor
        label="memory/global_mem_insight.txt"
        snapshot={data}
        onSave={api.setInsight}
        onDirtyChange={onDirtyChange}
        onReload={async () => {
          const latest = await api.insight()
          qc.setQueryData(queryKeys.memory.insight, latest)
          return latest
        }}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: queryKeys.memory.insight })
          toast.success('已保存 insight')
        }}
        onError={memoryWriteError}
      />
    </div>
  )
}

function SopList({ active, q, setQ, selectSop, onDirtyChange }: {
  active: string | null
  q: string
  setQ: (value: string) => void
  selectSop: (name: string) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: queryKeys.memory.sops, queryFn: api.sops })
  const sops = data?.sops ?? []
  const visible = filterSops(sops, q)
  const { data: cur } = useQuery({ queryKey: queryKeys.memory.sop(active), queryFn: () => api.sop(active!), enabled: !!active })

  return (
    <div className="ga-archive-split">
      <div className="ga-archive-rail">
        <div className="px-3.5 py-2.5 bg-bg-soft/45 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink">SOP 列表</span>
          <span className="rounded-full bg-bg-card px-2 py-0.5 text-[11px] tabular-nums text-ink-muted ring-1 ring-line/45">
            {q ? `${visible.length} / ${sops.length}` : sops.length}
          </span>
        </div>
        <div className="px-3 pb-2.5 pt-2 bg-bg-soft/45 border-b border-line/40">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="按前缀过滤 SOP…"
              aria-label="过滤 SOP 文档"
              className="w-full bg-bg-card/85 border border-line/70 rounded-lg pl-8 pr-7 py-1.5 text-sm outline-none focus:border-accent focus:bg-bg-card transition-colors"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                aria-label="清空过滤词"
                className="absolute right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-faint hover:bg-bg-soft hover:text-ink"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-line/30">
          {visible.map((s) => {
            const selected = active === s.name
            return (
              <li key={s.name}>
                <button
                  type="button"
                  onClick={() => selectSop(s.name)}
                  className={`w-full text-left px-3.5 py-2.5 text-sm transition-colors border-l-[3px] ${
                    selected
                      ? 'border-l-accent bg-accent-soft/65 text-accent font-medium'
                      : 'border-l-transparent text-ink hover:bg-bg-soft/70'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{s.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{(s.size / 1024).toFixed(1)} KB</span>
                  </div>
                </button>
              </li>
            )
          })}
          {visible.length === 0 && (
            <li className="p-6 text-center text-ink-faint text-sm">{sops.length === 0 ? '无' : '无匹配 SOP'}</li>
          )}
        </ul>
      </div>

      <div className="ga-archive-body">
        {!active && (
          <div className="ga-paper-card h-full grid place-items-center border-dashed bg-bg-card/45 p-8 text-center">
            <div className="flex flex-col items-center gap-2.5 max-w-xs">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line/80 bg-bg-soft text-accent">
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium text-ink">选择左侧文档以查看或编辑</p>
              <p className="text-xs text-ink-faint">支持版本冲突检测与本地草稿保护。</p>
            </div>
          </div>
        )}
        {active && cur && (
          <VersionedMemoryEditor
            key={active}
            label={`memory/${active}`}
            snapshot={cur}
            onSave={(body) => api.setSop(active, body)}
            onDirtyChange={onDirtyChange}
            onReload={async () => {
              const latest = await api.sop(active)
              qc.setQueryData(queryKeys.memory.sop(active), latest)
              return latest
            }}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: queryKeys.memory.sop(active) })
              toast.success('已保存 ' + active)
            }}
            onError={memoryWriteError}
          />
        )}
      </div>
    </div>
  )
}

function SkillList() {
  const { data } = useQuery({ queryKey: queryKeys.skills.list(), queryFn: () => api.skills() })
  const skills = data?.skills ?? []
  const [active, setActive] = usePageState<string | null>('memory.skillActive', null)
  const { data: cur } = useQuery({ queryKey: queryKeys.skills.detail(active), queryFn: () => api.skill(active!), enabled: !!active })
  const [copied, setCopied] = useState(false)

  const copySkill = async () => {
    if (!cur?.content) return
    await writeClipboard(cur.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="ga-archive-split">
      <div className="ga-archive-rail">
        <div className="px-3.5 py-2.5 border-b border-line/40 bg-bg-soft/45 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink">Skill 脚本</span>
          <span className="rounded-full bg-bg-card px-2 py-0.5 text-[11px] tabular-nums text-ink-muted ring-1 ring-line/45">
            {skills.length}
          </span>
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-line/30">
          {skills.map((s) => {
            const selected = active === s.path
            return (
              <li key={s.path}>
                <button
                  type="button"
                  onClick={() => { setActive(s.path); setCopied(false) }}
                  className={`w-full text-left px-3.5 py-2.5 text-sm transition-colors border-l-[3px] ${
                    selected
                      ? 'border-l-accent bg-accent-soft/65 text-accent font-medium'
                      : 'border-l-transparent text-ink hover:bg-bg-soft/70'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs">{s.path}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{(s.size / 1024).toFixed(1)} KB</span>
                  </div>
                </button>
              </li>
            )
          })}
          {skills.length === 0 && <li className="p-6 text-center text-ink-faint text-sm">无</li>}
        </ul>
      </div>

      <div className="ga-archive-body">
        {!active && (
          <div className="ga-paper-card h-full grid place-items-center border-dashed bg-bg-card/45 p-8 text-center">
            <div className="flex flex-col items-center gap-2.5 max-w-xs">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line/80 bg-bg-soft text-accent">
                <FileCode2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium text-ink">选择左侧脚本以查看内容</p>
              <p className="text-xs text-ink-faint">支持只读源码预览与一键复制。</p>
            </div>
          </div>
        )}
        {active && cur && (
          <div className="ga-paper-card flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-line/70 bg-bg-soft/65 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <FileCode2 className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="truncate text-xs text-ink font-mono">memory/skill/{active}</span>
                <span className="shrink-0 rounded-full border border-line/75 bg-bg-card px-2 py-0.5 text-[10px] text-ink-muted">只读</span>
              </div>
              <button type="button" onClick={() => { void copySkill() }} className="ga-btn-sm shrink-0">
                <CopyIcon copied={copied} size={12} />
                <span>{copied ? '已复制' : '复制内容'}</span>
              </button>
            </div>
            <pre className="flex-1 bg-bg-card/60 p-4 text-xs leading-relaxed text-ink font-mono overflow-auto">
              {cur.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
