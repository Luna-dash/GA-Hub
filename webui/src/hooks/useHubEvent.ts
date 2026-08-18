import { useEffect, useRef } from 'react'
import type { BusEvent } from '@/api/types'
import { hubEventClient } from '@/runtime/hubEventClient'

export function useHubEvent(prefix: string, handler: (event: BusEvent) => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(
    () => hubEventClient.subscribe(prefix, (event) => handlerRef.current(event)),
    [prefix],
  )
}
