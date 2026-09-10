import React from 'react'
import { motion } from 'framer-motion'
import type { TaskStatus } from '../types'

interface PipelineVisualizerProps {
  currentStage: TaskStatus
}

const STAGES: { id: TaskStatus; num: string; label: string }[] = [
  { id: 'Backlog', num: '01', label: 'BACKLOG' },
  { id: 'Ready', num: '02', label: 'READY' },
  { id: 'In Progress', num: '03', label: 'WORKER' },
  { id: 'Automated Checks', num: '04', label: 'CHECKS' },
  { id: 'Code Review', num: '05', label: 'REVIEW' },
  { id: 'QA', num: '06', label: 'QA / ACCEPT' },
  { id: 'Done', num: '07', label: 'DONE' },
]

export function PipelineVisualizer({ currentStage }: PipelineVisualizerProps) {
  const currentIndex = STAGES.findIndex((s) => s.id === currentStage)

  return (
    <div
      role="region"
      tabIndex={0}
      aria-label="Task delivery stages"
      className="mb-4 w-full overflow-x-auto rounded-none border-2 border-black bg-white px-5 py-3.5 focus:outline-none focus:border-swiss-red"
    >
      <div className="mb-2 flex items-center justify-between text-[9px] font-mono font-black uppercase tracking-widest text-neutral-500 border-b border-black/15 pb-1">
        <span>[PIPELINE PROTOCOL] STAGE LIFECYCLE</span>
        <span className="text-black font-bold">CURRENT: {currentStage.toUpperCase()}</span>
      </div>
      <div className="flex min-w-[700px] items-center justify-between relative pt-1">
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
                      ? '#000000'
                      : isCurrent
                      ? (isBlocked ? '#ff3000' : '#ff3000')
                      : '#ffffff',
                    color: (isPast || isCurrent) ? '#ffffff' : '#000000',
                  }}
                  className={`flex h-7 w-7 items-center justify-center rounded-none border-2 border-black text-[11px] font-black font-mono transition-colors select-none ${
                    isCurrent ? 'ring-2 ring-black ring-offset-2' : ''
                  }`}
                >
                  {isPast ? '✓' : stage.num}
                </motion.div>
                <span
                  className={`text-[9px] font-black tracking-widest uppercase font-mono ${
                    isCurrent
                      ? 'text-swiss-red bg-black text-white px-1.5 py-0.5'
                      : isPast
                      ? 'text-black'
                      : 'text-neutral-400'
                  }`}
                >
                  {stage.label}
                </span>
              </div>

              {/* Connecting Line */}
              {idx < STAGES.length - 1 && (
                <div className="relative mx-2 h-[2px] flex-1 overflow-hidden bg-black/20">
                  <motion.div
                    initial={false}
                    animate={{
                      width: isPast ? '100%' : isCurrent ? '50%' : '0%',
                      backgroundColor: isPast ? '#000000' : '#ff3000',
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

