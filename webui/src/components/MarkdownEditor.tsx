// Lightweight markdown editor: textarea + live preview. Avoids pulling
// monaco/codemirror just for SOP editing — keeps the bundle small.

import { useEffect, useState } from 'react'
import { MarkdownView } from './MarkdownView'

interface Props {
  value: string
  onChange: (s: string) => void
  height?: number
  readOnly?: boolean
}

export function MarkdownEditor({ value, onChange, height, readOnly }: Props) {
  const [preview, setPreview] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])

  return (
    <div className="rounded-lg border border-line overflow-hidden flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line bg-bg-soft text-xs">
        <div className="text-slate-400">
          {readOnly ? '只读' : 'Markdown 编辑'}
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setPreview(false)}
            className={'px-2 py-1 rounded ' + (!preview ? 'bg-accent-soft text-accent' : 'text-slate-400 hover:text-slate-200')}
          >源码</button>
          <button
            onClick={() => setPreview(true)}
            className={'px-2 py-1 rounded ' + (preview ? 'bg-accent-soft text-accent' : 'text-slate-400 hover:text-slate-200')}
          >预览</button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {preview ? (
          <div className="p-4"><MarkdownView>{v}</MarkdownView></div>
        ) : (
          <textarea
            value={v}
            readOnly={readOnly}
            onChange={(e) => { setV(e.target.value); onChange(e.target.value) }}
            className="w-full h-full p-4 bg-bg-card outline-none font-mono text-sm leading-6 resize-none"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  )
}
