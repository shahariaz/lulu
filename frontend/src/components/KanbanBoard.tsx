import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Task, TaskStatus } from '../types'

interface KanbanBoardProps {
  tasks: Task[]
  activeTaskId: string | null
  onSelectTask: (task: Task) => void
}

const COLUMNS: { id: TaskStatus; num: string; label: string }[] = [
  { id: 'Backlog', num: '01', label: 'BACKLOG' },
  { id: 'Ready', num: '02', label: 'READY' },
  { id: 'In Progress', num: '03', label: 'WORKER' },
  { id: 'Automated Checks', num: '04', label: 'CHECKS' },
  { id: 'Code Review', num: '05', label: 'REVIEW' },
  { id: 'QA', num: '06', label: 'QA ACCEPT' },
  { id: 'Done', num: '07', label: 'DONE' },
  { id: 'Blocked', num: '!!', label: 'BLOCKED' },
  { id: 'Cancelled', num: 'XX', label: 'CANCELLED' },
]

export function KanbanBoard({ tasks, activeTaskId, onSelectTask }: KanbanBoardProps) {
  return (
    <div className="flex-1 overflow-y-auto pb-4 sm:overflow-x-auto sm:overflow-y-hidden">
      <div className="flex min-w-0 flex-col gap-3 sm:h-full sm:min-w-[1180px] sm:flex-row">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.id)
          const hideEmptyExceptional = colTasks.length === 0 && (col.id === 'Blocked' || col.id === 'Cancelled')

          return (
            <div
              key={col.id}
              className={`${hideEmptyExceptional ? 'hidden' : colTasks.length === 0 ? 'hidden sm:flex' : 'flex'} min-h-[180px] flex-1 flex-col rounded-none border-2 border-black bg-swiss-gray p-2.5 sm:h-full sm:min-w-[155px]`}
            >
              {/* Column Header */}
              <div className="mb-2 flex items-center justify-between border-b-2 border-black px-1 pb-2 pt-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[9px] font-black text-swiss-red">{col.num}</span>
                  <span className="text-[10px] font-black uppercase tracking-wider text-black font-mono">
                    {col.label}
                  </span>
                </div>
                <span className="grid h-5 min-w-5 place-items-center rounded-none border border-black bg-black px-1.5 text-[10px] font-black font-mono text-white">
                  {colTasks.length}
                </span>
              </div>

              {/* Task Cards List */}
              <div className="flex-1 overflow-y-auto flex flex-col gap-2.5 pr-0.5">
                <AnimatePresence mode="popLayout">
                  {colTasks.map((task) => {
                    const isSelected = activeTaskId === task.id
                    const isBlocked = task.status === 'Blocked'
                    const reviewerUnavailable = task.waiting_reason === 'SPECIALIST_UNAVAILABLE'

                    return (
                      <motion.button
                        type="button"
                        aria-label={`Open task: ${task.title}`}
                        key={task.id}
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                        onClick={() => onSelectTask(task)}
                        className={`w-full rounded-none border-2 p-3 text-left cursor-pointer transition-colors duration-150 active:translate-y-[1px] select-none ${
                          isSelected
                            ? 'border-black bg-black text-white shadow-none ring-2 ring-swiss-red ring-offset-1'
                            : reviewerUnavailable
                            ? 'border-black bg-amber-50 text-black border-l-4 border-l-amber-600 hover:bg-amber-100'
                            : isBlocked
                            ? 'border-black bg-red-50 text-black border-l-4 border-l-swiss-red hover:bg-red-100'
                            : 'border-black bg-white text-black hover:bg-neutral-100'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1 mb-1">
                          <span className={`line-clamp-2 text-xs font-black uppercase tracking-tight ${isSelected ? 'text-white' : 'text-black'}`}>
                            {task.title}
                          </span>
                        </div>

                        {task.description && (
                          <p className={`text-[11px] line-clamp-2 mb-2 font-medium ${isSelected ? 'text-neutral-300' : 'text-neutral-600'}`}>
                            {task.description}
                          </p>
                        )}

                        {/* Waiting or Blocked Tags */}
                        {task.waiting_reason && (
                          <div className="mb-2">
                            <span className={`inline-block text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-none border ${
                              isSelected
                                ? 'bg-purple-950 text-purple-200 border-purple-400'
                                : 'bg-purple-100 text-purple-900 border-purple-700'
                            }`}>
                              {reviewerUnavailable ? '⚠ REVIEWER UNAVAILABLE' : `⏳ ${task.waiting_reason.replace(/_/g, ' ')}`}
                            </span>
                          </div>
                        )}

                        {task.blocked_reason && (
                          <div className="mb-2">
                            <span className={`inline-block text-[9px] font-mono font-black uppercase px-1.5 py-0.5 rounded-none border ${
                              isSelected
                                ? 'bg-swiss-red text-white border-white'
                                : 'bg-swiss-red text-white border-black'
                            }`}>
                              ⚠️ {task.blocked_reason.replace(/_/g, ' ')}
                            </span>
                          </div>
                        )}

                        {/* Scope Paths Badge */}
                        <div className={`mt-1 flex items-center justify-between border-t pt-2 text-[9px] font-bold uppercase tracking-wider font-mono ${
                          isSelected ? 'border-white/20 text-neutral-300' : 'border-black/15 text-neutral-600'
                        }`}>
                          <span>{task.scope_paths.length} FILES</span>
                          {task.repair_attempts > 0 && (
                            <span className={isSelected ? 'text-amber-300' : 'text-amber-700'}>
                              REPAIRS: {task.repair_attempts}/{task.max_repairs}
                            </span>
                          )}
                        </div>
                      </motion.button>
                    )
                  })}
                </AnimatePresence>

                {colTasks.length === 0 && (
                  <div className="flex flex-1 items-center justify-center rounded-none border-2 border-dashed border-black/20 bg-white/40 p-4 text-center">
                    <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400 font-mono">
                      EMPTY
                    </span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

