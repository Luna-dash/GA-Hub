import { useCallback } from 'react'
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom'
import { confirmLeaveIfDirty, hasDirtyGuard } from '@/stores/navigationGuardStore'

export function useGuardedNavigate() {
  const navigate = useNavigate()

  return useCallback(
    (to: To | number, options?: NavigateOptions): void | Promise<void> => {
      const go = () => {
        if (typeof to === 'number') navigate(to)
        else if (options !== undefined) navigate(to, options)
        else navigate(to)
      }
      if (!hasDirtyGuard()) {
        go()
        return
      }
      return confirmLeaveIfDirty().then((ok) => {
        if (ok) go()
      })
    },
    [navigate],
  )
}
