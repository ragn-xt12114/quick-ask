import type { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `bar` applies the 24px capsule radius; the default is the 16px card radius. */
  variant?: 'default' | 'bar'
  children?: ReactNode
}

/**
 * Shared translucent surface — §3.2/§3.10. All cards use the same background,
 * inner 1px border and outer shadow tokens; only the radius differs.
 */
export function Card({ variant = 'default', className = '', children, ...rest }: CardProps) {
  return (
    <div
      className={`qa-card qa-card--${variant}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </div>
  )
}
