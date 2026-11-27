// MyKey — visual editor for GenericAgent's mykey.py.
//
// Two tabs:
//   * 结构化  — typed form per detected session (Claude / OpenAI / Mixin) +
//              quick-add buttons that pre-fill official template defaults
//   * 原始    — raw editor with line numbers, atomic save with ast.parse
//              validation, and a backup drawer for one-click rollback.
//
// Structured saves use POST /api/mykey/mutation; raw saves use PUT /api/mykey/raw:
//   1. validates with ast.parse + compile
//   2. snapshots the previous file to ~/.genericagent-admin/mykey-backups/
//   3. atomically replaces mykey.py
//   4. calls agent.load_llm_sessions() to hot-reload — no process restart.
//
// apikey is always masked in the structured view; the raw tab is the
// authoritative plaintext source if the user wants to read or copy it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@/styles/mykey.css'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { MyKeyData, MyKeySession, MyKeySessionTestResult, MyKeySessionType, MyKeyWriteResult } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { ModalOverlay } from '@/components/ModalOverlay'
import { QueryLoadState } from '@/components/QueryLoadState'
import { SessionChannelIcon } from '@/components/SessionChannelIcon'
import { RawView } from '@/components/MyKeyRawView'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { queryKeys } from '@/queries/queryKeys'
import { useDirtyClose } from '@/hooks/useDirtyClose'
import { usePageState } from '@/utils/pageState'
import { getMyKeyShowUpload, MYKEY_SHOW_UPLOAD_EVENT, MYKEY_SYNC_CONFIRM, myKeySyncSuccess, myKeySyncFailure } from '@/utils/mykeySyncUi'
import { extractErrorMessage } from '@/utils/errors'
import { errorMessageFromError, myKeyParseErrorFromError } from '@/utils/sessionUi'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CloseIconButton,
  CopyIcon,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Pencil,
  Play,
  RefreshIcon,
  Save,
  Trash2,
  Upload,
} from '@/components/ActionIcons'

type Tab = 'structured' | 'raw'

// One source of truth for channel order, icons, labels and accent colors.
const SESSION_META = {
  mixin: { label: 'Mixin 路由', tone: 'mixin', order: 0 },
  native_oai: { label: 'OpenAI (native)', tone: 'openai', order: 1 },
  oai: { label: 'OpenAI (text)', tone: 'openai', order: 1 },
  native_claude: { label: 'Claude (native)', tone: 'claude', order: 2 },
  claude: { label: 'Claude (text)', tone: 'claude', order: 2 },
} as const
const CREATE_TYPES: MyKeySessionType[] = ['mixin', 'native_oai', 'native_claude']

function ChannelLabel({ type }: { type: MyKeySessionType }) {
  const meta = sessionMeta(type)
  return <>
    <SessionChannelIcon type={meta.tone} className="mykey-channel-icon" />
    <span>{meta.label}</span>
  </>
}

