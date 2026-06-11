// MyKey — visual editor for GenericAgent's mykey.py.
//
// Two tabs:
//   * 结构化  — typed form per detected session (Claude / OpenAI / Mixin) +
//              quick-add buttons that pre-fill official template defaults
//   * 原始    — raw editor with line numbers, atomic save with ast.parse
//              validation, and a backup drawer for one-click rollback.
//
// All saves go through PUT /api/mykey/raw which:
//   1. validates with ast.parse + compile
//   2. snapshots the previous file to ~/.genericagent-admin/mykey-backups/
//   3. atomically replaces mykey.py
//   4. calls agent.load_llm_sessions() to hot-reload — no process restart.
//
// apikey is always masked in the structured view; the raw tab is the
// authoritative plaintext source if the user wants to read or copy it.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { MyKeyData, MyKeySession, MyKeySessionType, MyKeyWriteResult } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { dialog } from '@/stores/dialogStore'

type Tab = 'structured' | 'raw'

export function MyKey() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('structured')
  const { data, isLoading, refetch } = useQuery({ queryKey: ['mykey'], queryFn: api.mykey })

  const onWriteResult = (r: MyKeyWriteResult) => {
    if (r.warnings && r.warnings.length) {
      dialog.alert('保存成功，但有警告', r.warnings.join('\n'))
    }
    qc.invalidateQueries({ queryKey: ['mykey'] })
    qc.invalidateQueries({ queryKey: ['llms'] })
    qc.invalidateQueries({ queryKey: ['status'] })
  }

  return (
    <PageShell
      title="链路配置"
      description="编辑 GenericAgent 的 mykey.py — 新增 / 修改 LLM 链路、apikey 与第三方平台 token。保存后自动热更新，无需重启。"
      actions={
        <div className="flex items-center gap-2 text-sm">
          <div className="flex bg-bg-card border border-line rounded-lg overflow-hidden text-xs">
            {(['structured', 'raw'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 ${tab === t ? 'bg-accent text-white' : 'text-slate-300 hover:bg-white/5'}`}
              >
                {t === 'structured' ? '结构化' : '原始'}
              </button>
            ))}
          </div>
          <button onClick={() => refetch()} className="ga-btn">↻ 刷新</button>
        </div>
      }
    >
      <div className="p-6 max-w-5xl mx-auto">
        {isLoading && <div className="text-slate-500 text-sm">载入中…</div>}
        {data && !data.exists && (
          <div className="rounded-xl border border-amber-700/60 bg-amber-900/20 p-4 text-sm text-amber-200">
            <div className="font-semibold mb-1">mykey.py 不存在</div>
            <div className="text-amber-200/80">
              路径 <span className="font-mono">{data.path}</span> 上还没有这个文件。
              切到「原始」tab 创建一份，或下方点 <strong>+ 新增</strong> 直接添加第一条链路。
            </div>
          </div>
        )}
        {data && tab === 'structured' && <StructuredView data={data} onWrite={onWriteResult} />}
        {data && tab === 'raw' && <RawView data={data} onWrite={onWriteResult} />}
      </div>
    </PageShell>
  )
}

// ── structured view ─────────────────────────────────────────────────
function StructuredView({ data, onWrite }: { data: MyKeyData; onWrite: (r: MyKeyWriteResult) => void }) {
  const [editor, setEditor] = useState<MyKeySession | null>(null)
  const [creating, setCreating] = useState<MyKeySessionType | null>(null)
  const [openRows, setOpenRows] = useState<Set<number>>(new Set())

  const sessions = data.structured.sessions
  const mixins = data.structured.mixins ?? (data.structured.mixin ? [data.structured.mixin] : [])
  const allEntries = [...mixins, ...sessions]
  const globals_ = data.structured.globals

  const startCreate = (type: MyKeySessionType) => {
    setCreating(type)
    setEditor({ var: defaultVarName(type, allEntries), type, fields: defaultFields(type) })
  }

  const startEdit = (s: MyKeySession) => {
    setCreating(null)
    setEditor({ ...s, fields: { ...s.fields } })
  }

  const startDuplicate = (s: MyKeySession) => {
    setCreating(s.type)
    setEditor({
      var: `${s.var}_copy`,
      type: s.type,
      fields: { ...s.fields, apikey_masked: undefined },
    })
  }

  const remove = async (s: MyKeySession) => {
    const ok = await dialog.confirm(
      `删除 ${s.var}？`,
      `这会从 mykey.py 移除该变量定义。备份会自动保留，可在抽屉里回滚。`,
      { tone: 'danger', confirmText: '删除' },
    )
    if (!ok) return
    try {
      const r = await api.deleteMyKeySession(s.var)
      onWrite(r)
    } catch (e: any) {
      dialog.alert('删除失败', e?.body?.detail || e?.message || String(e))
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-300">LLM 链路（{sessions.length}）</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => startCreate('native_claude')}
              className="px-3 py-1.5 text-xs rounded-lg border border-purple-300/60 bg-purple-100/80 text-purple-700 hover:bg-purple-100 dark:border-purple-500/30 dark:bg-purple-900/40 dark:text-purple-300">+ Claude</button>
            <button onClick={() => startCreate('native_oai')}
              className="px-3 py-1.5 text-xs rounded-lg border border-emerald-300/60 bg-emerald-100/80 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-900/40 dark:text-emerald-300">+ OpenAI</button>
            <button onClick={() => startCreate('mixin')}
              className="px-3 py-1.5 text-xs rounded-lg border border-amber-300/70 bg-amber-100/80 text-amber-700 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-900/40 dark:text-amber-300"
              title="新增一条故障转移路由；可同时保留多条 mixin 配置"
            >+ Mixin 路由</button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {allEntries.map((entry, idx) => {
            const row = Math.floor(idx / 2)
            const expanded = openRows.has(row)
            return (
              <SessionCard key={entry.var} s={entry} expanded={expanded}
                onToggle={() => {
                  setOpenRows((prev) => {
                    const next = new Set(prev)
                    if (next.has(row)) next.delete(row)
                    else next.add(row)
                    return next
                  })
                }}
                onEdit={() => startEdit(entry)}
                onDuplicate={() => startDuplicate(entry)}
                onDelete={() => remove(entry)} />
            )
          })}
          {sessions.length === 0 && mixins.length === 0 && (
            <div className="md:col-span-2 text-slate-500 text-sm py-8 text-center border border-dashed border-line rounded-xl">
              尚未配置任何链路。点上方 <strong>+ Claude</strong> 或 <strong>+ OpenAI</strong> 添加第一条。
            </div>
          )}
        </div>
      </section>

      <GlobalsSection globals_={globals_} onWrite={onWrite} rawText={data.raw} />

      {editor && (
        <SessionDialog
          mode={creating ? 'create' : 'edit'}
          session={editor}
          allSessions={allEntries}
          onClose={() => { setEditor(null); setCreating(null) }}
          onSaved={(r) => { onWrite(r); setEditor(null); setCreating(null) }}
        />
      )}
    </div>
  )
}

function SessionCard({ s, expanded, onToggle, onEdit, onDuplicate, onDelete }: {
  s: MyKeySession
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const meta = sessionMeta(s.type)
  const title = s.fields.name || s.var
  const isClaude = s.type === 'native_claude'
  const isOpenAI = s.type === 'native_oai' || s.type === 'oai'
  const colorTone = isClaude
    ? 'from-fuchsia-100/72 via-fuchsia-50/56 to-slate-200/84 dark:from-fuchsia-950/28 dark:via-slate-950/72 dark:to-slate-900/48 shadow-[0_8px_22px_rgba(15,23,42,0.07)]'
    : isOpenAI
      ? 'from-cyan-300/95 via-cyan-200/88 to-slate-300/94 dark:from-cyan-950/34 dark:via-slate-950/74 dark:to-slate-900/50 shadow-[0_8px_22px_rgba(15,23,42,0.08)]'
      : 'from-amber-300/94 via-amber-200/86 to-slate-300/94 dark:from-amber-950/30 dark:via-slate-950/74 dark:to-slate-900/50 shadow-[0_8px_22px_rgba(15,23,42,0.08)]'
  const accentTone = isClaude
    ? 'bg-fuchsia-300 shadow-[0_0_10px_rgba(244,114,182,0.28)]'
    : isOpenAI
      ? 'bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.28)]'
      : 'bg-amber-200 shadow-[0_0_10px_rgba(253,230,138,0.25)]'
  const mixinTargets = s.fields.llm_nos || []
  const summary = s.type !== 'mixin'
    ? (s.fields.model || '未设置模型')
    : (mixinTargets.join(' → ') || '未设置路由目标')

  return (
    <div className={`group overflow-hidden rounded-2xl border border-slate-300/85 bg-gradient-to-br from-slate-200/95 via-slate-200/90 to-slate-300/92 text-slate-900 shadow-sm shadow-slate-900/6 transition-all dark:border-white/8 dark:from-slate-900/65 dark:via-slate-950/55 dark:to-slate-900/35 dark:text-slate-100 ${colorTone} ${expanded ? 'border-slate-400/90 dark:border-white/12' : ''}`}>
      <button type="button" onClick={onToggle} className="w-full text-left px-4 py-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className={`shrink-0 text-[10px] tracking-[0.12em] uppercase px-2 py-1 rounded-full border backdrop-blur-[2px] ${meta.tone}`}>{meta.label}</span>
              <span className="min-w-0 truncate text-[15px] leading-5 font-semibold tracking-[0.01em] text-slate-900 dark:text-slate-100">{title}</span>
            </div>
            {!expanded && (
              <div className="mt-1.5 flex items-center gap-2 min-w-0">
                <div className={`h-2 w-2 rounded-full shrink-0 ${accentTone}`} />
                <div className="min-w-0 truncate text-[13px] leading-5 text-slate-500 dark:text-slate-400 font-medium tracking-[0.01em]" title={String(summary)}>
                  {summary}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 pl-2">
            {expanded && <span className="text-[11px] text-slate-500 font-mono">L{s.lineno}</span>}
            <span className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-slate-300 shadow-inner shadow-white/5 transition-all duration-200 group-hover:bg-white/[0.07] ${expanded ? 'rotate-180 text-white' : ''}`}>
              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
                <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-300/80 bg-slate-200/90 px-4 py-3 dark:border-white/8 dark:bg-white/[0.03]">
          <div className={`grid gap-x-6 gap-y-3 ${s.type !== 'mixin' ? 'md:grid-cols-2' : ''}`}>
            {s.type !== 'mixin' ? (
              <dl className="space-y-1.5 text-xs">
                <KV k="model" v={s.fields.model} mono />
                <KV k="apibase" v={s.fields.apibase} mono />
                <KV k="apikey" v={s.fields.apikey_masked} mono />
              </dl>
            ) : (
              <dl className="space-y-1.5 text-xs">
                <div className="flex items-start gap-2">
                  <dt className="text-slate-500 shrink-0 w-24">apis</dt>
                  <dd className="min-w-0 flex-1 font-mono text-slate-300 break-all leading-5">
                    {Array.isArray(s.fields.llm_nos) && s.fields.llm_nos.length > 0 ? s.fields.llm_nos.join(' → ') : <span className="text-slate-600">—</span>}
                  </dd>
                </div>
                <KV k="max_retries" v={String(s.fields.max_retries ?? '—')} />
                <KV k="base_delay" v={String(s.fields.base_delay ?? '—')} />
              </dl>
            )}
            {s.type !== 'mixin' ? (
              <dl className="space-y-1.5 text-xs">
                {s.fields.thinking_type && <KV k="thinking" v={s.fields.thinking_type} />}
                {s.fields.api_mode && <KV k="api_mode" v={s.fields.api_mode} />}
                {s.fields.reasoning_effort && <KV k="effort" v={s.fields.reasoning_effort} />}
                {s.fields.fake_cc_system_prompt && <KV k="fake_cc_sysprompt" v="✓" />}
              </dl>
            ) : null}
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            <button onClick={onEdit} className="text-xs px-3 py-1.5 rounded-xl bg-accent text-white shadow-sm shadow-accent/20">编辑</button>
            <button onClick={onDuplicate} className="text-xs px-3 py-1.5 rounded-xl border border-white/10 text-slate-300 hover:bg-white/5">复制</button>
            <button onClick={onDelete} className="text-xs px-3 py-1.5 rounded-xl border border-rose-700/60 text-rose-300 hover:bg-rose-900/20">删除</button>
          </div>
        </div>
      )}
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: any; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-slate-500 shrink-0 w-24">{k}</dt>
      <dd className={`text-slate-300 truncate ${mono ? 'font-mono' : ''}`} title={String(v ?? '')}>
        {v == null || v === '' ? <span className="text-slate-600">—</span> : String(v)}
      </dd>
    </div>
  )
}

