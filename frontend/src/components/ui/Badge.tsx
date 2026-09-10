import React from 'react'
import { cn } from '../../lib/utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'ready' | 'progress' | 'checks' | 'review' | 'qa' | 'done' | 'blocked'
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  const variants = {
    default: 'border-2 border-black text-black bg-swiss-gray',
    ready: 'border-2 border-black text-black bg-white',
    progress: 'border-2 border-black text-black bg-amber-200',
    checks: 'border-2 border-black text-black bg-sky-200',
    review: 'border-2 border-black text-white bg-purple-900',
    qa: 'border-2 border-black text-black bg-emerald-200',
    done: 'border-2 border-black text-white bg-emerald-700',
    blocked: 'border-2 border-black text-white bg-swiss-red font-black',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-none px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors select-none font-mono',
        variants[variant],
        className
      )}
      {...props}
    />
  )
}

