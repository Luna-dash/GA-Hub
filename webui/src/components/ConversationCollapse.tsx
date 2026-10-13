import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CollapseToLatestButton } from './CollapseToLatestButton'

type CollapseRegistry = {
  register: (id: symbol, collapse: (() => void) | null) => void
  collapseAll: () => void
  hasExpanded: boolean
}
const ConversationCollapseContext = createContext<CollapseRegistry | null>(null)

/** Owned by the conversation viewport, never by its latest message. */
export function ConversationCollapseProvider({ children, onAfterCollapse }: { children: ReactNode; onAfterCollapse: () => void }) {
  const records = useRef(new Map<symbol, () => void>())
  const [hasExpanded, setHasExpanded] = useState(false)
  const register = useCallback((id: symbol, collapse: (() => void) | null) => {
    if (collapse) records.current.set(id, collapse)
    else records.current.delete(id)
    setHasExpanded(records.current.size > 0)
  }, [])
  const collapseAll = useCallback(() => {
    for (const collapse of [...records.current.values()]) collapse()
    records.current.clear()
    setHasExpanded(false)
    onAfterCollapse()
  }, [onAfterCollapse])
  const value = useMemo(() => ({ register, collapseAll, hasExpanded }), [register, collapseAll, hasExpanded])
  return <ConversationCollapseContext.Provider value={value}>{children}</ConversationCollapseContext.Provider>
}

/** Register explicit expansion only; automatic current-turn previews do not count. */
export function useConversationCollapse(expanded: boolean, collapse: () => void): boolean {
  const context = useContext(ConversationCollapseContext)
  const register = context?.register
  const id = useRef(Symbol('expanded-record'))
  const collapseRef = useRef(collapse)
  collapseRef.current = collapse
  useLayoutEffect(() => {
    if (!register || !expanded) return
    const key = id.current
    register(key, () => collapseRef.current())
    return () => register(key, null)
  }, [register, expanded])
  return Boolean(context)
}

export function ConversationCollapseControl() {
  const context = useContext(ConversationCollapseContext)
  if (!context?.hasExpanded) return null
  return <CollapseToLatestButton fixedToViewport onClick={context.collapseAll} />
}
