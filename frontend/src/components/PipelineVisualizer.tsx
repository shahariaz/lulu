import React from 'react'
import { motion } from 'framer-motion'
import type { TaskStatus } from '../types'

interface PipelineVisualizerProps {
  currentStage: TaskStatus
}

const STAGES: { id: TaskStatus; num: string; label: string }[] = [
  { id: 'Backlog', num: '01', label: 'Backlog' },
  { id: 'Ready', num: '02', label: 'Ready' },
  { id: 'In Progress', num: '03', label: 'Worker' },
  { id: 'Automated Checks', num: '04', label: 'Checks' },
  { id: 'Code Review', num: '05', label: 'Review' },
  { id: 'QA', num: '06', label: 'QA accept' },
  { id: 'Done', num: '07', label: 'Done' },
]

export function PipelineVisualizer({ currentStage }: PipelineVisualizerProps) {
  const currentIndex = STAGES.findIndex((s) => s.id === currentStage)

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label="Task delivery stages"
      className="w-full overflow-x-auto rounded-xl border border-zinc-200/80 bg-white px-5 py-3 shadow-2xs focus:outline-none focus:border-zinc-400"
    >
      <div className="mb-2.5 flex items-center justify-between text-xs text-zinc-500 border-b border-zinc-100 pb-1.5 font-sans">
        <span className="font-medium text-zinc-600">Pipeline lifecycle</span>
        <span className="text-zinc-800 font-semibold">Current: {currentStage}</span>
      </div>
      <div className="flex min-w-[680px] items-center justify-between relative pt-0.5">
        {STAGES.map((stage, idx) => {
          const isPast = currentIndex > idx
          const isCurrent = currentIndex === idx
          const isBlocked = currentStage === 'Blocked'

          return (
            <React.Fragment key={stage.id}>
              {/* Stage Node */}
              <div className="flex flex-col items-center gap-1.5 z-10 relative">
                <motion.div
                  aria-hidden="true"
                  initial={false}
                  animate={{
                    backgroundColor: isPast
                      ? '#18181b'
                      : isCurrent
                      ? (isBlocked ? '#ea3a12' : '#18181b')
                      : '#ffffff',
                    color: (isPast || isCurrent) ? '#ffffff' : '#52525b',
                    borderColor: (isPast || isCurrent) ? '#18181b' : '#e4e4e7',
                  }}
                  className={`flex h-6 w-6 items-center justify-center rounded-md border text-[11px] font-semibold transition-colors select-none shadow-2xs ${
                    isCurrent ? 'ring-2 ring-zinc-300 ring-offset-2' : ''
                  }`}
                >
                  {isPast ? '✓' : stage.num}
                </motion.div>
                <span
                  className={`text-[10px] font-medium tracking-tight ${
                    isCurrent
                      ? 'bg-zinc-900 text-white rounded-md px-2 py-0.5 shadow-2xs font-semibold'
                      : isPast
                      ? 'text-zinc-800 font-medium'
                      : 'text-zinc-400'
                  }`}
                >
                  {stage.label}
                </span>
              </div>

              {/* Connecting Line */}
              {idx < STAGES.length - 1 && (
                <div className="relative mx-2 h-[2px] flex-1 overflow-hidden bg-zinc-100">
                  <motion.div
                    initial={false}
                    animate={{
                      width: isPast ? '100%' : isCurrent ? '50%' : '0%',
                      backgroundColor: isPast ? '#18181b' : '#ea3a12',
                    }}
                    className="h-full"
                    transition={{ duration: 0.2, ease: 'linear' }}
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

