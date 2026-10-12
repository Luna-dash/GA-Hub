import type { SVGProps } from 'react'

export type SessionChannel = 'mixin' | 'openai' | 'claude'

export function sessionChannel(type: string): SessionChannel | null {
  const normalized = type.toLowerCase().replace(/[_\s-]/g, '')
  if (normalized === 'mixin') return 'mixin'
  if (['oai', 'nativeoai', 'openai', 'nativeopenai'].includes(normalized)) return 'openai'
  if (['claude', 'nativeclaude'].includes(normalized)) return 'claude'
  return null
}

/** Shared by MyKey cards and model selectors; never infer a channel from the model name. */
export function SessionChannelIcon({ type, ...props }: SVGProps<SVGSVGElement> & { type: string }) {
  const channel = sessionChannel(type)
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-channel={channel ?? 'unknown'} {...props}>
      {channel === 'mixin' ? <path d="M3 5h3c4 0 4 10 8 10h3m-3-3 3 3-3 3M3 15h3c1.5 0 2.5-1.5 3.3-3M11 8c.8-1.5 1.8-3 3-3h3m-3-3 3 3-3 3" /> : <>
        <circle cx="10" cy="10" r="8" />
        {channel === 'claude' ? <path d="M12.5 6.5a4 4 0 1 0 0 7" /> : channel === 'openai' ? <ellipse cx="10" cy="10" rx="3" ry="4" /> : null}
      </>}
    </svg>
  )
}
