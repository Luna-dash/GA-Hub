// Tiny clipboard helper with a transient "✓ 已复制" toast.
//
// Renders nothing globally — each caller wires the visual feedback locally
// via the returned `copied` flag (debounced for ~1.4s).

import { useCallback, useState } from 'react'

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
    // Fallback: hidden textarea + execCommand (legacy http contexts)
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function useCopy(timeoutMs = 1400): {
  copied: boolean
  copy: (text: string) => Promise<boolean>
} {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(
    async (text: string) => {
      const ok = await writeClipboard(text)
      if (ok) {
        setCopied(true)
        window.setTimeout(() => setCopied(false), timeoutMs)
      }
      return ok
    },
    [timeoutMs],
  )
  return { copied, copy }
}
