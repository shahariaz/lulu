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
    <div ref={containerRef} className="w-full bg-card/60 border border-border/80 rounded-lg p-3.5 mb-4 backdrop-blur-sm">
      <div className="flex items-center justify-between relative">
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
                    className="absolute -inset-1 rounded-full bg-accent/30 filter blur-sm pointer-events-none"
                  />
                )}
                <motion.div
                  initial={false}
                  animate={{
                    scale: isCurrent ? 1.15 : 1,
                    backgroundColor: isPast
                      ? '#238636'
                      : isCurrent
                      ? (isBlocked ? '#f85149' : '#58a6ff')
                      : '#161b22',
                    borderColor: isPast
                      ? '#2ea043'
                      : isCurrent
                      ? (isBlocked ? '#f85149' : '#79c0ff')
                      : '#30363d',
                  }}
                  className="w-7 h-7 rounded-full border-2 flex items-center justify-center text-[11px] font-bold text-white shadow-md transition-colors"
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
                <div className="flex-1 h-0.5 mx-1 bg-border relative overflow-hidden">
                  <motion.div
                    initial={false}
                    animate={{
                      width: isPast ? '100%' : isCurrent ? '50%' : '0%',
                      backgroundColor: isPast ? '#2ea043' : '#58a6ff',
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
