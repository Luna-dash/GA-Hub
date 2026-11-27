import type { MouseEvent } from 'react'
import {
  Link,
  NavLink,
  useLocation,
  useNavigate,
  useResolvedPath,
  type LinkProps,
  type NavLinkProps,
  type To,
} from 'react-router-dom'
import { confirmLeaveIfDirty, hasDirtyGuard } from '@/stores/navigationGuardStore'

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>, target?: string): boolean {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return false
  if (target && target !== '_self') return false
  return true
}

function useGuardedLinkClick(
  to: To,
  target: string | undefined,
  onClick: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined,
  replace?: boolean,
  state?: unknown,
) {
  const navigate = useNavigate()
  const location = useLocation()
  const resolved = useResolvedPath(to)

  return (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (!isPlainLeftClick(event, target)) return
    if (!hasDirtyGuard()) return
    if (resolved.pathname === location.pathname) return
    event.preventDefault()
    void confirmLeaveIfDirty().then((ok) => {
      if (ok) navigate(to, { replace, state })
    })
  }
}

export function GuardedLink({ to, target, onClick, replace, state, ...rest }: LinkProps) {
  const handleClick = useGuardedLinkClick(to, target, onClick, replace, state)
  return <Link to={to} target={target} replace={replace} state={state} onClick={handleClick} {...rest} />
}

export function GuardedNavLink({ to, target, onClick, replace, state, ...rest }: NavLinkProps) {
  const handleClick = useGuardedLinkClick(to, target, onClick, replace, state)
  return <NavLink to={to} target={target} replace={replace} state={state} onClick={handleClick} {...rest} />
}
