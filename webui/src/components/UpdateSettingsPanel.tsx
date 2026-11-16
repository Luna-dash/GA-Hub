import { useEffect, useState } from 'react'
import { updateApi, type UpdateStatus } from '@/api/client'

export function UpdateSettingsPanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [archive, setArchive] = useState('')
  const [sha256, setSha256] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = () => { void updateApi.status().then(value => { if (alive) setStatus(value) })
      .catch(() => { if (alive) setError('当前运行版本尚未提供更新接口，请先安装支持自更新的版本。') }) }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  async function act(cancel = false) {
    setBusy(true); setError('')
    try {
      if (cancel) await updateApi.cancel(status!.plan.id!)
      else await updateApi.prepare(archive.trim(), sha256.trim(), trusted)
      setStatus(await updateApi.status())
    } catch (e) { setError(e instanceof Error ? e.message : '更新准备失败') }
    finally { setBusy(false) }
  }
  async function handoff(approve: boolean) {
    setBusy(true); setError('')
    try {
      if (approve) await updateApi.approve(status!.plan.id!)
      else {
        await updateApi.preflight(status!.plan.id!)
        await updateApi.request(status!.plan.id!)
      }
      setStatus(await updateApi.status())
    } catch (e) { setError(e instanceof Error ? e.message : '交接失败') }
    finally { setBusy(false) }
  }
  const inputClass = 'w-full rounded-lg border border-line bg-black/20 px-3 py-2 text-sm'
  return <section className="rounded-xl border border-line bg-bg-card p-4 space-y-3" aria-label="桌面程序更新">
    <h2 className="font-medium">桌面程序更新</h2>
    <p className="text-sm text-amber-300">先在线准备候选包，再唤醒独立执行器；就绪后需再次确认，固定60秒倒计时结束后正常关闭并切换。不会等待所有会话空闲。</p>
    <p className="text-sm text-slate-400">仅接受可信来源的 Windows 便携发布包。校验和用于完整性验证，不能代替来源认证。准备不会退出或覆盖当前程序。</p>
    <label className="block text-sm">本机 ZIP 完整路径
      <input className={inputClass} value={archive} onChange={e => setArchive(e.target.value)} placeholder="D:\\Downloads\\GA-Hub-version-windows-x64.zip" disabled={busy} />
    </label>
    <label className="block text-sm">来自可信发布渠道的 SHA-256
      <input className={inputClass} value={sha256} onChange={e => setSha256(e.target.value)} spellCheck={false} disabled={busy} />
    </label>
    <label className="flex items-start gap-2 text-sm text-slate-300">
      <input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)} disabled={busy} />
      我已核实安装包和校验和的发布来源可信
    </label>
    <button className="rounded-lg bg-sky-600 px-3 py-2 text-sm disabled:opacity-40" disabled={busy || !status || !trusted || !archive.trim() || !/^[a-fA-F0-9]{64}$/.test(sha256.trim())} onClick={() => void act()}>校验并准备</button>
    {status && <div className="text-sm text-slate-300" role="status">状态：{status.plan.state}{status.plan.version && ` · ${status.plan.version}`}
      {status.plan.commit && <span className="block break-all text-xs text-slate-500">源码提交：{status.plan.commit}</span>}
    </div>}
    {status?.plan.state === 'prepared' && <>
      <p className="text-sm text-amber-300">候选包已准备。唤醒前自动执行冻结依赖、隔离设置模式及页面资源预检，失败则禁止交接。此预检不等于完整桌面或核心验收；当前应用不会关闭。</p>
      <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-40" disabled={busy} onClick={() => void handoff(false)}>唤醒独立执行器</button>
      <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-40" disabled={busy} onClick={() => void act(true)}>取消候选更新</button>
    </>}
    {status?.handoff?.id === status?.plan.id && status?.handoff && <div role="status" className="text-sm text-amber-300">
      交接：{status.handoff.state}
      {status.handoff.state === 'ready' && <button className="ml-3 rounded-lg border border-line px-3 py-2" disabled={busy} onClick={() => void handoff(true)}>确认切换（60秒后关闭）</button>}
      {status.handoff.state === 'countdown' && <p>已放行；应用将正常关闭，当前轮次可能中断。切换过程中请勿重复启动。</p>}
      {status.handoff.error && <p>{status.handoff.error}</p>}
    </div>}
    {error && <p role="alert" className="text-sm text-red-300 break-words">{error}</p>}
  </section>
}