function sessionMeta(type: MyKeySessionType) {
  switch (type) {
    case 'native_claude': return { label: '🅒 Claude (native)', tone: 'bg-purple-900/40 text-purple-300' }
    case 'native_oai':    return { label: '🅞 OpenAI (native)', tone: 'bg-emerald-900/40 text-emerald-300' }
    case 'claude':        return { label: '🅒 Claude (text)',  tone: 'bg-slate-700/60 text-slate-300' }
    case 'oai':           return { label: '🅞 OpenAI (text)',  tone: 'bg-slate-700/60 text-slate-300' }
    case 'mixin':         return { label: '🔀 Mixin 路由',       tone: 'bg-amber-900/40 text-amber-300' }
  }
}

// ── Edit / Create dialog ────────────────────────────────────────────
function SessionDialog({ mode, session, allSessions, onClose, onSaved }: {
  mode: 'create' | 'edit'
  session: MyKeySession
  allSessions: MyKeySession[]
  onClose: () => void
  onSaved: (r: MyKeyWriteResult) => void
}) {
  const [s, setS] = useState<MyKeySession>(session)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => setS(session), [session])

  const setField = (k: string, v: any) => setS({ ...s, fields: { ...s.fields, [k]: v } })

  const save = async () => {
    setErr(null); setSaving(true)
    try {
      // Strip apikey_masked, normalize empty strings to undefined for non-required fields.
      const fields = stripUiOnly(s.fields)
      const r = await api.upsertMyKeySession({ var: s.var, type: s.type, fields })
      onSaved(r)
    } catch (e: any) {
      const body = e?.body?.detail
      const msg = (body && typeof body === 'object')
        ? `${body.error}: ${body.message}${body.line ? ` (line ${body.line}:${body.col})` : ''}`
        : (e?.body || e?.message || String(e))
      setErr(typeof msg === 'string' ? msg : JSON.stringify(msg))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-bg-soft border border-line rounded-xl p-6 w-[40rem] max-w-[92vw] max-h-[88vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="text-base font-semibold">
            {mode === 'create' ? '新增链路' : '编辑链路'}
            <span className="ml-2 text-xs text-slate-500">{sessionMeta(s.type).label}</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-xl leading-none">×</button>
        </div>

        <Field label="变量名（mykey.py 里的 Python 变量）" hint="必须含 'config' 字样；以及 'native+claude' 或 'native+oai' 之类关键字才会被 GA 识别。">
          <input value={s.var} onChange={(e) => setS({ ...s, var: e.target.value })}
            className={inp + ' font-mono'} placeholder="native_claude_xxx_config" />
        </Field>

        {s.type !== 'mixin' && (
          <>
            <Field label="name（链路展示名 & mixin 引用名）">
              <input value={s.fields.name ?? ''} onChange={(e) => setField('name', e.target.value)}
                className={inp} placeholder="如 claude / glm / gpt" />
            </Field>
            <Field label="apikey" hint={mode === 'edit' ? '留空保留原值' : undefined}>
              <div className="flex gap-2 items-stretch">
                <input
                  value={s.fields.apikey ?? ''}
                  onChange={(e) => setField('apikey', e.target.value)}
                  type={showKey ? 'text' : 'password'}
                  className={inp + ' font-mono flex-1'}
                  placeholder={mode === 'edit' ? `当前: ${s.fields.apikey_masked || '—'}` : 'sk-...'}
                  autoComplete="off"
                />
                <button onClick={() => setShowKey(!showKey)} type="button"
                  className="px-3 rounded-lg border border-line text-slate-300 hover:bg-white/5 text-sm shrink-0">
                  {showKey ? '🙈 隐藏' : '👁 显示'}
                </button>
              </div>
            </Field>
            <Field label="apibase">
              <input value={s.fields.apibase ?? ''} onChange={(e) => setField('apibase', e.target.value)}
                className={inp + ' font-mono'} placeholder="https://api.anthropic.com" />
            </Field>
            <Field label="model">
              <input value={s.fields.model ?? ''} onChange={(e) => setField('model', e.target.value)}
                className={inp + ' font-mono'} placeholder="claude-opus-4-7[1m]" />
            </Field>
          </>
        )}

        {/* type-specific */}
        {(s.type === 'native_claude' || s.type === 'claude') && (
          <>
            <Field label="thinking_type">
              <select value={s.fields.thinking_type ?? ''} onChange={(e) => setField('thinking_type', e.target.value || undefined)} className={inp}>
                <option value="">（不设置）</option>
                <option value="adaptive">adaptive（推荐）</option>
                <option value="enabled">enabled（需配 thinking_budget_tokens）</option>
                <option value="disabled">disabled</option>
              </select>
            </Field>
            {s.fields.thinking_type === 'enabled' && (
              <Field label="thinking_budget_tokens">
                <input type="number" min={1024} value={s.fields.thinking_budget_tokens ?? 32768}
                  onChange={(e) => setField('thinking_budget_tokens', +e.target.value)} className={inp} />
              </Field>
            )}
            <Field label="fake_cc_system_prompt">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!s.fields.fake_cc_system_prompt}
                  onChange={(e) => setField('fake_cc_system_prompt', e.target.checked || undefined)} />
                <span className="text-slate-300">CC switch / 反代渠道必须勾选</span>
              </label>
            </Field>
          </>
        )}

        {(s.type === 'native_oai' || s.type === 'oai') && (
          <>
            <Field label="api_mode">
              <select value={s.fields.api_mode ?? 'chat_completions'} onChange={(e) => setField('api_mode', e.target.value)} className={inp}>
                <option value="chat_completions">chat_completions（默认）</option>
                <option value="responses">responses（OpenAI Responses API）</option>
              </select>
            </Field>
            <Field label="reasoning_effort">
              <select value={s.fields.reasoning_effort ?? ''} onChange={(e) => setField('reasoning_effort', e.target.value || undefined)} className={inp}>
                <option value="">（不设置）</option>
                {['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
          </>
        )}

        {s.type === 'mixin' && <MixinFields s={s} setS={setS} allSessions={allSessions} />}

        <details className="mt-3">
          <summary className="text-xs text-slate-400 cursor-pointer">高级（max_retries / read_timeout / temperature / max_tokens / context_win / proxy）</summary>
          <div className="pt-2 grid grid-cols-2 gap-2">
            <NumField label="max_retries" v={s.fields.max_retries} onChange={(v) => setField('max_retries', v)} />
            <NumField label="connect_timeout" v={s.fields.connect_timeout} onChange={(v) => setField('connect_timeout', v)} />
            <NumField label="read_timeout" v={s.fields.read_timeout} onChange={(v) => setField('read_timeout', v)} />
            <NumField label="context_win" v={s.fields.context_win} onChange={(v) => setField('context_win', v)} />
            <NumField label="temperature" v={s.fields.temperature} onChange={(v) => setField('temperature', v)} step={0.1} />
            <NumField label="max_tokens" v={s.fields.max_tokens} onChange={(v) => setField('max_tokens', v)} />
            <Field label="proxy" >
              <input value={s.fields.proxy ?? ''} onChange={(e) => setField('proxy', e.target.value || undefined)}
                className={inp + ' font-mono'} placeholder="http://127.0.0.1:7890（可空）" />
            </Field>
            <Field label="stream">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={s.fields.stream !== false}
                  onChange={(e) => setField('stream', e.target.checked ? undefined : false)} />
                <span className="text-slate-300">默认开启；遇 SSE 截断关掉保命</span>
              </label>
            </Field>
          </div>
        </details>

        {err && <div className="mt-3 text-xs text-rose-400 bg-rose-900/20 border border-rose-700/40 rounded p-2 break-words">{err}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-line text-slate-300">取消</button>
          <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded-lg bg-accent text-white disabled:opacity-40">
            {saving ? '保存中…' : '保存并热更新'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MixinFields({ s, setS, allSessions }: { s: MyKeySession; setS: (v: MyKeySession) => void; allSessions: MyKeySession[] }) {
  const llmNos: string[] = Array.isArray(s.fields.llm_nos) ? s.fields.llm_nos.map(String) : []
  const candidates = Array.from(new Set(
    allSessions
      .filter((x) => x.type !== 'mixin')
      .map((x) => String(x.fields.name || '').trim())
      .filter(Boolean),
  ))
  const setNos = (next: string[]) => setS({ ...s, fields: { ...s.fields, llm_nos: next } })
  const move = (i: number, dir: -1 | 1) => {
    const next = [...llmNos]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setNos(next)
  }
  return (
    <>
      <Field label="llm_nos（按优先级排列；填 session 的 name）">
        <div className="space-y-1.5">
          {llmNos.map((n, i) => (
            <div key={i} className="flex items-center gap-1">
              <input value={n} onChange={(e) => {
                const next = [...llmNos]; next[i] = e.target.value; setNos(next)
              }} list="mixin-name-candidates" className={inp + ' font-mono flex-1 rounded-md bg-slate-200/80 border-slate-400/70 text-slate-800 dark:bg-slate-700/45 dark:border-slate-500/60 dark:text-slate-100'} />
              <button onClick={() => move(i, -1)} disabled={i === 0}
                className="px-2 py-1.5 text-xs rounded border border-line text-slate-300 hover:bg-white/5 disabled:opacity-30">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === llmNos.length - 1}
                className="px-2 py-1.5 text-xs rounded border border-line text-slate-300 hover:bg-white/5 disabled:opacity-30">↓</button>
              <button onClick={() => setNos(llmNos.filter((_, k) => k !== i))}
                className="px-2 py-1.5 text-xs rounded border border-rose-700/60 text-rose-300 hover:bg-rose-900/20">×</button>
            </div>
          ))}
          {candidates.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {candidates.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    if (llmNos.includes(name)) return
                    setNos([...llmNos, name])
                  }}
                  className="px-2 py-0.5 text-[11px] rounded border border-line text-slate-300 hover:bg-white/5"
                  title="点击加入 llm_nos"
                >
                  + {name}
                </button>
              ))}
            </div>
          )}
          {candidates.length > 0 && (
            <datalist id="mixin-name-candidates">
              {candidates.map((name) => <option key={name} value={name} />)}
            </datalist>
          )}
        </div>
      </Field>
      <NumField label="max_retries" v={s.fields.max_retries} onChange={(v) => setS({ ...s, fields: { ...s.fields, max_retries: v } })} />
      <NumField label="base_delay (秒)" v={s.fields.base_delay} onChange={(v) => setS({ ...s, fields: { ...s.fields, base_delay: v } })} step={0.1} />
      <NumField label="spring_back (秒)" v={s.fields.spring_back} onChange={(v) => setS({ ...s, fields: { ...s.fields, spring_back: v } })} />
    </>
  )
}