export default function MyKey() {
  const qc = useQueryClient()
  const [tab, setTab] = usePageState<Tab>('mykey.tab', 'structured')
  const [syncBusy, setSyncBusy] = useState<'upload' | 'fetch' | null>(null)
  const [openingFile, setOpeningFile] = useState(false)
  const openFileBusyRef = useRef(false)
  const syncBusyRef = useRef(false)
  // 上传按钮默认隐藏；在设置页手动确认后才显示（跨页同步经 localStorage + 自定义事件）。
  const [showUpload, setShowUpload] = useState(getMyKeyShowUpload)
  useEffect(() => {
    const sync = () => setShowUpload(getMyKeyShowUpload())
    window.addEventListener(MYKEY_SHOW_UPLOAD_EVENT, sync)
    return () => window.removeEventListener(MYKEY_SHOW_UPLOAD_EVENT, sync)
  }, [])
  const { data, isLoading, isError, isFetching, error, refetch } = useQuery({ queryKey: queryKeys.mykey.data, queryFn: api.mykey })
  const rawDirtyRef = useRef(false)
  const proxyDirtyRef = useRef(false)
  const setRawDirty = useCallback((dirty: boolean) => { rawDirtyRef.current = dirty }, [])
  const setProxyDirty = useCallback((dirty: boolean) => { proxyDirtyRef.current = dirty }, [])

  const switchTab = async (next: Tab) => {
    if (next === tab) return
    const dirtyMessage = tab === 'raw' && rawDirtyRef.current
      ? '原始视图有未保存的编辑，切换标签将丢失这些修改。'
      : tab === 'structured' && proxyDirtyRef.current
        ? '全局配置有未保存的修改，切换标签将丢失这些修改。'
        : null
    if (dirtyMessage) {
      const ok = await dialog.confirm('放弃未保存的修改？', dirtyMessage, {
        confirmText: '放弃修改',
        tone: 'danger',
      })
      if (!ok) return
      rawDirtyRef.current = false
      proxyDirtyRef.current = false
    }
    setTab(next)
  }

  const autoSync = useQuery({
    queryKey: ['mykey', 'auto-sync'], queryFn: api.myKeyAutoSync, refetchInterval: 30_000, refetchIntervalInBackground: false,
  })
  const [autoSyncBusy, setAutoSyncBusy] = useState(false)
  const autoSyncBusyRef = useRef(false)
  const toggleAutoSync = async (enabled: boolean) => {
    if (autoSyncBusyRef.current) return
    autoSyncBusyRef.current = true
    setAutoSyncBusy(true)
    try {
      const status = await api.setMyKeyAutoSync(enabled)
      qc.setQueryData(['mykey', 'auto-sync'], status)
    } catch {
      toast.error('自动同步设置未保存，请稍后重试')
    } finally {
      autoSyncBusyRef.current = false
      setAutoSyncBusy(false)
    }
  }

  const onWriteResult = (r: MyKeyWriteResult) => {
    if (r.warnings && r.warnings.length) {
      dialog.alert('保存成功，但有警告', r.warnings.join('\n'))
    } else {
      toast.success('已保存到 mykey.py')
    }
    qc.invalidateQueries({ queryKey: queryKeys.mykey.data })
    qc.invalidateQueries({ queryKey: queryKeys.mykey.backups })
    qc.invalidateQueries({ queryKey: queryKeys.llms })
    qc.invalidateQueries({ queryKey: queryKeys.servicePanel })
  }

  const handleOpenFile = async () => {
    if (openFileBusyRef.current) return
    openFileBusyRef.current = true
    setOpeningFile(true)
    try {
      const result = await api.openMyKeyFile()
      toast.success(`已打开 ${result.path}`)
    } catch (e: any) {
      toast.error('打开文件失败：' + errorMessageFromError(e))
    } finally {
      openFileBusyRef.current = false
      setOpeningFile(false)
    }
  }


  const handleUploadSync = async () => {
    if (syncBusyRef.current) return
    syncBusyRef.current = true
    try {
      const ok = await dialog.confirm(
        MYKEY_SYNC_CONFIRM.upload.title,
        MYKEY_SYNC_CONFIRM.upload.message,
        { confirmText: MYKEY_SYNC_CONFIRM.upload.confirmText },
      )
      if (!ok) return
      setSyncBusy('upload')
      try {
        const r = await api.uploadMyKeySync()
        toast.success(myKeySyncSuccess('upload', r.stdout))
      } catch (e: any) {
        const feedback = myKeySyncFailure('upload', e)
        void dialog.alert(feedback.title, feedback.message, { detail: feedback.detail })
      } finally {
        setSyncBusy(null)
      }
    } finally {
      syncBusyRef.current = false
    }
  }

  const handleFetchSync = async () => {
    if (syncBusyRef.current) return
    syncBusyRef.current = true
    try {
      const ok = await dialog.confirm(
        MYKEY_SYNC_CONFIRM.fetch.title,
        MYKEY_SYNC_CONFIRM.fetch.message,
        { tone: 'danger', confirmText: MYKEY_SYNC_CONFIRM.fetch.confirmText },
      )
      if (!ok) return
      setSyncBusy('fetch')
      try {
        const r = await api.fetchMyKeySync()
        if (r.warnings && r.warnings.length) {
          void dialog.alert('配置已下载，部分模型需要检查',
            '云端配置已同步到本机，但部分模型未能正常加载。请检查相关配置后再使用。',
            { detail: r.warnings.join('\n') })
        } else {
          toast.success(myKeySyncSuccess('fetch', r.stdout))
        }
        if (r.changed !== false) {
          qc.invalidateQueries({ queryKey: queryKeys.mykey.data })
          qc.invalidateQueries({ queryKey: queryKeys.llms })
          qc.invalidateQueries({ queryKey: queryKeys.servicePanel })
        }
      } catch (e: any) {
        const feedback = myKeySyncFailure('fetch', e)
        void dialog.alert(feedback.title, feedback.message, { detail: feedback.detail })
      } finally {
        setSyncBusy(null)
      }
    } finally {
      syncBusyRef.current = false
    }
  }

  return (
    <PageShell
      wrapHeader
      title="LLM管理"
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
          <div className="ga-segmented text-xs" role="tablist" aria-label="编辑模式">
            {(['structured', 'raw'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => { void switchTab(t) }}
                className={`ga-segmented-btn ${tab === t ? 'ga-segmented-btn-active' : ''}`}
              >
                {t === 'structured' ? '结构化' : '原始'}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => refetch()} className="ga-btn"><RefreshIcon size={14} /><span>刷新</span></button>
          {showUpload && (
            <button type="button" onClick={handleUploadSync} disabled={syncBusy !== null} className="ga-btn"><Upload className="h-3.5 w-3.5" aria-hidden="true" /><span>{syncBusy === 'upload' ? '上传中…' : '上传mykey'}</span></button>
          )}
          <button type="button" onClick={handleFetchSync} disabled={syncBusy !== null} className="ga-btn"><Download className="h-3.5 w-3.5" aria-hidden="true" /><span>{syncBusy === 'fetch' ? '下载中…' : '下载mykey'}</span></button>
          <button type="button" onClick={handleOpenFile} disabled={openingFile} className="ga-btn"><FolderOpen className="h-3.5 w-3.5" aria-hidden="true" /><span>{openingFile ? '打开中…' : '打开文件'}</span></button>
        </div>
      }
    >
      <div className="ga-page-board min-h-full flex flex-col">
        <section aria-label="云端自动同步" className="ga-paper-card p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">云端自动同步</h2>
              <p className="mt-0.5 text-xs text-ink-faint">每天 12:00 自动检查并同步云端配置。</p>
            </div>
            <label className="inline-flex items-center gap-2 rounded-lg bg-bg-soft/75 px-3 py-1.5 text-xs font-medium text-ink ring-1 ring-line/45 cursor-pointer">
              <input type="checkbox" aria-label="启用每日自动同步" checked={autoSync.data?.enabled ?? false}
                disabled={!autoSync.data || autoSyncBusy} onChange={(e) => void toggleAutoSync(e.target.checked)} />
              <span>每日同步</span>
            </label>
          </div>
          {autoSync.isError ? (
            <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-status-danger">
              <span>自动同步状态暂不可用：{extractErrorMessage(autoSync.error, '请重试')}</span>
              <button
                type="button"
                className="ga-btn-xs"
                disabled={autoSync.isFetching}
                onClick={() => { void autoSync.refetch() }}
              >
                {autoSync.isFetching ? '重试中…' : '重试'}
              </button>
            </div>
          ) : (
            <p role="status" className="mt-2 text-xs text-ink-faint">
              {autoSync.data
                ? `${autoSync.data.running ? '正在检查云端…' : (autoSync.data.message || (autoSync.data.enabled ? '每日自动同步已开启' : '每日自动同步未开启'))}${autoSync.data.last_checked ? ` · 最近检查 ${new Date(autoSync.data.last_checked).toLocaleString()}` : ''}`
                : '读取同步状态…'}
            </p>
          )}
        </section>
        {data && isError && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-status-danger-line bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
            <span>读取 mykey.py 失败：{extractErrorMessage(error)}</span>
            <button type="button" onClick={() => void refetch()} disabled={isFetching} className="ga-btn shrink-0">
              <RefreshIcon size={14} /><span>{isFetching ? '重试中…' : '重试'}</span>
            </button>
          </div>
        )}
        <QueryLoadState
          query={{ isLoading, isError: isError && !data, isFetching, error, refetch }}
          label="mykey.py"
          errorTitle="读取 mykey.py 失败"
          showDetail
        >
          {data && !data.exists && (
            <div className="rounded-xl border border-status-warning-line bg-status-warning-soft p-4 text-sm text-status-warning">
              <div className="font-semibold mb-1">mykey.py 不存在</div>
              <div className="text-status-warning-strong">
                路径 <span className="font-mono">{data.path}</span> 上还没有这个文件。
                切到「原始」tab 创建一份，或点下方右侧的 <strong>+ OpenAI (native)</strong> / <strong>+ Claude (native)</strong> 添加第一条链路。
              </div>
            </div>
          )}
          {data && tab === 'structured' && <StructuredView data={data} onWrite={onWriteResult} onProxyDirtyChange={setProxyDirty} />}
          {data && tab === 'raw' && <RawView data={data} onWrite={onWriteResult} onDirtyChange={setRawDirty} />}
        </QueryLoadState>
      </div>
    </PageShell>
  )
}

