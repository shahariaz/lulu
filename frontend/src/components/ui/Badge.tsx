import React from 'react'
import { cn } from '../../lib/utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'ready' | 'progress' | 'checks' | 'review' | 'qa' | 'done' | 'blocked'
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  const variants = {
    default: 'border-zinc-200 text-zinc-600 bg-zinc-50',
    ready: 'border-zinc-300 text-zinc-800 bg-white',
    progress: 'border-amber-200 text-amber-700 bg-amber-50',
    checks: 'border-sky-200 text-sky-700 bg-sky-50',
    review: 'border-purple-200 text-purple-700 bg-purple-50',
    qa: 'border-emerald-200 text-emerald-700 bg-emerald-50',
    done: 'border-emerald-200 text-emerald-700 bg-emerald-50',
    blocked: 'border-rose-200 text-rose-700 bg-rose-50 font-semibold',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors select-none font-sans',
        variants[variant],
        className
      )}
      {...props}
    />
  )
}

