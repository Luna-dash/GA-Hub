// bubbleTone — single role→color mapping for every surface that renders
// role-tagged content (LiveChat MessageBubble, Conductor, Conversations,
// GoalHive). Layout stays per-surface; the role vocabulary (colors, default
// alignment, default label) is defined once here.
export type BubbleVariant = 'chat' | 'card'

export interface BubbleTone {
  isUser: boolean
  /** Default horizontal alignment of the bubble row. */
  align: 'start' | 'end'
  /** classes for the bubble/card surface itself. */
  surfaceClass: string
  /** Fallback label when a surface has no domain-specific wording. */
  defaultLabel: string
}

const CHAT_TONES: Record<string, BubbleTone> = {
  user: {
    isUser: true,
    align: 'end',
    surfaceClass: 'bg-accent text-[#FFF4DF] border border-[#6F4D28]',
    defaultLabel: '你',
  },
  assistant: {
    isUser: false,
    align: 'start',
    surfaceClass: 'bg-bg-card border border-line text-ink',
    defaultLabel: 'GA Agent',
  },
  system: {
    isUser: false,
    align: 'start',
    surfaceClass: 'bg-[#E8D8B8] border border-[#B69761] text-[#3C2C19]',
    defaultLabel: 'system',
  },
}

const CARD_TONES: Record<string, BubbleTone> = {
  user: {
    isUser: true,
    align: 'end',
    surfaceClass: 'border-accent/40 bg-accent-soft/30',
    defaultLabel: '你',
  },
  assistant: {
    isUser: false,
    align: 'start',
    surfaceClass: 'border-line bg-bg-card',
    defaultLabel: '助手',
  },
  system: {
    isUser: false,
    align: 'start',
    surfaceClass: 'border-amber-500/30 bg-amber-500/10',
    defaultLabel: 'system',
  },
}

const CHAT_OTHER: BubbleTone = {
  isUser: false,
  align: 'start',
  surfaceClass: 'border border-slate-700 bg-bg-soft text-ink',
  defaultLabel: 'other',
}

const CARD_OTHER: BubbleTone = {
  isUser: false,
  align: 'start',
  surfaceClass: 'border-slate-700 bg-bg-soft',
  defaultLabel: 'other',
}

export function bubbleTone(role: string | undefined | null, variant: BubbleVariant = 'chat'): BubbleTone {
  const table = variant === 'card' ? CARD_TONES : CHAT_TONES
  const fallback = variant === 'card' ? CARD_OTHER : CHAT_OTHER
  return (role && table[role]) || fallback
}
