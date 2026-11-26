// bubbleTone — single role→surface mapping for every surface that renders
// role-tagged content (LiveChat MessageBubble, Conversations, Conductor,
// GoalHive). Layout, alignment and labels stay per-surface; only the role
// surface classes are shared, defined once here.
export type BubbleVariant = 'chat' | 'card'

export interface BubbleTone {
  /** classes for the bubble/card surface itself. */
  surfaceClass: string
}

const CHAT_TONES: Record<string, BubbleTone> = {
  user: { surfaceClass: 'bg-[var(--c-user-bubble-bg)] text-[var(--c-user-bubble-fg)] border border-[var(--c-user-bubble-border)]' },
  assistant: { surfaceClass: 'bg-bg-card border border-line text-ink ga-surface-card' },
  system: { surfaceClass: 'bg-[var(--c-system-bubble-bg)] border border-[var(--c-system-bubble-border)] text-[var(--c-system-bubble-fg)]' },
}

const CARD_TONES: Record<string, BubbleTone> = {
  user: { surfaceClass: 'border-accent/40 bg-accent-soft/30' },
  assistant: { surfaceClass: 'border-line bg-bg-card' },
  system: { surfaceClass: 'border-status-warning-line bg-status-warning-soft' },
}

const CHAT_OTHER: BubbleTone = { surfaceClass: 'border border-line bg-bg-soft text-ink' }
const CARD_OTHER: BubbleTone = { surfaceClass: 'border-line bg-bg-soft' }

export function bubbleTone(role: string | undefined | null, variant: BubbleVariant = 'chat'): BubbleTone {
  const table = variant === 'card' ? CARD_TONES : CHAT_TONES
  const fallback = variant === 'card' ? CARD_OTHER : CHAT_OTHER
  return (role && table[role]) || fallback
}
