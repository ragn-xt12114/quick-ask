import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name. */
  label: string
  /** Native tooltip text (`历史 (Ctrl+H)` etc.). */
  tooltip?: string
  /** 24px variant used inside the 28/32px sidebar rows. */
  compact?: boolean
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
}

/** 32×32 round icon button — §3.3/§3.4. */
export function IconButton({
  label,
  tooltip,
  compact = false,
  className = '',
  type = 'button',
  children,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={tooltip}
      className={`qa-icon-btn${compact ? ' qa-icon-btn--sm' : ''}${
        className ? ` ${className}` : ''
      }`}
      {...rest}
    >
      {children}
    </button>
  )
}
