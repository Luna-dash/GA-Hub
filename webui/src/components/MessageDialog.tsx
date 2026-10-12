import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Info, MessageCircleQuestion, PencilLine, ChevronDown, Copy } from 'lucide-react'
import { cancelResult, type DialogConfig, type DialogResult } from '@/stores/dialogStore'
import './messageDialog.css'

interface Props {
  config: DialogConfig
  onResult: (value: DialogResult) => void
  desktop?: boolean
}

/** Content and keyboard policy shared by the owned native window and browser. */
export function MessageDialog({ config, onResult, desktop = false }: Props) {
  const [value, setValue] = useState(config.defaultValue ?? '')
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const settled = useRef(false)
  const isPrompt = config.kind === 'prompt'
  const danger = config.tone === 'danger'
  const Icon = danger ? AlertTriangle : isPrompt ? PencilLine : config.kind === 'confirm' ? MessageCircleQuestion : Info
  const finish = (result: DialogResult) => {
    if (settled.current) return
    settled.current = true
    onResult(result)
  }
  const confirm = () => finish(isPrompt ? value : config.kind === 'confirm' || config.kind === 'notification' ? true : null)
  const cancel = () => finish(cancelResult(config))

  useEffect(() => {
    if (config.kind === 'notification') return
    const target = root.current?.querySelector<HTMLElement>(isPrompt ? 'input, textarea' : danger && config.kind !== 'alert' ? '[data-cancel]' : '[data-confirm]')
    target?.focus()
    if (target instanceof HTMLInputElement) target.select()
  }, []) // the host keys each request, so focus/value never leak into the next

  return (
    <div ref={root} className={`message-dialog ${desktop ? 'message-dialog-desktop' : ''}`} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return }
      if (config.kind !== 'notification' && event.key === 'Tab') {
        event.stopPropagation() // this component owns the trap, not ModalOverlay
        const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, summary') ?? [])
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
      // Buttons retain native Enter/Space behavior; in particular Enter on
      // Cancel must not activate Confirm. Multiline Enter remains a newline.
      if (event.key === 'Enter' && isPrompt && !(config.multiline) && event.target instanceof HTMLInputElement) {
        event.preventDefault(); confirm()
      }
    }}>
      <div className="message-dialog-body">
        <div className={`message-dialog-icon ${danger ? 'message-dialog-danger' : ''}`}><Icon size={24} strokeWidth={1.7} /></div>
        <div className="message-dialog-content">
          <div className="message-dialog-eyebrow">GA-HUB · {config.kind === 'notification' ? '提醒' : danger ? '操作确认' : isPrompt ? '编辑' : config.kind === 'alert' ? '消息' : '确认'}</div>
          <h2 id="message-dialog-title">{config.title}</h2>
          {config.message && <p className="message-dialog-text">{config.message}</p>}
          {isPrompt && (config.multiline
            ? <textarea aria-label={config.title} rows={4} value={value} placeholder={config.placeholder} onChange={e => setValue(e.target.value)} className="message-dialog-input" />
            : <input aria-label={config.title} value={value} placeholder={config.placeholder} onChange={e => setValue(e.target.value)} className="message-dialog-input" />)}
          {config.kind !== 'notification' && config.detail && <div className="message-dialog-detail">
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}><ChevronDown size={14} />{expanded ? '收起详情' : '查看详情'}</button>
            {expanded && <><pre>{config.detail}</pre><button type="button" onClick={() => {
              void navigator.clipboard.writeText(config.detail!).then(() => setCopied(true)).catch(() => setCopied(false))
            }}><Copy size={13} />{copied ? '已复制' : '复制详情'}</button></>}
          </div>}
        </div>
      </div>
      <div className="message-dialog-footer">
        {config.kind !== 'alert' && <button type="button" className="message-dialog-button" data-cancel onClick={cancel}>{config.cancelText ?? (config.kind === 'notification' ? '稍后' : '取消')}</button>}
        <button type="button" className={`message-dialog-button message-dialog-primary ${danger ? 'message-dialog-primary-danger' : ''}`} data-confirm onClick={confirm}>{config.confirmText ?? (config.kind === 'alert' ? '知道了' : '确认')}</button>
      </div>
    </div>
  )
}
