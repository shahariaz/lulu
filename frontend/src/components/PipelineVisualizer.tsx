import React, { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { motion } from 'framer-motion'
import type { TaskStatus } from '../types'

interface PipelineVisualizerProps {
  currentStage: TaskStatus
}

const STAGES: { id: TaskStatus; label: string }[] = [
  { id: 'Backlog', label: 'Backlog' },
  { id: 'Ready', label: 'Ready' },
  { id: 'In Progress', label: 'Worker' },
  { id: 'Automated Checks', label: 'Checks' },
  { id: 'Code Review', label: 'Review' },
  { id: 'QA', label: 'QA (Accept)' },
  { id: 'Done', label: 'Done' },
]

export function PipelineVisualizer({ currentStage }: PipelineVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)

  const currentIndex = STAGES.findIndex((s) => s.id === currentStage)

  useEffect(() => {
    if (!containerRef.current || !glowRef.current) return

    // GSAP animation on stage transition
    gsap.fromTo(
      glowRef.current,
      { opacity: 0.3, scale: 0.95 },
      { opacity: 0.8, scale: 1.05, duration: 0.8, yoyo: true, repeat: -1, ease: 'sine.inOut' }
    )
  }, [currentStage])

  return (
    <div ref={containerRef} role="region" tabIndex={0} aria-label="Task delivery stages" className="mb-4 w-full overflow-x-auto rounded-lg border border-border bg-white px-5 py-3.5 focus:outline-none focus:ring-2 focus:ring-accent/20">
      <div className="flex min-w-[680px] items-center justify-between relative">
        {STAGES.map((stage, idx) => {
          const isPast = currentIndex > idx
          const isCurrent = currentIndex === idx
          const isBlocked = currentStage === 'Blocked'

          return (
            <React.Fragment key={stage.id}>
              {/* Stage Node */}
              <div className="flex flex-col items-center gap-1.5 z-10 relative">
                {isCurrent && (
                  <div
                    ref={glowRef}
                    className="pointer-events-none absolute -inset-1 rounded-md bg-accent/10"
                  />
                )}
                <motion.div
                  aria-hidden="true"
                  initial={false}
                  animate={{
                    scale: isCurrent ? 1.15 : 1,
                    backgroundColor: isPast
                      ? '#0e9f6e'
                      : isCurrent
                      ? (isBlocked ? '#dc3545' : '#3157d5')
                      : '#eef2f8',
                    borderColor: isPast
                      ? '#34d399'
                      : isCurrent
                      ? (isBlocked ? '#dc3545' : '#6f88dc')
                      : '#dce3ee',
                  }}
                  className={`flex h-7 w-7 items-center justify-center rounded-md border text-[10px] font-semibold transition-colors ${isPast || isCurrent ? 'text-white' : 'text-muted'}`}
                >
                  {isPast ? '✓' : idx + 1}
                </motion.div>
                <span
                  className={`text-[10px] font-semibold tracking-wide uppercase ${
                    isCurrent ? 'text-accent' : isPast ? 'text-success' : 'text-muted'
                  }`}
                >
                  {stage.label}
                </span>
              </div>

              {/* Connecting Line */}
              {idx < STAGES.length - 1 && (
                <div className="relative mx-2 h-px flex-1 overflow-hidden bg-border">
                  <motion.div
                    initial={false}
                    animate={{
                      width: isPast ? '100%' : isCurrent ? '50%' : '0%',
                      backgroundColor: isPast ? '#0e9f6e' : '#3157d5',
                    }}
                    className="h-full"
                    transition={{ duration: 0.4 }}
                  />
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}
