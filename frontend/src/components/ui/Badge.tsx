import React from 'react'
import { cn } from '../../lib/utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'ready' | 'progress' | 'checks' | 'review' | 'qa' | 'done' | 'blocked'
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  const variants = {
    default: 'border-border text-foreground bg-white/5',
    ready: 'border-accent/40 text-accent bg-accent/10',
    progress: 'border-warning/40 text-warning bg-warning/10',
    checks: 'border-cyan-500/40 text-cyan-400 bg-cyan-500/10',
    review: 'border-purple/40 text-purple bg-purple/10',
    qa: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10',
    done: 'border-success/40 text-success bg-success/10',
    blocked: 'border-danger/40 text-danger bg-danger/10',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        variants[variant],
        className
      )}
      {...props}
    />
  )
}
