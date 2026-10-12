import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { MessageDialog } from './components/MessageDialog'
import type { DialogConfig, DialogResult } from './stores/dialogStore'
import { measureMessageDialogHeight } from './utils/messageDialogLayout'
import './styles/index.css'

// Separate entry: no App, router, API polling or desktop-runtime initialization.
function DesktopMessage() {
  const [config, setConfig] = useState<DialogConfig | null>(null)
  const [failure, setFailure] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    void invoke<DialogConfig>('message_dialog_config')
      .then(value => { if (alive) setConfig(value) })
      .catch(() => { if (alive) setFailure(true) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!config) return
    // Measure the initial content before showing; further details scroll inside
    // the fixed native window instead of resizing it while the user interacts.
    const observer = new ResizeObserver(() => {
      const height = panel.current ? measureMessageDialogHeight(panel.current) : 240
      void invoke('message_dialog_ready', { height }).catch(() => setFailure(true))
    })
    if (panel.current) observer.observe(panel.current.querySelector('.message-dialog-content')!)
    return () => observer.disconnect()
  }, [config])
  const finish = (result: DialogResult) => {
    void invoke('message_dialog_finish', { result: result ?? null }).catch(() => setFailure(true))
  }
  return <div ref={panel} role="dialog" aria-modal={config?.kind !== 'notification'} aria-labelledby="message-dialog-title">
    {config && <MessageDialog config={config} onResult={finish} desktop />}
    {failure && <p role="alert" className="text-xs text-red-700 p-2">消息窗口连接失败，请关闭此窗口以取消操作。</p>}
  </div>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><DesktopMessage /></React.StrictMode>)
