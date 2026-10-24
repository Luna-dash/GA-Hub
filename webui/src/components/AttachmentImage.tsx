import { useEffect, useState } from 'react'
import type { PasteAttachment } from '@/api/types'
import { api } from '@/api/client'
import { canReferenceLocalFiles, localAttachmentImageUrl } from '@/utils/desktop'

export function isImageAttachment(a: PasteAttachment): boolean {
  return Boolean(a.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name))
}

/** Preview state belongs to the view, never the persisted attachment/path protocol. */
export function AttachmentImage({ attachment: a, className, linked = false }: {
  attachment: PasteAttachment
  className?: string
  linked?: boolean
}) {
  // Persisted blob URLs do not survive reloads. Recreate them from the path.
  const preview = a.preview?.startsWith('blob:') ? '' : a.preview || ''
  const native = !preview && Boolean(a.path) && canReferenceLocalFiles()
  const key = `${native}:${preview}:${a.path}`
  const [state, setState] = useState<{ key: string; src?: string; failed?: boolean }>({ key: '' })
  useEffect(() => {
    let disposed = false
    let ownedUrl: string | undefined
    setState({ key })
    if (native) {
      localAttachmentImageUrl(a.path).then((src) => {
        if (disposed) { URL.revokeObjectURL(src); return }
        ownedUrl = src
        setState({ key, src })
      }).catch(() => { if (!disposed) setState({ key, failed: true }) })
    } else {
      const src = preview || (a.path ? api.fileUrlByPath(a.path) : a.url)
      setState({ key, src, failed: !src })
    }
    return () => { disposed = true; if (ownedUrl) URL.revokeObjectURL(ownedUrl) }
  }, [key, native, preview, a.path, a.url])

  const current = state.key === key ? state : undefined
  if (!current?.src || current.failed) {
    return <span className={`inline-flex items-center justify-center bg-bg-card text-xs text-ink-muted ${className || ''}`}
      role="status" title={`${a.name}\n${a.path}\n${current?.failed ? '预览不可用（文件失效、格式不支持或超过16MiB），仍保留附件引用' : '正在加载图片预览'}`}>
      {current?.failed ? '图片预览不可用' : '加载预览…'}
    </span>
  }
  const image = <img src={current.src} alt={a.name} className={className}
    onError={() => setState({ key, failed: true })} />
  return linked
    ? <a href={current.src} target="_blank" rel="noreferrer" title={a.name} className="block">{image}</a>
    : image
}
