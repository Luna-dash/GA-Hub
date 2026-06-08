// Memory: tabs for global_mem.txt, insight, SOPs (markdown).
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { PageShell } from '@/components/PageShell'

type Tab = 'global' | 'insight' | 'sop'

export function Memory() {
  const [tab, setTab] = useState<Tab>('global')
  return (
    <PageShell
      title="SOP 记忆"
      description="编辑 GenericAgent 的长期记忆与流程文档（global_mem · insight · *_sop.md）"
      actions={
        <div className="flex gap-1 text-sm">
          {(['global', 'insight', 'sop'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg ${tab === t ? 'bg-accent text-white' : 'border border-line text-slate-300 hover:bg-white/5'}`}
            >
              {t === 'global' ? 'global_mem' : t === 'insight' ? 'insight 索引' : 'SOP / Skills'}
            </button>
          ))}
        </div>
      }
    >
      <div className="p-6">
        {tab === 'global' && <GlobalMem />}
        {tab === 'insight' && <Insight />}
        {tab === 'sop' && <SopList />}
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
      onSave={async () => { await api.setGlobalMem(v); setDirty(false); qc.invalidateQueries({ queryKey: ['mem.global'] }) }}
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
      onSave={async () => { await api.setInsight(v); setDirty(false); qc.invalidateQueries({ queryKey: ['mem.insight'] }) }}
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
    <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-4">
      <div className="rounded-lg border border-line bg-bg-card overflow-hidden">
        <div className="px-3 py-2 border-b border-line text-xs text-slate-400">SOP / 文档</div>
        <ul className="max-h-[60vh] overflow-y-auto">
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

      <div>
        {!active && <div className="text-slate-500 text-sm">选择左侧文档</div>}
        {active && (
          <Editor
            label={`memory/${active}`}
            value={v}
            dirty={dirty}
            onChange={(s) => { setV(s); setDirty(true) }}
            onSave={async () => { await api.setSop(active, v); setDirty(false); qc.invalidateQueries({ queryKey: ['sop', active] }) }}
          />
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500 font-mono">{label}</div>
        <button
          disabled={!dirty}
          onClick={onSave}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
        >{dirty ? '保存' : '已保存'}</button>
      </div>
      <MarkdownEditor value={value} onChange={onChange} height={520} />
    </div>
  )
}