// ── structured view ─────────────────────────────────────────────────
function StructuredView({ data, onWrite, onProxyDirtyChange }: {
  data: MyKeyData
  onWrite: (r: MyKeyWriteResult) => void
  onProxyDirtyChange?: (dirty: boolean) => void
}) {
  const [editor, setEditor] = useState<MyKeySession | null>(null)
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | 'duplicate' | null>(null)
  const [sourceVar, setSourceVar] = useState<string | null>(null)
  const [openRows, setOpenRows] = useState<Set<number>>(new Set())

  const sessions = data.structured.sessions
  const mixins = data.structured.mixins
  const allEntries = useMemo(
    () => [...mixins, ...sessions].sort((a, b) =>
      sessionMeta(a.type).order - sessionMeta(b.type).order ||
      (a.lineno ?? Number.MAX_SAFE_INTEGER) - (b.lineno ?? Number.MAX_SAFE_INTEGER)),
    [mixins, sessions],
  )
  const globals_ = data.structured.globals

  const startCreate = (type: MyKeySessionType) => {
    setEditorMode('create')
    setSourceVar(null)
    setEditor({ var: defaultVarName(type, allEntries), type, fields: defaultFields(type) })
  }

  const startEdit = (s: MyKeySession) => {
    setEditorMode('edit')
    setSourceVar(s.var)
    setEditor({ ...s, fields: { ...s.fields } })
  }

  const startDuplicate = (s: MyKeySession) => {
    const existing = new Set(allEntries.map(entry => entry.var))
    const base = `${s.var}_copy`
    let candidate = base
    for (let suffix = 2; existing.has(candidate); suffix++) candidate = `${base}_${suffix}`
    setEditorMode('duplicate')
    setSourceVar(s.var)
    setEditor({
      var: candidate,
      type: s.type,
      fields: { ...s.fields, apikey: undefined },
    })
  }

  const [deletingVar, setDeletingVar] = useState<string | null>(null)
  const deleteBusyRef = useRef(false)

  const remove = async (s: MyKeySession) => {
    if (deleteBusyRef.current) return
    deleteBusyRef.current = true
    try {
      const ok = await dialog.confirm(
        `删除 ${s.var}？`,
        `确定从 mykey.py 删除该配置？删除前会自动保留备份。`,
        { tone: 'danger', confirmText: '删除' },
      )
      if (!ok) return
      setDeletingVar(s.var)
      try {
        const r = await api.mutateMyKey({ action: 'delete', var: s.var })
        onWrite(r)
      } catch (e: any) {
        dialog.alert('删除失败', errorMessageFromError(e))
      } finally {
        setDeletingVar(null)
      }
    } finally {
      deleteBusyRef.current = false
    }
  }

  return (
    <div className="flex flex-col gap-6 flex-1 min-h-0">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink">LLM 链路（{sessions.length}）</h2>
          <div className="mykey-channel-actions" aria-label="新增渠道">
            {CREATE_TYPES.map((type) => (
              <button key={type} type="button" onClick={() => startCreate(type)}
                data-channel-type={type} className={`mykey-channel-add mykey-channel--${sessionMeta(type).tone}`}
                title={type === 'mixin' ? '新增一条故障转移路由；可同时保留多条 mixin 配置' : `新增 ${sessionMeta(type).label} 渠道`}>
                <span aria-hidden="true">+</span><ChannelLabel type={type} />
              </button>
            ))}
          </div>
        </div>
        <div className="mykey-card-grid grid gap-3 md:grid-cols-2">
          {allEntries.map((entry, idx) => {
            const row = Math.floor(idx / 2)
            const expanded = openRows.has(row)
            return (
              <SessionCard key={entry.var} s={entry} expanded={expanded}
                deleting={deletingVar === entry.var}
                busy={deletingVar !== null}
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
                onDelete={() => { void remove(entry) }} />
            )
          })}
          {sessions.length === 0 && mixins.length === 0 && (
            <div className="md:col-span-2 text-ink-faint text-sm py-8 text-center border border-dashed border-line rounded-xl">
              尚未配置任何链路。点上方 <strong>+ Claude (native)</strong> 或 <strong>+ OpenAI (native)</strong> 添加第一条。
            </div>
          )}
        </div>
      </section>

      <GlobalsSection globals_={globals_} onWrite={onWrite} rawText={data.raw} onDirtyChange={onProxyDirtyChange} />

      {editor && editorMode && (
        <SessionDialog
          mode={editorMode}
          sourceVar={sourceVar}
          session={editor}
          allSessions={allEntries}
          onClose={() => { setEditor(null); setEditorMode(null); setSourceVar(null) }}
          onSaved={(r) => { onWrite(r); setEditor(null); setEditorMode(null); setSourceVar(null) }}
        />
      )}
    </div>
  )
}

