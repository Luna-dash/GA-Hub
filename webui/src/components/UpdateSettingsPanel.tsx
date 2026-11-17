import { useEffect, useState } from 'react'
import { updateApi, type UpdateRelease, type UpdateStatus } from '@/api/client'

const activePhases = new Set(['checking', 'checksums', 'downloading', 'verifying', 'preparing'])
const phaseLabels: Record<string, string> = { checking: '正在查询正式版本', checksums: '正在获取校验信息', downloading: '正在下载安装包', verifying: '正在校验安装包', preparing: '正在解压并准备更新', succeeded: '下载完成，候选包已准备', failed: '下载未完成', interrupted: '下载已中断' }
const stateLabels: Record<string, string> = { idle: '尚未准备更新', prepared: '候选包已准备', armed: '等待切换', switching: '正在切换', verifying: '正在验证', succeeded: '更新成功', failed: '更新失败', cancelled: '已取消', rolled_back: '已回退', ready: '已就绪，等待确认', countdown: '切换倒计时中' }
function readableError(error: unknown): { message: string; detail: string } {
  let detail = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(detail)
    const value = parsed.detail ?? parsed
    if (typeof value === 'object' && value.message) return { message: value.message, detail: value.detail ?? detail }
    if (typeof value === 'string') detail = value
  } catch { /* Not all errors have a JSON body. */ }
  const lower = detail.toLowerCase()
  const message = lower.includes('lock busy') ? '另一个更新操作正在进行，请稍候，勿重复下载。'
    : /timeout|timed out|超时/.test(lower) ? '连接超时，请检查网络或代理后重试。'
    : /checksum|hash|badzip|metadata/.test(lower) ? '安装包校验未通过，未执行更新；请重新下载。'
    : /network|fetch|connection|proxy/.test(lower) ? '连接失败，请检查网络或系统代理后重试。'
    : '更新操作未完成，请重试；若仍失败，可展开技术详情排查。'
  return { message, detail }
}
function megabytes(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(1)} MB` }

export function UpdateSettingsPanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [release, setRelease] = useState<UpdateRelease | null>(null)
  const [archive, setArchive] = useState('')
  const [sha256, setSha256] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; detail: string } | null>(null)
  const [statusError, setStatusError] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = () => { void updateApi.status().then(value => {
      if (alive) { setStatus(value); if (value.release) setRelease(value.release); setStatusError('') }
    }).catch(e => { if (alive) setStatusError(/404/.test(String(e))
      ? '当前运行版本尚未提供更新接口，请先安装支持自更新的版本。'
      : '暂时无法获取更新状态，正在自动重连；后台下载不会因切换页面而停止。') }) }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  async function online(download = false) {
    setBusy(true); setError(null)
    try {
      if (download) {
        const task = await updateApi.download()
        setStatus(previous => previous ? { ...previous, download: task } : previous)
        setStatus(await updateApi.status())
      } else setRelease(await updateApi.release())
    } catch (e) { setError(readableError(e)) }
    finally { setBusy(false) }
  }
  async function act(cancel = false) {
    setBusy(true); setError(null)
    try {
      if (cancel) await updateApi.cancel(status!.plan.id!)
      else await updateApi.prepare(archive.trim(), sha256.trim(), trusted)
      setStatus(await updateApi.status())
    } catch (e) { setError(readableError(e)) }
    finally { setBusy(false) }
  }
  async function handoff(approve: boolean) {
    setBusy(true); setError(null)
    try {
      if (approve) await updateApi.approve(status!.plan.id!)
      else {
        await updateApi.preflight(status!.plan.id!)
        await updateApi.request(status!.plan.id!)
      }
      setStatus(await updateApi.status())
    } catch (e) { setError(readableError(e)) }
    finally { setBusy(false) }
  }
  const task = status?.download
  const downloading = !!task && activePhases.has(task.phase)
  const locked = busy || downloading || !!statusError
  const onlinePrepared = status?.plan.state === 'prepared' && status.plan.version === release?.version
  const taskError = task?.error && ['failed', 'interrupted'].includes(task.phase) ? task.error : null
  const shownError = error ?? taskError
  const received = task?.received_bytes ?? 0
  const total = task?.total_bytes ?? 0
  const percent = total > 0 ? Math.min(100, Math.floor(received / total * 100)) : undefined
  const inputClass = 'w-full rounded-lg border border-line bg-black/20 px-3 py-2 text-sm'
  return <section className="rounded-xl border border-line bg-bg-card p-4 space-y-3" aria-label="桌面程序更新">
    <h2 className="font-medium">桌面程序更新</h2>
    <p className="text-sm text-ink">先在线准备候选包，再唤醒独立执行器；就绪后需再次确认，固定60秒倒计时结束后正常关闭并切换。不会等待所有会话空闲。</p>
    <p className="text-sm text-ink-muted">仅接受可信来源的 Windows 便携发布包。校验和用于完整性验证，不能代替来源认证。准备不会退出或覆盖当前程序。</p>
    <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-sm">更新源：Luna-dash/GA-Hub · GitHub 正式稳定版（不含预发布）</p>
      <button className="rounded-lg bg-sky-600 px-3 py-2 text-sm disabled:opacity-40" disabled={locked || !status} onClick={() => void online()}>检查正式版本</button>
      {release && <div className="text-sm" role="status">
        当前 {release.current_version} · 最新 {release.version} · {release.available ? '有可用更新' : '已是最新版本'}
        {release.notes && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans">{release.notes}</pre>}
        {release.available && <button className="mt-2 rounded-lg border border-line px-3 py-2 disabled:opacity-40" disabled={locked || status?.plan.state === 'prepared'} onClick={() => void online(true)}>{onlinePrepared ? '此版本已准备完成' : downloading ? '正在后台下载并准备…' : '下载、校验并准备更新'}</button>}
      </div>}
      {busy && <p className="text-sm" role="status">正在处理，请勿重复操作。下载及预检可能需要数分钟。</p>}
    </div>
    {task && <div className="space-y-2 rounded-lg border border-line p-3 text-sm text-ink" role="status" aria-live="polite">
      <p>{phaseLabels[task.phase] ?? '正在处理更新'}{task.release && ` · v${task.release.version}`}</p>
      {task.phase === 'downloading' && <>
        <progress className="block h-2 w-full accent-sky-600" aria-label="安装包下载进度" max={100} value={percent} />
        <p className="text-xs text-ink-muted">{megabytes(received)}{total > 0 && ` / ${megabytes(total)} · ${percent}%`}</p>
      </>}
      {downloading && <p className="text-xs text-ink-muted">下载在后台继续，可以离开此页面；返回后会自动恢复进度。校验完成前不会切换版本。</p>}
      {downloading && task.updated_at && Date.now() / 1000 - task.updated_at > 15 && <p className="text-xs text-ink-muted">暂未收到新进度，正在等待网络或校验响应，请勿重复下载。</p>}
      {taskError && !release && <button className="rounded-lg border border-line px-3 py-2 disabled:opacity-40" disabled={locked} onClick={() => void online(true)}>重新下载并校验</button>}
    </div>}
    <details><summary className="cursor-pointer text-sm text-ink-muted">高级：导入本机可信发布包</summary>
    <label className="block text-sm">本机 ZIP 完整路径
      <input className={inputClass} value={archive} onChange={e => setArchive(e.target.value)} placeholder="D:\\Downloads\\GA-Hub-version-windows-x64.zip" disabled={locked} />
    </label>
    <label className="block text-sm">SHA-256（选填）
      <input className={inputClass} value={sha256} onChange={e => setSha256(e.target.value)} placeholder="可留空；填写时需为可信渠道提供的64位校验和" spellCheck={false} disabled={locked} />
    </label>
    <p className="text-xs text-ink-muted">留空时自动计算文件哈希并校验包内文件，但不与外部校验和比对；请仅导入可信来源的安装包。</p>
    <label className="flex items-start gap-2 text-sm text-ink">
      <input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)} disabled={locked} />
      我已核实安装包来源可信（如填写校验和，也已核实其来源）
    </label>
    <button className="rounded-lg bg-sky-600 px-3 py-2 text-sm disabled:opacity-40" disabled={locked || !status || !trusted || !archive.trim() || (!!sha256.trim() && !/^[a-fA-F0-9]{64}$/.test(sha256.trim()))} onClick={() => void act()}>校验并准备</button>
    </details>
    {status && <div className="text-sm text-ink" role="status">状态：{stateLabels[status.plan.state] ?? '正在处理'}{status.plan.version && ` · ${status.plan.version}`}
      {status.plan.commit && <span className="block break-all text-xs text-ink-muted">源码提交：{status.plan.commit}</span>}
    </div>}
    {status?.plan.state === 'prepared' && <>
      <p className="text-sm text-ink">候选包已准备。唤醒前自动执行冻结依赖、隔离设置模式及页面资源预检，失败则禁止交接。此预检不等于完整桌面或核心验收；当前应用不会关闭。</p>
      <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-40" disabled={locked} onClick={() => void handoff(false)}>唤醒独立执行器</button>
      <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-40" disabled={locked} onClick={() => void act(true)}>取消候选更新</button>
    </>}
    {status?.handoff?.id === status?.plan.id && status?.handoff && <div role="status" className="text-sm text-ink">
      交接：{stateLabels[status.handoff.state] ?? '正在处理'}
      {status.handoff.state === 'ready' && <button className="ml-3 rounded-lg border border-line px-3 py-2" disabled={locked} onClick={() => void handoff(true)}>确认切换（60秒后关闭）</button>}
      {status.handoff.state === 'countdown' && <p>已放行；应用将正常关闭，当前轮次可能中断。切换过程中请勿重复启动。</p>}
      {status.handoff.error && <div><p>{readableError(status.handoff.error).message}</p><details><summary>技术详情</summary><pre className="whitespace-pre-wrap break-all text-xs">{readableError(status.handoff.error).detail}</pre></details></div>}
    </div>}
    {statusError && <p role="alert" className="text-sm text-status-danger">{statusError}</p>}
    {shownError && <div role="alert" className="text-sm text-status-danger break-words">
      <p>{shownError.message}</p>
      <details className="mt-1 text-ink-muted"><summary className="cursor-pointer">技术详情</summary><pre className="mt-1 whitespace-pre-wrap break-all text-xs">{shownError.detail}</pre></details>
    </div>}
  </section>
}
