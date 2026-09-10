import React from 'react'
import { cn } from '../../lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-10 w-full rounded-none border-2 border-black bg-white px-3 py-2 text-sm text-black font-medium transition-colors file:border-0 file:bg-transparent file:text-sm file:font-bold placeholder:text-neutral-500 focus-visible:border-swiss-red focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-swiss-red disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-swiss-gray',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

