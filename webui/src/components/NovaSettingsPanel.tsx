import { useEffect, useState } from 'react'
import { novaApi, type NovaStatus } from '@/api/client'
import { RefreshIcon, ShieldCheck, Unlink, X } from './ActionIcons'

export function NovaSettingsPanel({ active = true }: { active?: boolean } = {}) {
  const [status, setStatus] = useState<NovaStatus | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [register, setRegister] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [name, setName] = useState('Gyra')
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!active) return
    let alive = true
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void novaApi.status().then(s => { if (alive) setStatus(s) })
        .catch(() => { if (alive) setError('无法读取 Nova 本机状态') })
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])

  const act = async (action: 'associate' | 'revoke' | 'reconnect' | 'pause' | 'resume') => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await novaApi.action(
        action,
        action === 'associate' || action === 'revoke'
          ? {
              username, password, name, confirm: confirmed,
              ...(register && action === 'associate' ? { invite } : {}),
            }
          : undefined,
      )
      setStatus(result); setRevoking(false); setConfirmed(false)
      setMessage(action === 'revoke' ? '云端授权已撤销，本机绑定已清除；固定设备码保留。'
        : action === 'associate' ? '账号关联完成。以后 Nova 将随 Gyra 自动启动。'
        : action === 'pause' ? '已暂停远程连接。'
        : action === 'resume' ? '已恢复远程连接。'
        : '已请求重连。')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nova 操作失败')
    } finally {
      setPassword(''); setInvite(''); setBusy(false)
    }
  }
  const showAccount = status && (!status.paired || revoking)
  const runtimeLabel = !status ? ''
    : status.paused ? '连接器已暂停'
    : status.running && status.connected === true ? `连接器运行中 · 已连接云端${typeof status.rtt_ms === 'number' ? ` · ${status.rtt_ms}ms` : ''}`
    : status.running && status.connected === false ? '连接器运行中 · 正在连接云端'
    : status.running ? '连接器运行中'
    : '连接器未运行'
  const inputClass = 'mt-1.5 w-full min-w-0 rounded-lg border border-line/80 bg-bg-soft/75 px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:bg-bg-card focus:ring-1 focus:ring-accent disabled:opacity-50'
  return <section className="ga-paper-card p-4 space-y-4" aria-label="Nova 远程连接">
    <header>
      <h2 className="text-sm font-semibold text-ink">远程连接 <span className="ml-1 text-xs font-normal text-ink-faint">Nova</span></h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">关联账号后，即可通过 Nova 远程访问这台电脑。</p>
    </header>
    {!status ? <p className="text-sm text-ink-muted" role="status">正在读取本机状态…</p> : <>
      <div className="ga-paper-subcard p-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${status.paired ? 'bg-status-success-soft text-status-success' : 'bg-bg-card text-ink-muted ring-1 ring-line/45'}`}>{status.paired ? '已关联账号' : '未关联账号'}</span>
          <span className="text-ink-muted">{runtimeLabel}</span>
          {status.paired && status.device_name && <span className="text-ink-faint">({status.device_name})</span>}
        </div>
        <dl className="flex flex-col gap-1 text-xs sm:flex-row sm:items-start sm:gap-3">
          <dt className="shrink-0 text-ink-faint">设备码</dt>
          <dd className="min-w-0"><code className="select-text break-all font-mono text-ink">{status.device || '不可用'}</code></dd>
        </dl>
      </div>
      {(status.error_detail || status.error) && <p role="alert" className="break-words text-sm text-status-warning">连接器错误：{status.error_detail || status.error}</p>}
      {status.paired && <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void act('reconnect')} className="ga-btn">
          <RefreshIcon spinning={busy} size={13} />
          <span>重新连接</span>
        </button>
        <button type="button" disabled={busy} onClick={() => void act(status.paused ? 'resume' : 'pause')} className="ga-btn">
          <span>{status.paused ? '恢复连接' : '暂停连接'}</span>
        </button>
        <button type="button" disabled={busy} onClick={() => { setRevoking(!revoking); setConfirmed(false) }} className={revoking ? 'ga-btn' : 'ga-btn-danger-outline'}>
          {revoking ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlink className="h-3.5 w-3.5" aria-hidden="true" />}
          <span>{revoking ? '取消撤销' : '撤销账号关联'}</span>
        </button>
      </div>}
      {showAccount && <form className="space-y-4 border-t border-line/45 pt-4" onSubmit={e => { e.preventDefault(); void act(revoking ? 'revoke' : 'associate') }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{revoking ? '撤销关联' : register ? '注册并关联' : '关联账号'}</h3>
          {!revoking && <label className="flex items-center gap-2 text-xs text-ink-muted"><input type="checkbox" checked={register} disabled={busy} onChange={e => setRegister(e.target.checked)} />没有账号？邀请注册</label>}
        </div>
        {revoking && <p className="text-xs leading-relaxed text-ink-muted">请输入已关联账号的凭据。撤销后将无法通过该账号远程访问本机。</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="min-w-0 text-sm text-ink">账号<input className={inputClass} required minLength={3} maxLength={100} autoComplete="username" value={username} disabled={busy} onChange={e => setUsername(e.target.value)} /></label>
          <label className="min-w-0 text-sm text-ink">密码<input className={inputClass} type="password" required minLength={10} maxLength={256} autoComplete={register && !revoking ? 'new-password' : 'current-password'} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
          {!revoking && <label className="min-w-0 text-sm text-ink">电脑名称<input className={inputClass} required maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>}
          {!revoking && register && <label className="min-w-0 text-sm text-ink">邀请码<input className={inputClass} type="password" required value={invite} disabled={busy} onChange={e => setInvite(e.target.value)} /></label>}
        </div>
        <label className="flex items-start gap-2 text-xs leading-relaxed text-ink"><input className="mt-0.5 shrink-0" type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />{revoking ? '确认撤销授权并清除本机绑定，保留设备码' : '允许此账号通过 Nova 远程操作这台电脑'}</label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <button type="submit" disabled={busy || !confirmed || !status.device} className={`shrink-0 px-4 ${revoking ? 'ga-btn-danger' : 'ga-btn-primary'}`}>
            {revoking ? <Unlink className="h-3.5 w-3.5" aria-hidden="true" /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{busy ? '处理中…' : revoking ? '确认撤销关联' : register ? '注册并关联本机' : '登录并关联本机'}</span>
          </button>
          <p className="text-xs text-ink-faint">密码仅用于本次验证，不作保存。</p>
        </div>
      </form>}
      <details className="border-t border-line/40 pt-3 text-xs text-ink-faint">
        <summary className="w-fit cursor-pointer text-ink-muted hover:text-ink">连接与安全说明</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-4 leading-relaxed">
          <li>关联后将随 Gyra 自动启动。</li>
          <li>关联凭据保存在 Windows 凭据管理器中。</li>
          <li>设备码为本机标识，升级软件不会改变。</li>
        </ul>
      </details>
      {status.diagnostics && <details className="border-t border-line/40 pt-3 text-xs text-ink-faint">
        <summary className="w-fit cursor-pointer text-ink-muted hover:text-ink">链路诊断</summary>
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-muted">
            <span>协议：{status.diagnostics.protocol ? `v${status.diagnostics.protocol}` : '未握手'}</span>
            {status.connector_version && <span>连接器：{status.connector_version}</span>}
            {status.diagnostics.credential_backend && <span>凭据后端：{status.diagnostics.credential_backend}</span>}
            <span>活跃流：HTTP {status.diagnostics.active_http ?? 0} / WS {status.diagnostics.active_ws ?? 0}</span>
            <span>重连：{status.diagnostics.reconnect_count ?? 0} 次</span>
            <span>流量：↓{((status.diagnostics.bytes_in ?? 0) / 1024).toFixed(1)} KB / ↑{((status.diagnostics.bytes_out ?? 0) / 1024).toFixed(1)} KB</span>
          </div>
          {!!status.diagnostics.capabilities?.length && <p className="break-all text-[11px]">能力：{status.diagnostics.capabilities.join(', ')}</p>}
          {!!status.diagnostics.events?.length && <ul className="max-h-36 space-y-1 overflow-y-auto rounded-lg bg-bg-soft/60 p-2 font-mono text-[11px]">
            {status.diagnostics.events.slice(-15).reverse().map((ev, i) => (
              <li key={`${ev.ts}-${i}`}>{new Date(ev.ts * 1000).toLocaleTimeString('zh-CN', {hour12: false})} [{ev.level}] {ev.event}{ev.detail ? ` · ${ev.detail}` : ''}</li>
            ))}
          </ul>}
        </div>
      </details>}
    </>}
    {error && <p role="alert" className="break-words text-sm text-status-warning">{error}</p>}
    {message && <p role="status" className="text-sm text-status-success">{message}</p>}
  </section>
}
