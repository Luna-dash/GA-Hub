import { useEffect, useState } from 'react'
import { updateApi, type UpdateRelease, type UpdateStatus } from '@/api/client'
import { Download, Power, RotateCw, Search, ShieldCheck, X } from './ActionIcons'

const activePhases = new Set(['checking', 'checksums', 'downloading', 'verifying', 'preparing'])
const phaseLabels: Record<string, string> = {
  checking: '正在查询正式版本',
  checksums: '正在获取校验信息',
  downloading: '正在下载安装包',
  verifying: '正在校验安装包',
  preparing: '正在解压并准备更新',
  succeeded: '下载完成，候选包已准备',
  failed: '下载未完成',
  interrupted: '下载已中断',
}
const stateLabels: Record<string, string> = {
  idle: '尚未准备更新',
  prepared: '候选包已就绪',
  switching: '正在重启切换',
  verifying: '正在验证新版本',
  succeeded: '更新成功',
  failed: '更新失败',
  cancelled: '已取消',
  rolled_back: '新版本验证失败，已自动回退',
}

function readableError(error: unknown): { message: string; detail: string } {
  let detail = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(detail)
    const value = parsed.detail ?? parsed
    if (typeof value === 'object' && value.message) return { message: value.message, detail: value.detail ?? detail }
    if (typeof value === 'string') detail = value
  } catch { /* Not all errors have a JSON body. */ }
  const lower = detail.toLowerCase()
  const message = lower.includes('lock busy') ? '另一个更新操作正在进行，请稍候，勿重复操作。'
    : /timeout|timed out|超时/.test(lower) ? '连接超时，请检查网络或代理后重试。'
    : /checksum|hash|badzip|metadata/.test(lower) ? '安装包校验未通过，未执行更新；请重新下载。'
    : /network|fetch|connection|proxy/.test(lower) ? '连接失败，请检查网络或系统代理后重试。'
    : '更新操作未完成，请重试；若仍失败，可展开技术详情排查。'
  return { message, detail }
}

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UpdateSettingsPanel({ active = true }: { active?: boolean } = {}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [release, setRelease] = useState<UpdateRelease | null>(null)
  const [archive, setArchive] = useState('')
  const [sha256, setSha256] = useState('')
  const [trusted, setTrusted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; detail: string } | null>(null)
  const [statusError, setStatusError] = useState('')

  const shouldPoll = Boolean(
    active && (
      busy
      || (status?.download?.phase && activePhases.has(status.download.phase))
      || (status?.plan?.state && ['switching', 'verifying'].includes(status.plan.state))
    ),
  )

  useEffect(() => {
    if (!active) return
    let alive = true
    void updateApi.status().then(value => {
      if (alive) {
        setStatus(value)
        if (value.release) setRelease(value.release)
        setStatusError('')
      }
    }).catch(e => {
      if (alive) {
        setStatusError(/404/.test(String(e))
          ? '当前运行版本尚未提供更新接口，请先安装支持自更新的版本。'
          : '暂时无法获取更新状态，正在自动重连；后台下载不会因切换页面而停止。')
      }
    })
    return () => { alive = false }
  }, [active])

  useEffect(() => {
    if (!active || !shouldPoll) return
    let alive = true
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void updateApi.status().then(value => {
        if (alive) {
          setStatus(value)
          if (value.release) setRelease(value.release)
          setStatusError('')
        }
      }).catch(e => {
        if (alive) {
          setStatusError(/404/.test(String(e))
            ? '当前运行版本尚未提供更新接口，请先安装支持自更新的版本。'
            : '暂时无法获取更新状态，正在自动重连；后台下载不会因切换页面而停止。')
        }
      })
    }
    const timer = window.setInterval(refresh, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [active, shouldPoll])

  async function online(download = false) {
    setBusy(true); setError(null)
    try {
      if (download) {
        const task = await updateApi.download()
        setStatus(previous => previous ? { ...previous, download: task } : previous)
        setStatus(await updateApi.status())
      } else {
        setRelease(await updateApi.release())
      }
    } catch (e) {
      setError(readableError(e))
    } finally {
      setBusy(false)
    }
  }

  async function act(cancel = false) {
    setBusy(true); setError(null)
    try {
      if (cancel) {
        await updateApi.cancel(status!.plan.id!)
      } else {
        await updateApi.prepare(archive.trim(), sha256.trim(), trusted)
        setArchive('')
        setSha256('')
        setTrusted(false)
      }
      setStatus(await updateApi.status())
    } catch (e) {
      setError(readableError(e))
    } finally {
      setBusy(false)
    }
  }

  async function applyNow() {
    if (!status?.plan?.id) return
    setBusy(true); setError(null)
    try {
      await updateApi.apply(status.plan.id)
      setStatus(await updateApi.status())
    } catch (e) {
      setError(readableError(e))
    } finally {
      setBusy(false)
    }
  }

  const task = status?.download
  const downloading = !!task && activePhases.has(task.phase)
  const locked = busy || downloading || !!statusError
  const prepared = status?.plan?.state === 'prepared'
  const localLocked = locked || prepared
  const onlinePrepared = prepared && status?.plan?.version === release?.version
  const taskError = task?.error && ['failed', 'interrupted'].includes(task.phase) ? task.error : null
  const shownError = error ?? taskError
  const received = task?.received_bytes ?? 0
  const total = task?.total_bytes ?? 0
  const percent = total > 0 ? Math.min(100, Math.floor(received / total * 100)) : undefined
  const inputClass = 'ga-input py-2'
  const shaInvalid = Boolean(sha256.trim()) && !/^[a-fA-F0-9]{64}$/.test(sha256.trim())

  return (
    <section className="ga-paper-card p-4 space-y-3" aria-label="桌面程序更新">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">桌面程序更新</h2>
        <span className="text-[11px] text-ink-faint">便携绿色版 · 支持 GitHub 正式版与本地 ZIP</span>
      </div>
      <p className="text-sm text-ink">准备更新包后点击一键重启切换；若新版本启动健康检查未通过，将自动回退至旧版本。</p>

      <div className="ga-paper-subcard space-y-2.5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-muted">更新源：Luna-dash/GA-Hub · GitHub 正式版</p>
          <button type="button" className="ga-btn-primary" disabled={locked || !status} onClick={() => void online()}>
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            <span>检查正式版本</span>
          </button>
        </div>
        {release && (
          <div className="text-sm" role="status">
            当前 {release.current_version} · 最新 {release.version} · {release.available ? '有可用更新' : '已是最新版本'}
            {release.notes && (
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans text-xs leading-5 text-ink-muted">
                {release.notes}
              </pre>
            )}
            {release.available && (
              <button
                type="button"
                className="ga-btn mt-2"
                disabled={locked || status?.plan?.state === 'prepared'}
                onClick={() => void online(true)}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{onlinePrepared ? '此版本已准备完成' : downloading ? '正在后台下载并准备…' : '下载、校验并准备更新'}</span>
              </button>
            )}
          </div>
        )}
        {busy && <p className="text-sm" role="status">正在处理，请勿重复操作。</p>}
      </div>

      {task && (
        <div className="ga-paper-subcard space-y-2 p-3 text-sm text-ink" role="status" aria-live="polite">
          <p>{phaseLabels[task.phase] ?? '正在处理更新'}{task.release && ` · v${task.release.version}`}</p>
          {task.phase === 'downloading' && (
            <>
              <progress className="ga-progress" aria-label="安装包下载进度" max={100} value={percent} />
              <p className="text-xs text-ink-muted">
                {megabytes(received)}{total > 0 && ` / ${megabytes(total)} · ${percent}%`}
              </p>
            </>
          )}
          {downloading && <p className="text-xs text-ink-muted">后台下载中，可切换其他页面。</p>}
          {downloading && task.updated_at && Date.now() / 1000 - task.updated_at > 15 && (
            <p className="text-xs text-ink-muted">暂未收到新进度，正在等待网络或校验响应，请勿重复下载。</p>
          )}
          {taskError && !release && (
            <button type="button" className="ga-btn" disabled={locked} onClick={() => void online(true)}>
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>重新下载并校验</span>
            </button>
          )}
        </div>
      )}

      <details className="ga-paper-subcard px-3 py-2.5">
        <summary className="cursor-pointer text-xs font-medium text-ink-muted hover:text-ink">高级：导入本机可信发布包</summary>
        <div className="mt-2.5 space-y-2.5">
          <label className="block text-sm">
            本机 ZIP 完整路径
            <input
              className={`${inputClass} mt-1`}
              value={archive}
              onChange={e => setArchive(e.target.value)}
              placeholder="D:\Downloads\GA-Hub-version-windows-x64.zip"
              disabled={localLocked}
              autoComplete="off"
            />
          </label>
          <label className="block text-sm">
            SHA-256（选填）
            <input
              className={`${inputClass} mt-1 font-mono`}
              value={sha256}
              onChange={e => setSha256(e.target.value)}
              placeholder="64 位校验和，可留空"
              spellCheck={false}
              disabled={localLocked}
              aria-invalid={shaInvalid || undefined}
              aria-describedby={shaInvalid ? 'update-sha256-error' : undefined}
              autoComplete="off"
            />
            {shaInvalid && (
              <p id="update-sha256-error" role="alert" className="ga-field-error">
                SHA-256 需为 64 位十六进制字符，或留空跳过校验。
              </p>
            )}
          </label>
          <label className="flex items-start gap-2 text-xs text-ink">
            <input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)} disabled={localLocked} />
            <span>我已核实安装包来源可信</span>
          </label>
          {prepared && (
            <div className="space-y-1.5">
              <p className="text-xs text-ink-muted">已有候选更新，取消后即可导入另一个 ZIP，不会重启应用。</p>
              <button type="button" className="ga-btn" disabled={locked} onClick={() => void act(true)}>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                <span>取消旧候选并更换本地包</span>
              </button>
            </div>
          )}
          <button
            type="button"
            className="ga-btn-primary"
            disabled={localLocked || !status || !trusted || !archive.trim() || (!!sha256.trim() && !/^[a-fA-F0-9]{64}$/.test(sha256.trim()))}
            onClick={() => void act()}
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span>校验并准备</span>
          </button>
        </div>
      </details>

      {status?.plan && (
        <div className="text-sm text-ink" role="status">
          状态：{stateLabels[status.plan.state] ?? '正在处理'}{status.plan.version && ` · ${status.plan.version}`}
          {status.plan.commit && <span className="block break-all text-xs text-ink-muted">源码提交：{status.plan.commit}</span>}
          {status.plan.error && <span className="block break-all text-xs text-status-danger mt-1">{status.plan.error}</span>}
        </div>
      )}

      {status?.plan?.state === 'prepared' && (
        <>
          <p className="text-sm text-ink">更新包已通过 SHA-256 校验，点击下方按钮将立即关闭当前窗口并切换至新版本。</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ga-btn-primary" disabled={locked} onClick={() => void applyNow()}>
              <Power className="h-3.5 w-3.5" aria-hidden="true" />
              <span>立即重启并更新</span>
            </button>
            <button type="button" className="ga-btn" disabled={locked} onClick={() => void act(true)}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>取消候选更新</span>
            </button>
          </div>
        </>
      )}

      {status?.plan?.state === 'failed' && status.plan.switch_started === false && status.plan.id && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="ga-btn" disabled={locked} onClick={() => void act(true)}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span>清除失败状态</span>
          </button>
        </div>
      )}

      {status?.plan?.state === 'failed' && status.plan.switch_started !== false && (
        <p role="alert" className="text-xs text-status-danger">
          上次更新切换未正常结束；请确认无残留进程后，在终端运行更新助手恢复：
          <code className="ml-1 font-mono">ga-hub-update.exe --admin-data %USERPROFILE%\.genericagent-admin recover</code>
        </p>
      )}

      {status?.plan?.state === 'switching' && (
        <p role="status" className="text-sm text-ink">正在重启并切换至新版本，请勿重复启动应用…</p>
      )}

      {statusError && <p role="alert" className="text-sm text-status-danger">{statusError}</p>}
      {shownError && (
        <div role="alert" className="text-sm text-status-danger">
          <p>{shownError.message}</p>
          <details className="mt-1 text-xs text-ink-muted">
            <summary className="cursor-pointer">技术详情</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all">{shownError.detail}</pre>
          </details>
        </div>
      )}
    </section>
  )
}
