import { useEffect, useRef } from 'react'
import type { BusEventFor } from '@/api/types'
import { hubEventClient } from '@/runtime/hubEventClient'

export function useHubEvent<K extends string = string>(
  prefix: K,
  handler: (event: BusEventFor<K>) => void,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(
    () => hubEventClient.subscribe(prefix, (event) => handlerRef.current(event)),
    [prefix],
  )
}