// ── globals (proxy / tg / etc.) ────────────────────────────────────
function GlobalsSection({ globals_, onWrite, rawText }: {
  globals_: Record<string, any>
  onWrite: (r: MyKeyWriteResult) => void
  rawText: string
}) {
  // Just render as a read-only summary; encourage the raw tab for editing.
  // proxy is the most-common one — we surface it as an inline editor.
  const [proxy, setProxy] = useState<string>(typeof globals_.proxy === 'string' ? globals_.proxy : '')
  const [saving, setSaving] = useState(false)
  const dirty = proxy !== (globals_.proxy ?? '')

  const saveProxy = async () => {
    setSaving(true)
    try {
      // Splice the proxy assignment in raw text rather than building structure.
      let next = rawText
      const re = /^proxy\s*=\s*.+$/m
      const newLine = proxy.trim()
        ? `proxy = ${JSON.stringify(proxy.trim())}`
        : '# proxy = ""'
      next = re.test(next) ? next.replace(re, newLine) : next + (next.endsWith('\n') ? '' : '\n') + '\n' + newLine + '\n'
      const r = await api.putMyKeyRaw(next)
      onWrite(r)
    } catch (e: any) {
      dialog.alert('保存失败', e?.body?.detail || e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const otherGlobals = Object.entries(globals_).filter(([k]) => k !== 'proxy')

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-300 mb-3">全局配置</h2>
      <div className="rounded-xl border border-line bg-bg-card p-4 space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <div className="text-xs text-slate-500 mb-1">proxy（所有未单独指定的 session 共用）</div>
            <input value={proxy} onChange={(e) => setProxy(e.target.value)}
              className={inp + ' font-mono'} placeholder="http://127.0.0.1:7890（留空禁用）" />
          </div>
          <button onClick={saveProxy} disabled={!dirty || saving}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40">
            {saving ? '保存中…' : '保存 proxy'}
          </button>
        </div>
        {otherGlobals.length > 0 && (
          <details>
            <summary className="text-xs text-slate-400 cursor-pointer">其它全局变量（{otherGlobals.length}）— 在「原始」tab 编辑</summary>
            <dl className="pt-2 space-y-1 text-xs">
              {otherGlobals.map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-2">
                  <dt className="text-slate-500 font-mono w-44 shrink-0">{k}</dt>
                  <dd className="text-slate-300 font-mono truncate" title={JSON.stringify(v)}>
                    {summarizeGlobal(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </section>
  )
}

function summarizeGlobal(v: any): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v
  if (Array.isArray(v)) return `[${v.length} 项]`
  if (typeof v === 'object') return `{${Object.keys(v).length} 字段}`
  return String(v)
}

// ── raw view ────────────────────────────────────────────────────────
function RawView({ data, onWrite }: { data: MyKeyData; onWrite: (r: MyKeyWriteResult) => void }) {
  const [text, setText] = useState(data.raw)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showBackups, setShowBackups] = useState(false)

  useEffect(() => setText(data.raw), [data.raw])

  const dirty = text !== data.raw
  const lines = useMemo(() => text.split('\n'), [text])
  const pad = String(lines.length).length

  const save = async () => {
    setErr(null); setSaving(true)
    try {
      const r = await api.putMyKeyRaw(text)
      onWrite(r)
    } catch (e: any) {
      const body = e?.body?.detail
      const msg = (body && typeof body === 'object')
        ? `第 ${body.line}:${body.col} 行 — ${body.message}`
        : (e?.body || e?.message || String(e))
      setErr(typeof msg === 'string' ? msg : JSON.stringify(msg))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-slate-400">
          <span className="font-mono break-all">{data.path}</span>
          {dirty && <span className="text-amber-300">(未保存)</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowBackups(true)}
            className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5">备份历史</button>
          <button onClick={() => setText(data.raw)} disabled={!dirty}
            className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 disabled:opacity-40">还原</button>
          <button onClick={save} disabled={!dirty || saving}
            className="px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-40">
            {saving ? '保存中…' : '保存并热更新'}
          </button>
        </div>
      </div>

      {err && (
        <div className="text-xs text-rose-400 bg-rose-900/20 border border-rose-700/40 rounded p-2 break-words">
          ✗ {err}
        </div>
      )}

      <div className="rounded-lg border border-line bg-bg-card overflow-hidden flex">
        <pre className="select-none text-right pr-2 pl-3 py-3 text-xs font-mono leading-6 text-slate-600 bg-bg-soft border-r border-line">
          {lines.map((_, i) => <div key={i} style={{ minWidth: `${pad}ch` }}>{i + 1}</div>)}
        </pre>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="flex-1 p-3 bg-bg-card outline-none font-mono text-xs leading-6 resize-none"
          rows={Math.max(20, lines.length)}
          style={{ minHeight: '60vh' }}
        />
      </div>

      {showBackups && (
        <BackupDrawer onClose={() => setShowBackups(false)} onRestored={onWrite} />
      )}
    </div>
  )
}

function BackupDrawer({ onClose, onRestored }: {
  onClose: () => void
  onRestored: (r: MyKeyWriteResult) => void
}) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['mykey.backups'],
    queryFn: api.mykeyBackups,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const backups = data?.backups ?? []

  const restore = async (name: string) => {
    const ok = await dialog.confirm(
      '回滚到此备份？',
      `当前内容会先被保存为新的备份再被覆盖（不会丢失）。`,
      { confirmText: '回滚' },
    )
    if (!ok) return
    setBusy(name)
    try {
      const r = await api.restoreMyKeyBackup(name)
      onRestored(r)
      onClose()
    } catch (e: any) {
      dialog.alert('回滚失败', e?.body?.detail || e?.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/55 flex items-end justify-end" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-[28rem] h-full bg-bg-soft border-l border-line flex flex-col"
           onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b border-line flex items-baseline justify-between">
          <div>
            <h3 className="text-base font-semibold">备份历史</h3>
            <p className="text-xs text-slate-500 mt-0.5">最近 10 份；保存在 admin 数据目录，与 GA 仓库无关</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-xl leading-none">×</button>
        </header>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {isLoading && <div className="text-slate-500 text-sm p-4">载入中…</div>}
          {!isLoading && backups.length === 0 && (
            <div className="text-slate-500 text-sm p-6 text-center">尚无备份</div>
          )}
          {backups.map((b) => (
            <div key={b.name} className="rounded-lg border border-line bg-bg-card p-3">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <div className="text-xs text-slate-400 font-mono truncate" title={b.name}>{b.name}</div>
                <button onClick={() => restore(b.name)} disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded bg-accent text-white disabled:opacity-40">
                  {busy === b.name ? '回滚中…' : '↩ 回滚'}
                </button>
              </div>
              <div className="text-[10px] text-slate-500">
                {new Date(b.mtime * 1000).toLocaleString()} · {(b.size / 1024).toFixed(1)} KB
              </div>
            </div>
          ))}
        </div>
        <footer className="border-t border-line px-4 py-2 text-xs text-slate-500 flex items-center justify-end">
          <button onClick={() => refetch()} className="text-accent hover:underline">↻ 刷新</button>
        </footer>
      </div>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────
const inp = 'w-full bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent text-slate-200'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-slate-600 mt-1">{hint}</div>}
    </div>
  )
}

function NumField({ label, v, onChange, step }: { label: string; v: any; onChange: (v: any) => void; step?: number }) {
  return (
    <Field label={label}>
      <input
        type="number"
        step={step ?? 1}
        value={v ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : (step ? parseFloat(e.target.value) : parseInt(e.target.value)))}
        className={inp}
        placeholder="（默认）"
      />
    </Field>
  )
}

function defaultVarName(type: MyKeySessionType, existing: MyKeySession[]): string {
  const base =
    type === 'native_claude' ? 'native_claude_config' :
    type === 'native_oai'    ? 'native_oai_config'    :
    type === 'mixin'         ? 'mixin_config'          :
    type === 'claude'        ? 'oai_claude_config'     :
    /* oai */                  'oai_config'
  const taken = new Set(existing.map((s) => s.var))
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const name = `${base}_${i}`
    if (!taken.has(name)) return name
  }
  return base + '_new'
}

function defaultFields(type: MyKeySessionType): Record<string, any> {
  if (type === 'native_claude') return {
    name: 'claude',
    apikey: '',
    apibase: 'https://api.anthropic.com',
    model: 'claude-opus-4-7[1m]',
    thinking_type: 'adaptive',
  }
  if (type === 'native_oai') return {
    name: 'gpt',
    apikey: '',
    apibase: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    api_mode: 'chat_completions',
  }
  if (type === 'mixin') return {
    llm_nos: [],
    max_retries: 5,
    base_delay: 0.5,
  }
  if (type === 'claude') return { name: 'claude', apikey: '', apibase: '', model: '' }
  return { name: 'gpt', apikey: '', apibase: '', model: '' }
}

function stripUiOnly(fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'apikey_masked') continue
    if (v === undefined) continue
    if (typeof v === 'string' && v.trim() === '' && k !== 'apikey') continue
    out[k] = v
  }
  return out
}
