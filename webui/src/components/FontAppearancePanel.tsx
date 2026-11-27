import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Trash2, Upload } from 'lucide-react'
import { fontApi, type FontPackInfo, type FontSettings } from '@/api/client'
import { queryKeys } from '@/queries/queryKeys'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { applyFontSettings } from '@/utils/fontLoader'
import { errorMessageFromError } from '@/utils/sessionUi'

function formatMegabytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FontAppearancePanel() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const busyRef = useRef(false)
  const lastDownloadPhaseRef = useRef<string | null>(null)

  const fontsQuery = useQuery({
    queryKey: queryKeys.appearance.fonts,
    queryFn: fontApi.settings,
    refetchInterval: (query) => {
      const data = query.state.data as FontSettings | undefined
      return data?.download?.phase === 'downloading' ? 500 : false
    },
  })

  const data = fontsQuery.data
  const downloading = data?.download?.phase === 'downloading' ? data.download : null
  const downloadError = data?.download?.phase === 'error' ? data.download.error : null

  useEffect(() => {
    if (!data) return
    const phase = data.download?.phase ?? null
    if (lastDownloadPhaseRef.current === 'downloading' && phase === 'ready') {
      toast.success('字体包已下载并启用')
    }
    lastDownloadPhaseRef.current = phase
    void applyFontSettings(data)
  }, [data])

  const applyAndCache = async (next: FontSettings) => {
    qc.setQueryData(queryKeys.appearance.fonts, next)
    await applyFontSettings(next)
  }

  const handleDownload = async (packId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyId(packId)
    try {
      const next = await fontApi.download(packId)
      await applyAndCache(next)
    } catch (error) {
      toast.error('字体下载启动失败：' + errorMessageFromError(error))
    } finally {
      busyRef.current = false
      setBusyId(null)
    }
  }

  const handleActivate = async (packId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyId(`activate:${packId}`)
    try {
      const next = await fontApi.activate(packId)
      await applyAndCache(next)
      toast.success(packId === 'system' ? '已切回系统默认字体策略' : '已切换字体方案')
    } catch (error) {
      toast.error('切换字体失败：' + errorMessageFromError(error))
    } finally {
      busyRef.current = false
      setBusyId(null)
    }
  }

  const handleDelete = async (pack: FontPackInfo) => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const ok = await dialog.confirm(
        `移除字体包「${pack.name}」？`,
        '将删除本地已下载的字体文件，之后如需使用需重新下载。',
        { confirmText: '移除', tone: 'danger' },
      )
      if (!ok) return
      setBusyId(`delete:${pack.id}`)
      const next = await fontApi.deletePack(pack.id)
      await applyAndCache(next)
      toast.success(`已移除 ${pack.name}`)
    } catch (error) {
      toast.error('移除字体失败：' + errorMessageFromError(error))
    } finally {
      busyRef.current = false
      setBusyId(null)
    }
  }

  const handleBoldStyle = async (boldStyle: 'restrained' | 'standard') => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyId(`bold:${boldStyle}`)
    try {
      const next = await fontApi.updatePreferences(boldStyle)
      await applyAndCache(next)
    } catch (error) {
      toast.error('更新字重策略失败：' + errorMessageFromError(error))
    } finally {
      busyRef.current = false
      setBusyId(null)
    }
  }

  const handleImportChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busyRef.current) return
    busyRef.current = true
    setImporting(true)
    try {
      const next = await fontApi.importFile(file)
      await applyAndCache(next)
      toast.success(`已导入并启用：${file.name}`)
    } catch (error) {
      toast.error('导入字体失败：' + errorMessageFromError(error))
    } finally {
      busyRef.current = false
      setImporting(false)
    }
  }

  const activePack = data?.active_pack ?? 'system'
  const boldStyle = data?.bold_style === 'standard' ? 'standard' : 'restrained'
  const activePackName =
    activePack === 'system'
      ? '系统默认（雅黑 UI）'
      : (data?.packs.find((p) => p.id === activePack)?.name ?? activePack)

  const dlPercent =
    downloading && downloading.total_bytes && downloading.total_bytes > 0
      ? Math.min(100, Math.round((downloading.received_bytes / downloading.total_bytes) * 100))
      : null

  return (
    <div className="ga-paper-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">字体方案与字重</div>
          <div className="text-[11px] text-ink-faint">当前：{activePackName}</div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {activePack !== 'system' && (
            <button
              type="button"
              disabled={importing || busyId !== null}
              onClick={() => { void handleActivate('system') }}
              className="ga-btn-sm"
            >
              {busyId === 'activate:system' ? '切换中…' : '切回系统默认'}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".woff2,.ttf,.otf"
            onChange={(e) => { void handleImportChange(e) }}
            className="hidden"
          />
          <button
            type="button"
            disabled={importing || busyId !== null || Boolean(downloading)}
            onClick={() => fileRef.current?.click()}
            className="ga-btn-sm"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{importing ? '导入中…' : '导入本地字体…'}</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2.5">
        <span className="text-xs font-medium text-ink">加粗表现</span>
        <div className="ga-segmented text-xs" role="group" aria-label="加粗策略">
          {([
            ['restrained', '克制防膨胀（推荐）'],
            ['standard', '原生标准粗体'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={importing || busyId !== null}
              aria-pressed={boldStyle === value}
              onClick={() => { void handleBoldStyle(value) }}
              className={`ga-segmented-btn ${
                boldStyle === value ? 'ga-segmented-btn-active' : ''
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {downloading && (
        <div role="status" className="rounded-lg border border-status-info-line bg-status-info-soft px-3 py-2.5 space-y-1.5 text-xs text-status-info">
          <div className="flex items-center justify-between gap-2">
            <span>正在下载 {data?.packs.find((p) => p.id === downloading.pack_id)?.name ?? downloading.pack_id}…</span>
            <span className="font-mono tabular-nums">
              {formatMegabytes(downloading.received_bytes)}
              {downloading.total_bytes ? ` / ${formatMegabytes(downloading.total_bytes)}${dlPercent !== null ? ` (${dlPercent}%)` : ''}` : ''}
            </span>
          </div>
          <div className="ga-progress-track">
            <div
              className="ga-progress-fill"
              style={{ width: `${dlPercent ?? 30}%` }}
            />
          </div>
        </div>
      )}

      {downloadError && (
        <div role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-3 py-2 text-xs text-status-danger break-words">
          上次下载失败：{downloadError}
        </div>
      )}

      {fontsQuery.isLoading ? (
        <div className="text-xs text-ink-faint">正在读取字体列表…</div>
      ) : fontsQuery.isError ? (
        <div role="alert" className="text-xs text-status-danger">无法读取字体列表，请确认后端已就绪。</div>
      ) : (
        <div className="space-y-2">
          {(data?.packs ?? []).map((pack) => {
            const isDownloadingThis = downloading?.pack_id === pack.id
            const anyDownloading = Boolean(downloading)
            return (
              <div
                key={pack.id}
                className={`rounded-xl border p-3 flex flex-wrap items-center justify-between gap-3 ${
                  pack.active ? 'border-accent/65 bg-accent-soft/25' : 'border-line/45 bg-bg-soft/55'
                }`}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{pack.name}</span>
                    <span className="rounded-md bg-bg-card px-1.5 py-0.5 text-[11px] text-ink-muted ring-1 ring-line/45">
                      {pack.license}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-ink-faint">
                      {pack.installed ? `已下载 ${formatMegabytes(pack.installed_bytes)}` : `约 ${formatMegabytes(pack.approx_bytes)}`}
                    </span>
                    {pack.active && (
                      <span className="rounded-md bg-status-success-soft border border-status-success-line px-1.5 py-0.5 text-[11px] font-medium text-status-success">
                        使用中
                      </span>
                    )}
                  </div>
                  {pack.summary && <p className="text-xs text-ink-muted">{pack.summary}</p>}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {!pack.installed ? (
                    <button
                      type="button"
                      disabled={anyDownloading || importing || busyId !== null}
                      onClick={() => { void handleDownload(pack.id) }}
                      className="ga-btn-sm-primary"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{isDownloadingThis ? '下载中…' : '下载并启用'}</span>
                    </button>
                  ) : (
                    <>
                      {!pack.active && (
                        <button
                          type="button"
                          disabled={anyDownloading || importing || busyId !== null}
                          onClick={() => { void handleActivate(pack.id) }}
                          className="ga-btn-sm-primary"
                        >
                          {busyId === `activate:${pack.id}` ? '启用中…' : '启用'}
                        </button>
                      )}
                      {pack.removable && (
                        <button
                          type="button"
                          disabled={anyDownloading || importing || busyId !== null}
                          onClick={() => { void handleDelete(pack) }}
                          title="删除已下载字体文件"
                          className="ga-btn-sm-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{busyId === `delete:${pack.id}` ? '移除中…' : '移除'}</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="rounded-lg border border-line/70 bg-bg-soft/65 px-3 py-1.5 text-xs text-ink flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-ink-faint">效果预览</span>
        <div className="truncate">
          正文 Gyra · <span className="font-medium">Medium</span> · <strong>Bold 粗体</strong> · <code className="font-mono text-[11px] px-1 rounded bg-bg-card border border-line/70">123.45</code>
        </div>
      </div>
    </div>
  )
}
