import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

export interface SendButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name. */
  label?: string
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
}

/** 36×36 circular send button — §3.3/§3.4. Disabled = 35% opacity. */
export function SendButton({
  label = '发送',
  className = '',
  type = 'button',
  children,
  ref,
  ...rest
}: SendButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={`qa-send${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}
