import React from 'react'
import { cn } from '../../lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    const base = 'inline-flex items-center justify-center gap-2 font-bold uppercase tracking-wider transition-colors duration-150 ease-linear rounded-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-swiss-red focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed select-none active:translate-y-[1px]'

    const variants = {
      default: 'bg-black text-white hover:bg-swiss-red hover:text-white border-2 border-black hover:border-swiss-red',
      primary: 'bg-swiss-red text-white hover:bg-black border-2 border-swiss-red hover:border-black',
      secondary: 'bg-white text-black border-2 border-black hover:bg-black hover:text-white',
      outline: 'border-2 border-black bg-white hover:bg-swiss-gray text-black',
      danger: 'bg-swiss-red text-white hover:bg-black border-2 border-black',
      ghost: 'bg-transparent hover:bg-swiss-gray text-black border-2 border-transparent hover:border-black',
    }

    const sizes = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-9 px-4 text-xs',
      lg: 'h-11 px-6 text-sm',
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

