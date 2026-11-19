import { useEffect, useState } from 'react'
import { novaApi, type NovaStatus } from '@/api/client'

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
  const [name, setName] = useState('GA-Hub')
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!active) return
    let alive = true
    const refresh = () => novaApi.status().then(s => { if (alive) setStatus(s) })
      .catch(() => { if (alive) setError('无法读取 Nova 本机状态') })
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [active])

  const act = async (action: 'associate' | 'revoke' | 'reconnect') => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await novaApi.action(action, action === 'reconnect' ? undefined : {
        username, password, name, confirm: confirmed,
        ...(register && action === 'associate' ? { invite } : {}),
      })
      setStatus(result); setRevoking(false); setConfirmed(false)
      setMessage(action === 'revoke' ? '云端授权已撤销，本机绑定已清除；固定设备码保留。'
        : action === 'associate' ? '账号关联完成。以后 Nova 将随 GA-Hub 自动启动。' : '已请求重连。')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nova 操作失败')
    } finally {
      setPassword(''); setInvite(''); setBusy(false)
    }
  }
  const showAccount = status && (!status.paired || revoking)
  const inputClass = 'mt-1.5 w-full min-w-0 rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50'
  const secondaryButtonClass = 'rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-ink/5 disabled:opacity-40'
  return <section className="rounded-xl border border-line bg-bg-card p-4 space-y-4" aria-label="Nova 远程连接">
    <header>
      <h2 className="font-medium">远程连接 <span className="ml-1 text-xs font-normal text-ink-faint">Nova</span></h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">关联账号后，即可通过 Nova 远程访问这台电脑。</p>
    </header>
    {!status ? <p className="text-sm text-ink-muted" role="status">正在读取本机状态…</p> : <>
      <div className="rounded-lg border border-line bg-bg-soft/60 p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-md px-2 py-1 ${status.paired ? 'bg-status-success-soft text-status-success' : 'border border-line bg-bg-card text-ink-muted'}`}>{status.paired ? '已关联账号' : '未关联账号'}</span>
          <span className="text-ink-muted">{status.running ? '连接器运行中' : '连接器未运行'}</span>
        </div>
        <dl className="flex flex-col gap-1 text-xs sm:flex-row sm:items-start sm:gap-3">
          <dt className="shrink-0 text-ink-faint">设备码</dt>
          <dd className="min-w-0"><code className="select-text break-all font-mono text-ink">{status.device || '不可用'}</code></dd>
        </dl>
      </div>
      {status.error && <p role="alert" className="break-words text-sm text-status-warning">连接器错误：{status.error}</p>}
      {status.paired && <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void act('reconnect')} className={secondaryButtonClass}>重新连接</button>
        <button type="button" disabled={busy} onClick={() => { setRevoking(!revoking); setConfirmed(false) }} className={secondaryButtonClass}>{revoking ? '取消撤销' : '撤销账号关联'}</button>
      </div>}
      {showAccount && <form className="space-y-4 border-t border-line pt-4" onSubmit={e => { e.preventDefault(); void act(revoking ? 'revoke' : 'associate') }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{revoking ? '撤销关联' : register ? '注册并关联' : '关联账号'}</h3>
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
          <button type="submit" disabled={busy || !confirmed || !status.device} className={`shrink-0 rounded-lg px-4 py-2 text-sm ${revoking ? 'ga-solid-danger' : 'ga-solid-primary'}`}>{busy ? '处理中…' : revoking ? '确认撤销关联' : register ? '注册并关联本机' : '登录并关联本机'}</button>
          <p className="text-xs text-ink-faint">密码仅用于本次验证，不作保存。</p>
        </div>
      </form>}
      <details className="border-t border-line pt-3 text-xs text-ink-faint">
        <summary className="w-fit cursor-pointer text-ink-muted hover:text-ink">连接与安全说明</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-4 leading-relaxed">
          <li>关联后将随 GA-Hub 自动启动。</li>
          <li>关联凭据保存在 Windows 凭据管理器中。</li>
          <li>设备码为本机标识，升级软件不会改变。</li>
        </ul>
      </details>
    </>}
    {error && <p role="alert" className="break-words text-sm text-status-warning">{error}</p>}
    {message && <p role="status" className="text-sm text-status-success">{message}</p>}
  </section>
}
