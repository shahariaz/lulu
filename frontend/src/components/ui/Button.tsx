import React from 'react'
import { cn } from '../../lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    const base = 'inline-flex items-center justify-center gap-2 font-medium text-xs tracking-normal transition-colors duration-150 ease-out rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:bg-zinc-100 disabled:text-zinc-400 disabled:border-zinc-200 disabled:cursor-not-allowed select-none active:scale-[0.98]'

    const variants = {
      default: 'bg-zinc-900 text-white hover:bg-zinc-800 border border-zinc-900 shadow-xs',
      primary: 'bg-[#ea3a12] text-white hover:bg-[#c82e0a] border border-[#ea3a12] shadow-xs',
      secondary: 'bg-white text-zinc-800 border border-zinc-200 hover:bg-zinc-50 shadow-2xs',
      outline: 'border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-800 shadow-2xs',
      danger: 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100',
      ghost: 'bg-transparent hover:bg-zinc-100 text-zinc-700 border border-transparent',
    }

    const sizes = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-9 px-4 text-xs',
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

