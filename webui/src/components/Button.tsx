import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'

export type ButtonVariant =
  | 'secondary'
  | 'primary'
  | 'danger'
  | 'danger-outline'
  | 'warning'
  | 'ghost'
  | 'link'
  | 'link-muted'

export type ButtonSize = 'md' | 'sm' | 'xs'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  loadingText?: ReactNode
}

const VARIANT_SIZE_CLASS: Record<ButtonVariant, Record<ButtonSize, string>> = {
  secondary: {
    md: 'ga-btn',
    sm: 'ga-btn-sm',
    xs: 'ga-btn-xs',
  },
  primary: {
    md: 'ga-btn-primary',
    sm: 'ga-btn-sm-primary',
    xs: 'ga-btn-xs-primary',
  },
  danger: {
    md: 'ga-btn-danger',
    sm: 'ga-btn-sm-solid-danger',
    xs: 'ga-btn-xs-solid-danger',
  },
  'danger-outline': {
    md: 'ga-btn-danger-outline',
    sm: 'ga-btn-sm-danger',
    xs: 'ga-btn-xs-danger',
  },
  warning: {
    md: 'ga-btn-warning-sm h-[34px] px-3 rounded-lg text-sm leading-5',
    sm: 'ga-btn-warning-sm',
    xs: 'ga-btn-warning-sm h-6 px-2 text-[11px]',
  },
  ghost: {
    md: 'ga-btn-ghost h-[34px] px-3 rounded-lg text-sm leading-5',
    sm: 'ga-btn-ghost',
    xs: 'ga-btn-ghost h-6 px-2 text-[11px]',
  },
  link: {
    md: 'ga-btn-link text-sm',
    sm: 'ga-btn-link',
    xs: 'ga-btn-link text-[11px]',
  },
  'link-muted': {
    md: 'ga-btn-link-muted text-sm',
    sm: 'ga-btn-link-muted',
    xs: 'ga-btn-link-muted text-[11px]',
  },
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingText,
    disabled,
    type = 'button',
    className,
    children,
    ...props
  },
  ref,
) {
  const isDisabled = Boolean(disabled || loading)
  const spinnerSize = size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={clsx(VARIANT_SIZE_CLASS[variant][size], className)}
      {...props}
    >
      {loading && <Loader2 className={clsx(spinnerSize, 'shrink-0 animate-spin')} aria-hidden="true" />}
      {loading && loadingText !== undefined ? loadingText : children}
    </button>
  )
})
