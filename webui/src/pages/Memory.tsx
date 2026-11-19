// Memory: tabs for global_mem.txt, insight, SOPs (markdown).
import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { VersionedMemoryEditor } from '@/components/VersionedMemoryEditor'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { PageShell } from '@/components/PageShell'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
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

  return (
    <PageShell
      title="记忆体系"
      actions={
        <div className="flex gap-1 text-sm">
          {(['sop', 'skill', 'insight', 'global'] as Tab[]).map((t) => (
            <button
              key={t}
              title={tabTitle(t)}
              onClick={() => changeSelection(t)}
              className={`w-16 px-3 py-1.5 rounded-lg ${tab === t ? 'bg-accent text-white' : 'border border-line text-ink hover:bg-ink/5'}`}
            >
              {t === 'sop' ? 'SOP' : t === 'skill' ? 'SKILL' : t === 'insight' ? 'L1' : 'L2'}
            </button>
          ))}
        </div>
      }
    >
      <div className="h-full overflow-hidden">
        {tab === 'sop' && <SopList active={activeSop} q={sopQuery} setQ={setSopQuery} selectSop={(name) => changeSelection('sop', name)} onDirtyChange={handleDirtyChange} />}
        {tab === 'skill' && <SkillList />}
        {tab === 'insight' && <Insight onDirtyChange={handleDirtyChange} />}
        {tab === 'global' && <GlobalMem onDirtyChange={handleDirtyChange} />}
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

function GlobalMem({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: queryKeys.memory.global, queryFn: api.globalMem })
  if (isLoading || !data) return <div className="text-ink-faint text-sm">载入中…</div>
  return (
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
  )
}

function Insight({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: queryKeys.memory.insight, queryFn: api.insight })
  if (isLoading || !data) return <div className="text-ink-faint text-sm">载入中…</div>
  return (
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
    <div className="h-full grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] gap-4 p-6">
      <div className="rounded-lg border border-line bg-bg-card overflow-hidden flex flex-col h-full">
        <div className="px-3 py-2 border-b border-line">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="键入首几个字母过滤…"
            className="w-full bg-bg-card border border-line rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          />
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto">
          {visible.map((s) => (
            <li key={s.name}>
              <button
                onClick={() => selectSop(s.name)}
                className={`w-full text-left px-3 py-2 text-sm border-b border-line/50 ${active === s.name ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-ink/5'}`}
              >
                <div className="truncate">{s.name}</div>
                <div className="text-[11px] text-ink-faint">{(s.size / 1024).toFixed(1)} KB</div>
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="p-3 text-ink-faint text-sm">{sops.length === 0 ? '无' : '无匹配 SOP'}</li>
          )}
        </ul>
      </div>

      <div className="h-full min-h-0">
        {!active && <div className="text-ink-faint text-sm">选择左侧文档</div>}
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

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] gap-4 p-6">
      <div className="rounded-lg border border-line bg-bg-card overflow-hidden flex flex-col h-full">
        <div className="px-3 py-2 border-b border-line text-xs text-ink-muted">Skill 脚本</div>
        <ul className="flex-1 min-h-0 overflow-y-auto">
          {skills.map((s) => (
            <li key={s.path}>
              <button
                onClick={() => setActive(s.path)}
                className={`w-full text-left px-3 py-2 text-sm border-b border-line/50 ${active === s.path ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-ink/5'}`}
              >
                <div className="truncate">{s.path}</div>
                <div className="text-[11px] text-ink-faint">{(s.size / 1024).toFixed(1)} KB</div>
              </button>
            </li>
          ))}
          {skills.length === 0 && <li className="p-3 text-ink-faint text-sm">无</li>}
        </ul>
      </div>

      <div className="h-full flex flex-col">
        {!active && <div className="text-ink-faint text-sm">选择左侧脚本</div>}
        {active && cur && (
          <div className="flex flex-col h-full space-y-2">
            <div className="text-xs text-ink-faint font-mono">memory/skill/{active} (只读)</div>
            <pre className="flex-1 rounded-lg border border-line bg-bg-card p-4 text-sm text-ink font-mono overflow-auto">
              {cur.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
