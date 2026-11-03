import { useEffect, useState } from 'react'
import { novaApi, type NovaStatus } from '@/api/client'

export function NovaSettingsPanel() {
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
    let alive = true
    const refresh = () => novaApi.status().then(s => { if (alive) setStatus(s) })
      .catch(() => { if (alive) setError('无法读取 Nova 本机状态') })
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

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
  const inputClass = 'w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-sm'
  return <section className="rounded-lg border border-white/10 bg-panel p-4 space-y-3" aria-label="Nova 远程连接">
    <h2 className="font-medium">Nova 远程连接</h2>
    <p className="text-xs text-slate-400">在此注册或登录账号并关联本机，无需打开网页。原有隧道不受影响。</p>
    {!status ? <p>正在读取本机状态…</p> : <>
      <div className="text-sm">固定设备码：<code className="select-text">{status.device || '不可用'}</code></div>
      <div className="text-sm">{status.paired ? '已关联账号' : '未关联账号'} · {status.running ? '连接器运行中' : '连接器未运行'}</div>
      <p className="text-xs text-slate-500">这是持久化设备标识，不是硬件指纹。正常更新或重打包不会改变；更换系统用户或删除本机数据可能改变。运行中不等于云端已确认在线。</p>
      {status.error && <p role="alert" className="text-status-warning">连接器错误：{status.error}</p>}
      {status.paired && <div className="flex gap-3">
        <button type="button" disabled={busy} onClick={() => void act('reconnect')} className="text-sm text-sky-400">重新连接</button>
        <button type="button" disabled={busy} onClick={() => { setRevoking(!revoking); setConfirmed(false) }} className="text-sm text-slate-400">{revoking ? '取消撤销' : '撤销账号关联'}</button>
      </div>}
      {showAccount && <form className="space-y-3" onSubmit={e => { e.preventDefault(); void act(revoking ? 'revoke' : 'associate') }}>
        {!revoking && <label className="flex gap-2 text-sm"><input type="checkbox" checked={register} disabled={busy} onChange={e => setRegister(e.target.checked)} />我还没有账号（邀请注册）</label>}
        <label className="block text-sm">账号<input className={inputClass} required minLength={3} maxLength={100} autoComplete="username" value={username} disabled={busy} onChange={e => setUsername(e.target.value)} /></label>
        <label className="block text-sm">密码<input className={inputClass} type="password" required minLength={10} maxLength={256} autoComplete={register ? 'new-password' : 'current-password'} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
        {!revoking && register && <label className="block text-sm">邀请码<input className={inputClass} type="password" required value={invite} disabled={busy} onChange={e => setInvite(e.target.value)} /></label>}
        {!revoking && <label className="block text-sm">电脑名称<input className={inputClass} required maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />{revoking ? '确认撤销云端授权并清除本机绑定（保留设备码）' : '允许此账号通过 Nova 远程操作这台电脑'}</label>
        <p className="text-xs text-slate-500">密码仅用于本次操作，不保存。{revoking ? '需要当前设备所属账号的密码。' : '关联凭据保存在 Windows 凭据管理器中。'}</p>
        <button type="submit" disabled={busy || !confirmed || !status.device} className="rounded bg-sky-600 px-3 py-2 text-sm disabled:opacity-40">{busy ? '处理中…' : revoking ? '确认撤销关联' : register ? '注册并关联本机' : '登录并关联本机'}</button>
      </form>}
    </>}
    {error && <p role="alert" className="text-status-warning">{error}</p>}
    {message && <p role="status" className="text-status-success">{message}</p>}
  </section>
}
