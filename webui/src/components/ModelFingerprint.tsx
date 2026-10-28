import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { ModalOverlay } from './ModalOverlay'

export interface FingerprintJob {
  id: string
  status: 'queued' | 'sampling' | 'analyzing' | 'completed' | 'failed'
  completed_samples: number
  target: { llm_key: string; model: string; api_mode: string; temperature: number; max_tokens: number | null }
  error?: string
  result?: { bank_built_at: string; analysis: {
    prediction_name: string
    diagnostics: { parsed_numbers: number; accepted: boolean }[]
    results: { model: string; display_name: string; probability: number | null }[]
    evidence: { reason: string }
  } }
}

export function ModelFingerprint({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [job, setJob] = useState<FingerprintJob | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const active = !!job && ['queued', 'sampling', 'analyzing'].includes(job.status)
  useEffect(() => {
    if (!active || !job) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.getModelFingerprint(sessionId, job.id)
        if (stopped) return
        setJob(next)
        setError('')
        if (['queued', 'sampling', 'analyzing'].includes(next.status)) timer = setTimeout(poll, 1500)
      } catch {
        if (!stopped) {
          setError('暂时无法读取状态；后台检测未取消，正在重连。')
          timer = setTimeout(poll, 5000)
        }
      }
    }
    timer = setTimeout(poll, 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [sessionId, job?.id, active])
  const startLock = useRef(false)
  async function start() {
    if (disabled || active || startLock.current) return
    startLock.current = true
    setStarting(true)
    setError('')
    try { setJob(await api.startModelFingerprint(sessionId)) }
    catch (e) { setError(e instanceof Error ? e.message : '启动失败') }
    finally { startLock.current = false; setStarting(false) }
  }
  const busy = starting || active
  const label = busy ? '模型指纹：查看检测进度' : job ? '模型指纹：查看检测结果' : '模型指纹：点击开始检测（独立采样 3 次，消耗 API 额度）'
  return <>
    <button
      className={`relative mx-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-35 ${busy ? 'border-accent/60 bg-accent/10 text-accent' : 'border-line bg-bg-soft/95 text-ink-faint hover:border-accent/60 hover:bg-bg-card hover:text-accent'}`}
      type="button" disabled={disabled} title={label} aria-label={label} aria-haspopup="dialog"
      onClick={() => { setOpen(true); if (!job) void start() }}
    >
      <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4.5 8.5a8 8 0 0 1 15 2M3 12v2m18-1v1a19 19 0 0 1-.7 5M6 14v-3a6 6 0 0 1 12 0v3a17 17 0 0 1-1.4 7M5.5 18a13 13 0 0 0 .5-4M9 20a16 16 0 0 0 1-6v-3a2 2 0 0 1 4 0v3a21 21 0 0 1-1.2 7M12 11v3a18 18 0 0 1-.2 3M8.5 7.5A4 4 0 0 1 16 9" />
      </svg>
      {busy && <span className="absolute right-0 top-0 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-bg-card bg-accent" aria-hidden="true" />}
    </button>
    {open && <ModalOverlay onClose={() => setOpen(false)} labelledBy="fingerprint-title" panelClassName="p-5 w-full max-w-lg rounded-2xl">
      <h2 id="fingerprint-title" className="text-lg font-semibold text-ink">检测当前 Chat 模型</h2>
      <p className="mt-2 text-sm text-ink-faint">使用启动时绑定的模型独立采样 3 次，会消耗 API 额度，可能需要数分钟。不会发送聊天记录、系统提示词或工具，也不会修改当前聊天。</p>
      <p className="mt-2 text-sm text-ink-faint">模型凭据仅在 GA 后端使用；CF 评分端只接收提取的数字样本。结果是参考库内的统计相似度，不是模型真伪证明；库外模型也会得到排名。</p>
      {job && <div className="mt-4 text-sm text-ink">
        <p>采样模型：{job.target.model || job.target.llm_key}</p>
        <p>状态：{({ queued: '排队中', sampling: '采样中', analyzing: '评分中', completed: '完成', failed: '失败' })[job.status]} · {job.completed_samples}/3</p>
        {job.error && <p role="alert">{job.error}</p>}
        {job.result && <>
          <p className="mt-3 font-medium">参考库候选（非身份认证）</p>
          <p>{job.result.analysis.prediction_name}</p>
          <ol className="mt-1 list-decimal pl-5">{job.result.analysis.results.slice(0, 5).map(item => <li key={item.model}>{item.display_name}{item.probability != null ? ` · 库内相对概率 ${(item.probability * 100).toFixed(1)}%` : ''}</li>)}</ol>
          <p className="mt-2 text-ink-faint">{job.result.analysis.evidence.reason}</p>
          <p className="mt-1 text-ink-faint">有效数字：{job.result.analysis.diagnostics.filter(d => d.accepted).reduce((sum, d) => sum + d.parsed_numbers, 0)}；参考库：{job.result.bank_built_at}</p>
        </>}
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-status-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="ga-btn" onClick={() => setOpen(false)}>关闭{busy ? '（后台继续）' : ''}</button>
        <button className="ga-btn ga-btn-primary" disabled={disabled || active || starting} onClick={() => void start()}>{starting ? '启动中…' : active ? '检测进行中' : job ? '重新采样（消耗额度）' : '确认采样（消耗额度）'}</button>
      </div>
    </ModalOverlay>}
  </>
}
