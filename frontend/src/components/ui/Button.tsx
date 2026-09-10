import React from 'react'
import { cn } from '../../lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    const base = 'inline-flex items-center justify-center gap-1.5 font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15 disabled:pointer-events-none disabled:opacity-50'

    const variants = {
      default: 'bg-accent hover:bg-accent-hover border border-accent text-white shadow-sm',
      primary: 'bg-success hover:bg-emerald-600 text-white border border-success shadow-sm',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      outline: 'border border-border bg-white hover:bg-slate-50 text-foreground shadow-sm',
      danger: 'bg-danger/15 hover:bg-danger/25 text-danger border border-danger/40',
      ghost: 'hover:bg-slate-100 text-foreground',
    }

    const sizes = {
      sm: 'h-8 px-2.5 text-xs',
      md: 'h-9 px-3.5 text-sm',
      lg: 'h-10 px-5 text-sm',
    }

    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'
