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
  user: { surfaceClass: 'bg-accent text-[#FFF4DF] border border-[#6F4D28]' },
  assistant: { surfaceClass: 'bg-bg-card border border-line text-ink' },
  system: { surfaceClass: 'bg-[#E8D8B8] border border-[#B69761] text-[#3C2C19]' },
}

const CARD_TONES: Record<string, BubbleTone> = {
  user: { surfaceClass: 'border-accent/40 bg-accent-soft/30' },
  assistant: { surfaceClass: 'border-line bg-bg-card' },
  system: { surfaceClass: 'border-amber-500/30 bg-amber-500/10' },
}

const CHAT_OTHER: BubbleTone = { surfaceClass: 'border border-slate-700 bg-bg-soft text-ink' }
const CARD_OTHER: BubbleTone = { surfaceClass: 'border-slate-700 bg-bg-soft' }

export function bubbleTone(role: string | undefined | null, variant: BubbleVariant = 'chat'): BubbleTone {
  const table = variant === 'card' ? CARD_TONES : CHAT_TONES
  const fallback = variant === 'card' ? CARD_OTHER : CHAT_OTHER
  return (role && table[role]) || fallback
}