function SessionCard({ s, expanded, deleting, busy, onToggle, onEdit, onDuplicate, onDelete }: {
  s: MyKeySession
  expanded: boolean
  deleting: boolean
  busy: boolean
  onToggle: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const meta = sessionMeta(s.type)
  const title = s.fields.name || s.var
  const canTest = s.type !== 'mixin'
  const [testing, setTesting] = useState(false)
  const testBusyRef = useRef(false)
  const [testResult, setTestResult] = useState<MyKeySessionTestResult | null>(null)
  const runTest = async () => {
    if (testBusyRef.current || busy) return
    testBusyRef.current = true
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.testMyKeySession(s.var)
      setTestResult(r)
    } catch (e: unknown) {
      setTestResult({ ok: false, error: errorMessageFromError(e) })
    } finally {
      testBusyRef.current = false
      setTesting(false)
    }
  }
  const cardTone = meta.tone
  const mixinTargets = s.fields.llm_nos || []
  const summary = s.type !== 'mixin'
    ? String(s.fields.model || '未设置模型')
    : (mixinTargets.join(' → ') || '未设置路由目标')

  return (
    <div data-channel-type={s.type} className={`mykey-card mykey-channel--${cardTone} mykey-card--${cardTone} ${expanded ? 'mykey-card--expanded' : ''}`}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'} ${title}`} className="mykey-card__toggle">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="mykey-card__badge"><ChannelLabel type={s.type} /></span>
              <span className="min-w-0 truncate text-sm leading-5 font-semibold text-ink">{title}</span>
            </div>
            {!expanded && (
              <div className="mt-1.5 flex items-center gap-2 min-w-0">
                <div className="mykey-card__dot" aria-hidden="true" />
                <div className="min-w-0 truncate text-xs leading-5 text-ink-faint font-medium" title={String(summary)}>
                  {String(summary)}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 pl-2">
            {expanded && s.lineno != null && (
              <span className="text-[11px] text-ink-faint font-mono">L{String(s.lineno)}</span>
            )}
            <span className="mykey-card__chevron" aria-hidden="true">
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="mykey-card__details">
          <div className={`grid gap-x-6 gap-y-3 ${s.type !== 'mixin' ? 'md:grid-cols-2' : ''}`}>
            {s.type !== 'mixin' ? (
              <dl className="space-y-1.5 text-xs">
                <KV k="model" v={s.fields.model} mono />
                <KV k="apibase" v={s.fields.apibase} mono />
                <KV k="apikey" v={s.fields.apikey} mono />
              </dl>
            ) : (
              <dl className="space-y-1.5 text-xs">
                <div className="flex items-start gap-2">
                  <dt className="text-ink-faint shrink-0 w-24">apis</dt>
                  <dd className="min-w-0 flex-1 font-mono text-ink break-all leading-5">
                    {Array.isArray(s.fields.llm_nos) && s.fields.llm_nos.length > 0 ? s.fields.llm_nos.join(' → ') : <span className="text-ink-faint">—</span>}
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
            <button type="button" onClick={onEdit} disabled={busy} className="ga-btn-sm-primary"><Pencil className="h-3 w-3" aria-hidden="true" /><span>编辑</span></button>
            <button type="button" onClick={onDuplicate} disabled={busy} className="ga-btn-sm"><CopyIcon size={12} /><span>复制</span></button>
            <button type="button" onClick={onDelete} disabled={busy} className="ga-btn-sm-danger"><Trash2 className="h-3 w-3" aria-hidden="true" /><span>{deleting ? '删除中…' : '删除'}</span></button>
            {canTest && (
              <button type="button" onClick={runTest} disabled={testing || busy} className="ga-btn-sm border-status-success-line/85 text-status-success hover:border-status-success/60 hover:bg-status-success-soft hover:text-status-success">
                <Play className="h-3 w-3" aria-hidden="true" />
                <span>{testing ? '测试中…' : '测 ping'}</span>
              </button>
            )}
          </div>
          {canTest && testResult && (
            <div className="mt-2 text-xs">
              {testResult.ok ? (
                <div className="space-y-0.5">
                  <div className="text-status-success">
                    ✓ {testResult.latency_ms ?? '?'} ms
                    {testResult.model && <span className="text-ink-faint ml-2 font-mono">{testResult.model}</span>}
                  </div>
                  {testResult.preview && (
                    <div className="text-ink-muted break-words font-mono leading-snug">→ {testResult.preview}</div>
                  )}
                </div>
              ) : (
                <div className="text-status-danger break-words font-mono leading-snug">✗ {testResult.error || '失败'}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: any; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-ink-faint shrink-0 w-24">{k}</dt>
      <dd className={`text-ink truncate ${mono ? 'font-mono' : ''}`} title={String(v ?? '')}>
        {v == null || v === '' ? <span className="text-ink-faint">—</span> : String(v)}
      </dd>
    </div>
  )
}

function sessionMeta(type: MyKeySessionType) {
  return SESSION_META[type]
}

// ── Edit / Create dialog ────────────────────────────────────────────
function SessionDialog({ mode, sourceVar, session, allSessions, onClose, onSaved }: {
  mode: 'create' | 'edit' | 'duplicate'
  sourceVar: string | null
  session: MyKeySession
  allSessions: MyKeySession[]
  onClose: () => void
  onSaved: (r: MyKeyWriteResult) => void
}) {
  const [s, setS] = useState<MyKeySession>(session)
  const [budgetDraft, setBudgetDraft] = useState<string>(() => String(session.fields.thinking_budget_tokens ?? 32768))
  const [varError, setVarError] = useState('')
  const [budgetError, setBudgetError] = useState('')
  const varRef = useRef<HTMLInputElement>(null)
  const budgetRef = useRef<HTMLInputElement>(null)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveBusyRef = useRef(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setS(session)
    setBudgetDraft(String(session.fields.thinking_budget_tokens ?? 32768))
    setVarError('')
    setBudgetError('')
    setErr(null)
  }, [session])

  const isDirty = s.var !== session.var || !fieldsEqual(s.fields, session.fields)
  const { requestClose } = useDirtyClose({ dirty: isDirty, busy: saving, onClose })

  const setField = (k: string, v: any) => setS({ ...s, fields: { ...s.fields, [k]: v } })

  const save = async () => {
    if (saveBusyRef.current) return
    let firstInvalid: HTMLElement | null = null
    let nextVarError = ''
    let nextBudgetError = ''
    if (!s.var.trim()) {
      nextVarError = '请填写变量名。'
      firstInvalid ??= varRef.current
    }
    if (s.fields.thinking_type === 'enabled') {
      const trimmedBudget = budgetDraft.trim()
      const parsedBudget = Number(trimmedBudget)
      if (!trimmedBudget || !Number.isInteger(parsedBudget) || parsedBudget < 1024) {
        nextBudgetError = 'thinking_budget_tokens 需为不小于 1024 的整数。'
        firstInvalid ??= budgetRef.current
      }
    }
    if (nextVarError || nextBudgetError) {
      setVarError(nextVarError)
      setBudgetError(nextBudgetError)
      firstInvalid?.focus()
      return
    }
    setVarError('')
    setBudgetError('')
    saveBusyRef.current = true
    setErr(null); setSaving(true)
    try {
      // Normalize empty strings to undefined for non-required fields.
      const fields = stripUiOnly(s.fields)
      const trimmedVar = s.var.trim()
      const action = mode === 'duplicate'
        ? 'duplicate'
        : mode === 'edit' && sourceVar && sourceVar !== trimmedVar
          ? 'rename'
          : mode === 'create' ? 'create' : 'update'
      const r = await api.mutateMyKey({
        action,
        var: action === 'duplicate' ? sourceVar ?? undefined : action === 'rename' ? sourceVar ?? undefined : trimmedVar,
        new_var: action === 'duplicate' || action === 'rename' ? trimmedVar : undefined,
        type: s.type,
        fields,
      })
      onSaved(r)
    } catch (e: unknown) {
      setErr(myKeyParseErrorFromError(e))
    } finally {
      saveBusyRef.current = false
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onClose={requestClose} closeOnBackdrop={false} panelClassName="p-6 w-[40rem] max-w-[92vw] max-h-[88vh] overflow-y-auto">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-base font-semibold">
          {mode === 'create' ? '新增链路' : mode === 'duplicate' ? '复制链路' : '编辑链路'}
          <span className="ml-2 text-xs text-ink-faint">{sessionMeta(s.type).label}</span>
        </h3>
        <CloseIconButton
          label="关闭弹窗"
          variant="ghost"
          iconSize={16}
          disabled={saving}
          onClick={requestClose}
          className="text-ink-muted hover:text-ink disabled:opacity-40"
        />
      </div>

      <Field label="变量名（mykey.py 里的 Python 变量）" hint="必须包含 api/config/cookie 之一及所选渠道关键字（oai、claude、mixin；原生渠道另需 native）。">
        <input
          ref={varRef}
          value={s.var}
          onChange={(e) => {
            setS({ ...s, var: e.target.value })
            if (varError) setVarError('')
          }}
          aria-invalid={Boolean(varError) || undefined}
          aria-describedby={varError ? 'mykey-var-error' : undefined}
          className={inp + ' font-mono'}
          placeholder="native_claude_xxx_config"
        />
        {varError && <p id="mykey-var-error" role="alert" className="ga-field-error">{varError}</p>}
      </Field>

      {s.type !== 'mixin' && (
        <>
          <Field label="name（链路展示名 & mixin 引用名）">
            <input value={s.fields.name ?? ''} onChange={(e) => setField('name', e.target.value)}
              className={inp} placeholder="如 claude / glm / gpt" />
          </Field>
          <Field label="apikey" hint={mode === 'create' ? undefined : '留空保留源配置的密钥'}>
            <div className="flex gap-2 items-stretch">
              <input
                value={s.fields.apikey ?? ''}
                onChange={(e) => setField('apikey', e.target.value)}
                type={showKey ? 'text' : 'password'}
                className={inp + ' font-mono flex-1'}
                placeholder={mode === 'edit' ? `当前: ${s.fields.apikey || '—'}` : 'sk-...'}
                autoComplete="off"
              />
              <button onClick={() => setShowKey(!showKey)} type="button" className="ga-btn shrink-0">
                {showKey ? (
                  <>
                    <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>隐藏</span>
                  </>
                ) : (
                  <>
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>显示</span>
                  </>
                )}
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
            <select
              value={s.fields.thinking_type ?? ''}
              onChange={(e) => {
                const nextType = e.target.value || undefined
                setField('thinking_type', nextType)
                if (nextType === 'enabled' && !budgetDraft.trim()) {
                  setBudgetDraft(String(s.fields.thinking_budget_tokens ?? 32768))
                }
                if (nextType !== 'enabled' && budgetError) {
                  setBudgetError('')
                }
              }}
              className={`${inp} ga-select`}
            >
              <option value="">（不设置）</option>
              <option value="adaptive">adaptive（推荐）</option>
              <option value="enabled">enabled（需配 thinking_budget_tokens）</option>
              <option value="disabled">disabled</option>
            </select>
          </Field>
          {s.fields.thinking_type === 'enabled' && (
            <Field label="thinking_budget_tokens">
              <input
                ref={budgetRef}
                type="number"
                min={1024}
                aria-label="thinking_budget_tokens"
                value={budgetDraft}
                aria-invalid={Boolean(budgetError) || undefined}
                aria-describedby={budgetError ? 'mykey-budget-error' : undefined}
                onChange={(e) => {
                  const raw = e.target.value
                  setBudgetDraft(raw)
                  if (budgetError) setBudgetError('')
                  if (raw.trim() === '') {
                    setField('thinking_budget_tokens', undefined)
                    return
                  }
                  const parsed = Number.parseInt(raw, 10)
                  if (Number.isFinite(parsed)) setField('thinking_budget_tokens', parsed)
                }}
                className={inp}
              />
              {budgetError && <p id="mykey-budget-error" role="alert" className="ga-field-error">{budgetError}</p>}
            </Field>
          )}
          <Field label="fake_cc_system_prompt">
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!s.fields.fake_cc_system_prompt}
                onChange={(e) => setField('fake_cc_system_prompt', e.target.checked || undefined)} />
              <span className="text-ink">CC switch / 反代渠道必须勾选</span>
            </label>
          </Field>
        </>
      )}

      {(s.type === 'native_oai' || s.type === 'oai') && (
        <>
          <Field label="api_mode">
            <select value={s.fields.api_mode ?? 'chat_completions'} onChange={(e) => setField('api_mode', e.target.value)} className={`${inp} ga-select`}>
              <option value="chat_completions">chat_completions（默认）</option>
              <option value="responses">responses（OpenAI Responses API）</option>
            </select>
          </Field>
          <Field label="reasoning_effort">
            <select value={s.fields.reasoning_effort ?? ''} onChange={(e) => setField('reasoning_effort', e.target.value || undefined)} className={`${inp} ga-select`}>
              <option value="">（不设置）</option>
              {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
        </>
      )}

      {s.type === 'mixin' && <MixinFields s={s} setS={setS} allSessions={allSessions} />}

      <details className="mt-3">
        <summary className="text-xs text-ink-muted cursor-pointer">高级（max_retries / read_timeout / temperature / max_tokens / context_win / proxy）</summary>
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
              <span className="text-ink">默认开启；遇 SSE 截断关掉保命</span>
            </label>
          </Field>
        </div>
      </details>

      {err && <div role="alert" className="mt-3 text-xs text-status-danger bg-status-danger-soft border border-status-danger-line rounded p-2 break-words">{err}</div>}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={requestClose} disabled={saving} className="ga-btn">取消</button>
        <button type="button" onClick={save} disabled={saving} className="ga-btn-primary">
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{saving ? '保存中…' : '保存并应用'}</span>
        </button>
      </div>
    </ModalOverlay>
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
              }} list="mixin-name-candidates" className={inp + ' font-mono flex-1'} />
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="上移" title="上移"
                className="ga-btn-icon"><ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === llmNos.length - 1} aria-label="下移" title="下移"
                className="ga-btn-icon"><ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
              <CloseIconButton
                label={`移除 ${n || `第 ${i + 1} 项`}`}
                variant="compact"
                iconSize={14}
                onClick={() => setNos(llmNos.filter((_, k) => k !== i))}
                className="px-2 py-1.5 rounded border border-status-danger-line text-status-danger hover:bg-status-danger-soft"
              />
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
                  className="ga-btn-chip"
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
function GlobalsSection({ globals_, onWrite, rawText, onDirtyChange }: {
  globals_: Record<string, any>
  onWrite: (r: MyKeyWriteResult) => void
  rawText: string
  onDirtyChange?: (dirty: boolean) => void
}) {
  // Just render as a read-only summary; encourage the raw tab for editing.
  // proxy is the most-common one — we surface it as an inline editor.
  const [proxy, setProxy] = useState<string>(typeof globals_.proxy === 'string' ? globals_.proxy : '')
  const [saving, setSaving] = useState(false)
  const incoming = typeof globals_.proxy === 'string' ? globals_.proxy : ''
  const [baseline, setBaseline] = useState(incoming)
  const dirty = proxy !== baseline
  const conflict = dirty && incoming !== baseline
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    if (incoming === proxy) {
      setBaseline(incoming)
    } else if (!dirty) {
      setProxy(incoming)
      setBaseline(incoming)
    }
  }, [incoming, dirty, proxy])

  const saveProxy = async () => {
    setSaving(true)
    try {
      const r = await api.mutateMyKey({
        action: 'proxy', fields: { proxy }, expected_raw: rawText,
      })
      setProxy(proxy.trim())
      onWrite(r)
    } catch (e: any) {
      dialog.alert('保存失败', errorMessageFromError(e))
    } finally {
      setSaving(false)
    }
  }

  const otherGlobals = Object.entries(globals_).filter(([k]) => k !== 'proxy')

  return (
    <section className="mt-auto">
      <h2 className="text-sm font-semibold text-ink mb-3">全局配置</h2>
      <div className="rounded-xl border border-line bg-bg-card p-4 space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <div className="text-xs text-ink-faint mb-1">proxy（所有未单独指定的 session 共用）</div>
            <input value={proxy} onChange={(e) => setProxy(e.target.value)}
              className={inp + ' font-mono'} placeholder="http://127.0.0.1:7890（留空禁用）" />
          </div>
          <button type="button" onClick={saveProxy} disabled={!dirty || saving || conflict}
            className="ga-btn-primary">
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{saving ? '保存中…' : '保存 proxy'}</span>
          </button>
        </div>
        {conflict && <p role="alert" className="text-sm text-status-warning flex items-center gap-2 flex-wrap">
          <span>proxy 已被外部更新；草稿已保留。</span>
          <button type="button" className="ga-btn-warning-sm" onClick={() => { setProxy(incoming); setBaseline(incoming) }}>使用最新值</button>
        </p>}
        {otherGlobals.length > 0 && (
          <details>
            <summary className="text-xs text-ink-muted cursor-pointer">其它全局变量（{otherGlobals.length}）— 在「原始」tab 编辑</summary>
            <dl className="pt-2 space-y-1 text-xs">
              {otherGlobals.map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-2">
                  <dt className="text-ink-faint font-mono w-44 shrink-0">{k}</dt>
                  <dd className="text-ink font-mono truncate" title={JSON.stringify(v)}>
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

// ── helpers ─────────────────────────────────────────────────────────
const inp = 'w-full bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent text-ink'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-xs text-ink-faint mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-ink-faint mt-1">{hint}</div>}
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
        onChange={(e) => {
          if (e.target.value === '') { onChange(undefined); return }
          const parsed = step ? parseFloat(e.target.value) : parseInt(e.target.value, 10)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        className={inp}
        placeholder="（默认）"
      />
    </Field>
  )
}

function defaultVarName(type: MyKeySessionType, existing: MyKeySession[]): string {
  const base =
    type === 'native_claude' ? 'native_claude_config' :
      type === 'native_oai' ? 'native_oai_config' :
        type === 'mixin' ? 'mixin_config' :
          type === 'claude' ? 'oai_claude_config' :
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
    if (v === undefined) continue
    if (typeof v === 'string' && v.trim() === '' && k !== 'apikey') continue
    out[k] = v
  }
  return out
}

function fieldsEqual(a: Record<string, any>, b: Record<string, any>): boolean {
  const na = stripUiOnly(a)
  const nb = stripUiOnly(b)
  if ((na.apikey ?? '') === '' && (nb.apikey ?? '') === '') {
    delete na.apikey
    delete nb.apikey
  }
  const keysA = Object.keys(na).sort()
  const keysB = Object.keys(nb).sort()
  if (keysA.length !== keysB.length) return false
  return keysA.every((k, i) => k === keysB[i] && JSON.stringify(na[k]) === JSON.stringify(nb[k]))
}
