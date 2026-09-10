import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Task, TaskStatus } from '../types'

interface KanbanBoardProps {
  tasks: Task[]
  activeTaskId: string | null
  onSelectTask: (task: Task) => void
}

const COLUMNS: { id: TaskStatus; num: string; label: string }[] = [
  { id: 'Backlog', num: '01', label: 'Backlog' },
  { id: 'Ready', num: '02', label: 'Ready' },
  { id: 'In Progress', num: '03', label: 'Worker' },
  { id: 'Automated Checks', num: '04', label: 'Checks' },
  { id: 'Code Review', num: '05', label: 'Review' },
  { id: 'QA', num: '06', label: 'QA accept' },
  { id: 'Done', num: '07', label: 'Done' },
  { id: 'Blocked', num: '!!', label: 'Blocked' },
  { id: 'Cancelled', num: 'XX', label: 'Cancelled' },
]

export function KanbanBoard({ tasks, activeTaskId, onSelectTask }: KanbanBoardProps) {
  return (
    <div className="flex-1 overflow-y-auto sm:overflow-x-auto sm:overflow-y-hidden h-full">
      <div className="flex min-w-0 flex-col gap-3 sm:h-full sm:min-w-[1180px] sm:flex-row pb-1">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.id)
          const hideEmptyExceptional = colTasks.length === 0 && (col.id === 'Blocked' || col.id === 'Cancelled')

          return (
            <div
              key={col.id}
              className={`${hideEmptyExceptional ? 'hidden' : colTasks.length === 0 ? 'hidden sm:flex' : 'flex'} min-h-[180px] flex-1 flex-col rounded-xl border border-zinc-200/80 bg-zinc-50/50 p-3 sm:h-full sm:min-w-[155px]`}
            >
              {/* Column Header */}
              <div className="mb-2.5 flex items-center justify-between px-1 pb-2 border-b border-zinc-200/70">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] font-medium text-[#ea3a12]">{col.num}</span>
                  <span className="text-xs font-semibold text-zinc-900">
                    {col.label}
                  </span>
                </div>
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-zinc-200 px-1.5 text-[10px] font-semibold text-zinc-700">
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
                        className={`w-full rounded-lg border p-3.5 text-left cursor-pointer transition-all duration-150 select-none shadow-2xs ${
                          isSelected
                            ? 'border-zinc-900 bg-zinc-900 text-white shadow-xs ring-2 ring-[#ea3a12]'
                            : reviewerUnavailable
                            ? 'border-amber-200 bg-amber-50/60 text-zinc-900 hover:bg-amber-50'
                            : isBlocked
                            ? 'border-rose-200 bg-rose-50/60 text-zinc-900 hover:bg-rose-50'
                            : 'border-zinc-200 bg-white text-zinc-900 hover:border-zinc-300 hover:shadow-xs'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1 mb-1">
                          <span className={`line-clamp-2 text-xs font-semibold leading-snug ${isSelected ? 'text-white' : 'text-zinc-900'}`}>
                            {task.title}
                          </span>
                        </div>

                        {task.description && (
                          <p className={`text-[11px] line-clamp-2 mb-2 font-normal ${isSelected ? 'text-zinc-300' : 'text-zinc-500'}`}>
                            {task.description}
                          </p>
                        )}

                        {/* Waiting or Blocked Tags */}
                        {task.waiting_reason && (
                          <div className="mb-2">
                            <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-md border ${
                              isSelected
                                ? 'bg-purple-900/60 text-purple-200 border-purple-700'
                                : 'bg-purple-50 text-purple-700 border-purple-200'
                            }`}>
                              {reviewerUnavailable ? 'Reviewer unavailable' : task.waiting_reason.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          </div>
                        )}

                        {task.blocked_reason && (
                          <div className="mb-2">
                            <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-md border ${
                              isSelected
                                ? 'bg-rose-900/60 text-rose-200 border-rose-700'
                                : 'bg-rose-50 text-rose-700 border-rose-200'
                            }`}>
                              Blocked: {task.blocked_reason.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          </div>
                        )}

                        {/* Scope Paths Badge */}
                        <div className={`mt-1 flex items-center justify-between border-t pt-2 text-[10px] ${
                          isSelected ? 'border-zinc-700 text-zinc-400' : 'border-zinc-100 text-zinc-500'
                        }`}>
                          <span>{task.scope_paths.length} {task.scope_paths.length === 1 ? 'file' : 'files'}</span>
                          {task.repair_attempts > 0 && (
                            <span className={isSelected ? 'text-amber-300' : 'text-amber-600'}>
                              Repairs: {task.repair_attempts}/{task.max_repairs}
                            </span>
                          )}
                        </div>
                      </motion.button>
                    )
                  })}
                </AnimatePresence>

                {colTasks.length === 0 && (
                  <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-200/80 bg-white/40 p-4 text-center">
                    <span className="text-xs text-zinc-400">
                      No tasks
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

