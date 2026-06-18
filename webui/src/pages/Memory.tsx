// Memory: tabs for global_mem.txt, insight, SOPs (markdown).
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { toast } from '@/stores/toastStore'
import { PageShell } from '@/components/PageShell'

type Tab = 'sop' | 'skill' | 'insight' | 'global'

export function Memory() {
  const [tab, setTab] = useState<Tab>('sop')
  return (
    <PageShell
      title="记忆体系"
      description="编辑 GenericAgent 的长期记忆与流程文档（*_sop.md · *.py · insight · global_mem）"
      actions={
        <div className="flex gap-1 text-sm">
          {(['sop', 'skill', 'insight', 'global'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`w-16 px-3 py-1.5 rounded-lg ${tab === t ? 'bg-accent text-white' : 'border border-line text-slate-300 hover:bg-white/5'}`}
            >
              {t === 'sop' ? 'SOP' : t === 'skill' ? 'SKILL' : t === 'insight' ? 'L1' : 'L2'}
            </button>
          ))}
        </div>
      }
    >
      <div className="h-full overflow-hidden">
        {tab === 'sop' && <SopList />}
        {tab === 'skill' && <SkillList />}
        {tab === 'insight' && <Insight />}
        {tab === 'global' && <GlobalMem />}
      </div>
    </PageShell>
  )
}

function GlobalMem() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['mem.global'], queryFn: api.globalMem })
  const [v, setV] = useState('')
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (data) { setV(data.content); setDirty(false) } }, [data])
  if (isLoading) return <div className="text-slate-500 text-sm">载入中…</div>
  return (
    <Editor
      label="memory/global_mem.txt"
      value={v}
      dirty={dirty}
      onChange={(s) => { setV(s); setDirty(true) }}
      onSave={async () => { try { await api.setGlobalMem(v); setDirty(false); qc.invalidateQueries({ queryKey: ['mem.global'] }); toast.success('已保存 global_mem.txt') } catch (e: any) { toast.error('保存失败：' + (e?.message || String(e))) } }}
    />
  )
}

function Insight() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['mem.insight'], queryFn: api.insight })
  const [v, setV] = useState(''); const [dirty, setDirty] = useState(false)
  useEffect(() => { if (data) { setV(data.content); setDirty(false) } }, [data])
  return (
    <Editor
      label="memory/global_mem_insight.txt"
      value={v}
      dirty={dirty}
      onChange={(s) => { setV(s); setDirty(true) }}
      onSave={async () => { try { await api.setInsight(v); setDirty(false); qc.invalidateQueries({ queryKey: ['mem.insight'] }); toast.success('已保存 insight') } catch (e: any) { toast.error('保存失败：' + (e?.message || String(e))) } }}
    />
  )
}

function SopList() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['sops'], queryFn: api.sops })
  const sops = data?.sops ?? []
  const [active, setActive] = useState<string | null>(null)
  const { data: cur } = useQuery({ queryKey: ['sop', active], queryFn: () => api.sop(active!), enabled: !!active })
  const [v, setV] = useState(''); const [dirty, setDirty] = useState(false)
  useEffect(() => { if (cur) { setV(cur.content); setDirty(false) } }, [cur])

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-4 p-6">
      <div className="rounded-lg border border-line bg-bg-card overflow-hidden flex flex-col h-full">
        <div className="px-3 py-2 border-b border-line text-xs text-slate-400">SOP 文档</div>
        <ul className="flex-1 overflow-y-auto">
          {sops.map((s) => (
            <li key={s.name}>
              <button
                onClick={() => setActive(s.name)}
                className={`w-full text-left px-3 py-2 text-sm border-b border-line/50 ${active === s.name ? 'bg-accent-soft text-accent' : 'text-slate-300 hover:bg-white/5'}`}
              >
                <div className="truncate">{s.name}</div>
                <div className="text-[10px] text-slate-500">{(s.size / 1024).toFixed(1)} KB</div>
              </button>
            </li>
          ))}
          {sops.length === 0 && <li className="p-3 text-slate-500 text-sm">无</li>}
        </ul>
      </div>

      <div className="h-full overflow-y-auto">
        {!active && <div className="text-slate-500 text-sm">选择左侧文档</div>}
        {active && (
          <Editor
            label={`memory/${active}`}
            value={v}
            dirty={dirty}
            onChange={(s) => { setV(s); setDirty(true) }}
            onSave={async () => { try { await api.setSop(active, v); setDirty(false); qc.invalidateQueries({ queryKey: ['sop', active] }); toast.success('已保存 ' + active) } catch (e: any) { toast.error('保存失败：' + (e?.message || String(e))) } }}
          />
        )}
      </div>
    </div>
  )
}

function SkillList() {
  const { data } = useQuery({ queryKey: ['skills'], queryFn: () => api.skills() })
  const skills = data?.skills ?? []
  const [active, setActive] = useState<string | null>(null)
  const { data: cur } = useQuery({ queryKey: ['skill', active], queryFn: () => api.skill(active!), enabled: !!active })

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-4 p-6">
      <div className="rounded-lg border border-line bg-bg-card overflow-hidden flex flex-col h-full">
        <div className="px-3 py-2 border-b border-line text-xs text-slate-400">Skill 脚本</div>
        <ul className="flex-1 overflow-y-auto">
          {skills.map((s) => (
            <li key={s.path}>
              <button
                onClick={() => setActive(s.path)}
                className={`w-full text-left px-3 py-2 text-sm border-b border-line/50 ${active === s.path ? 'bg-accent-soft text-accent' : 'text-slate-300 hover:bg-white/5'}`}
              >
                <div className="truncate">{s.path}</div>
                <div className="text-[10px] text-slate-500">{(s.size / 1024).toFixed(1)} KB</div>
              </button>
            </li>
          ))}
          {skills.length === 0 && <li className="p-3 text-slate-500 text-sm">无</li>}
        </ul>
      </div>

      <div className="h-full flex flex-col">
        {!active && <div className="text-slate-500 text-sm">选择左侧脚本</div>}
        {active && cur && (
          <div className="flex flex-col h-full space-y-2">
            <div className="text-xs text-slate-500 font-mono">memory/skill/{active} (只读)</div>
            <pre className="flex-1 rounded-lg border border-line bg-bg-card p-4 text-sm text-slate-300 font-mono overflow-auto">
              {cur.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function Editor({ label, value, dirty, onChange, onSave }: {
  label: string; value: string; dirty: boolean
  onChange: (s: string) => void; onSave: () => void
}) {
  return (
    <div className="h-full flex flex-col space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500 font-mono">{label}</div>
        <button
          disabled={!dirty}
          onClick={onSave}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
        >{dirty ? '保存' : '已保存'}</button>
      </div>
      <div className="flex-1 min-h-0">
        <MarkdownEditor value={value} onChange={onChange} />
      </div>
    </div>
  )
}
