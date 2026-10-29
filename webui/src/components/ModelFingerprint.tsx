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
  const [confirming, setConfirming] = useState(false)
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
    try {
      setJob(await api.startModelFingerprint(sessionId))
      setConfirming(false)
    }
    catch (e) { setError(e instanceof Error ? e.message : '启动失败') }
    finally { startLock.current = false; setStarting(false) }
  }
  const busy = starting || active
  const label = busy ? '模型指纹：查看检测进度' : job ? '模型指纹：查看检测结果' : '模型指纹：使用说明与采样确认'
  const needsConfirmation = confirming && !busy
  const dismiss = () => { setOpen(false); setConfirming(false) }
  return <>
    <button
      className={`relative mx-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-35 ${busy ? 'border-accent/60 bg-accent/10 text-accent' : 'border-line bg-bg-soft/95 text-ink-faint hover:border-accent/60 hover:bg-bg-card hover:text-accent'}`}
      type="button" disabled={disabled} title={label} aria-label={label} aria-haspopup="dialog"
      onClick={() => { setConfirming(!job && !busy); setError(''); setOpen(true) }}
    >
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7.2 5.7A12.6 12.6 0 0 1 16 2.5c7 0 12.5 5.4 12.5 12.3" />
        <path d="M4.7 8.8a12 12 0 0 0-1.2 5.5v3.2m25-1.1c0 2.5-.2 4.7-.7 6.9" />
        <path d="M6.5 21.9c.5-2.3.4-4.8.4-7.1A9.1 9.1 0 0 1 16 5.7c5.1 0 9.1 4 9.1 9.1 0 4.8-.3 8.6-1.6 12" />
        <path d="M10 9.8a6.4 6.4 0 0 1 12.1 3c0 6.6-.1 11-2.4 16" />
        <path d="M8.4 26.7c1.8-4.2 1.5-8.3 1.5-12.1 0-.8.1-1.4.3-2" />
        <path d="M12 28.7c2.2-4.7 1.2-10.3 1.2-14a2.8 2.8 0 0 1 5.6 0v4.8" />
        <path d="M18.5 22.5a24 24 0 0 1-2.1 7" />
        <path d="M16 14.6v4.5c0 1.9-.1 3.5-.4 4.9" />
      </svg>
      {busy && <span className="absolute right-0 top-0 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-bg-card bg-accent" aria-hidden="true" />}
    </button>
    {open && <ModalOverlay onClose={dismiss} labelledBy="fingerprint-title" panelClassName="p-5 w-full max-w-lg max-h-[85dvh] overflow-y-auto rounded-2xl">
      <p className="text-xs font-medium tracking-widest text-accent">模型指纹 · {needsConfirmation ? '使用确认' : '检测详情'}</p>
      <h2 id="fingerprint-title" className="mt-1 text-lg font-semibold text-ink">{needsConfirmation ? '开始检测前请确认' : '检测当前 Chat 模型'}</h2>
      {needsConfirmation ? <>
        <div className="mt-4 rounded-xl border border-accent/25 bg-accent/5 p-3.5">
          <p className="text-sm font-semibold text-ink">独立采样 3 次，会产生模型 API 费用</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-faint">使用点击确认时当前 Chat 绑定的模型，通常需要数分钟。费用由模型服务商按用量计收，无法预估固定金额。</p>
        </div>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-faint">
          <li><strong className="font-medium text-ink">不影响聊天：</strong>创建独立采样会话，不读取聊天记录、系统提示词或工具，也不修改当前聊天。</li>
          <li><strong className="font-medium text-ink">仅上传数字：</strong>模型地址与 Key 留在本机；CF 评分端只接收数字样本。</li>
          <li><strong className="font-medium text-ink">结果仅供参考：</strong>排名是参考库内统计相似度，不是模型真伪或身份认证。</li>
          <li><strong className="font-medium text-ink">启动后后台继续：</strong>关闭窗口不会取消；失败也可能消耗部分额度，不会自动重试。</li>
        </ul>
      </> : <p className="mt-2 text-sm leading-relaxed text-ink-faint">独立采样 3 次，CF 仅接收数字样本。结果仅为参考库内统计相似度。关闭窗口不会取消后台任务。</p>}
      {!needsConfirmation && job && <div className="mt-4 text-sm text-ink">
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
        <button className="ga-btn" onClick={() => { if (needsConfirmation && job) { setConfirming(false); setError('') } else dismiss() }}>{needsConfirmation ? '取消' : busy ? '关闭（后台继续）' : '关闭'}</button>
        <button className="ga-btn ga-btn-primary" disabled={disabled || busy} onClick={() => { if (needsConfirmation) void start(); else { setError(''); setConfirming(true) } }}>{starting ? '启动中…' : active ? '检测进行中' : needsConfirmation ? '确认并开始检测' : '重新采样'}</button>
      </div>
    </ModalOverlay>}
  </>
}
