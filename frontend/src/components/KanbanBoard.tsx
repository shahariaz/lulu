import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Badge } from './ui/Badge'
import type { Task, TaskStatus } from '../types'

interface KanbanBoardProps {
  tasks: Task[]
  activeTaskId: string | null
  onSelectTask: (task: Task) => void
}

const COLUMNS: { id: TaskStatus; label: string; badge: any }[] = [
  { id: 'Backlog', label: 'Backlog', badge: 'default' },
  { id: 'Ready', label: 'Ready', badge: 'ready' },
  { id: 'In Progress', label: 'Worker', badge: 'progress' },
  { id: 'Automated Checks', label: 'Checks', badge: 'checks' },
  { id: 'Code Review', label: 'Review', badge: 'review' },
  { id: 'QA', label: 'QA (Accept)', badge: 'qa' },
  { id: 'Done', label: 'Done', badge: 'done' },
  { id: 'Blocked', label: 'Blocked', badge: 'blocked' },
  { id: 'Cancelled', label: 'Cancelled', badge: 'default' },
]

export function KanbanBoard({ tasks, activeTaskId, onSelectTask }: KanbanBoardProps) {
  return (
    <div className="flex-1 overflow-y-auto pb-4 sm:overflow-x-auto sm:overflow-y-hidden">
      <div className="flex min-w-0 flex-col gap-3 sm:h-full sm:min-w-[1120px] sm:flex-row">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.id)
          const hideEmptyExceptional = colTasks.length === 0 && (col.id === 'Blocked' || col.id === 'Cancelled')

          return (
            <div
              key={col.id}
              className={`${hideEmptyExceptional ? 'hidden' : colTasks.length === 0 ? 'hidden sm:flex' : 'flex'} min-h-[170px] flex-1 flex-col rounded-lg border border-border bg-[#efefec]/70 p-2.5 sm:h-full sm:min-w-[145px]`}
            >
              {/* Column Header */}
              <div className="mb-2 flex items-center justify-between px-1 pb-2 pt-1">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-muted">
                  {col.label}
                </span>
                <span className="grid h-5 min-w-5 place-items-center rounded bg-[#dededb] px-1.5 text-[10px] font-semibold text-muted">
                  {colTasks.length}
                </span>
              </div>

              {/* Task Cards List */}
              <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
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
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.2 }}
                        onClick={() => onSelectTask(task)}
                        className={`w-full rounded-md border p-3.5 text-left cursor-pointer transition-colors ${
                          isSelected
                            ? 'border-accent bg-blue-50 ring-1 ring-accent/10'
                            : reviewerUnavailable
                            ? 'border-warning/50 bg-warning/10 hover:border-warning'
                            : isBlocked
                            ? 'border-danger/40 bg-danger/5 hover:border-danger/70'
                            : 'border-border bg-white hover:border-[#aaa9a4]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1 mb-1.5">
                          <span className="line-clamp-2 text-xs font-bold leading-relaxed text-foreground">
                            {task.title}
                          </span>
                        </div>

                        {task.description && (
                          <p className="text-[11px] text-muted line-clamp-2 mb-2">
                            {task.description}
                          </p>
                        )}

                        {/* Waiting or Blocked Tags */}
                        {task.waiting_reason && (
                          <div className="mb-2">
                            <span className="text-[9px] font-mono text-purple bg-purple/10 px-1.5 py-0.5 rounded border border-purple/20">
                              {reviewerUnavailable ? '⚠ Independent reviewer unavailable' : `⏳ ${task.waiting_reason.replace(/_/g, ' ')}`}
                            </span>
                          </div>
                        )}

                        {task.blocked_reason && (
                          <div className="mb-2">
                            <span className="text-[9px] font-mono text-danger bg-danger/10 px-1.5 py-0.5 rounded border border-danger/20">
                              ⚠️ {task.blocked_reason.replace(/_/g, ' ')}
                            </span>
                          </div>
                        )}

                        {/* Scope Paths Badge */}
                        <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-2 text-[9px] font-semibold uppercase tracking-wide text-muted">
                          <span>{task.scope_paths.length} file(s)</span>
                          {task.repair_attempts > 0 && (
                            <span className="text-warning">Repairs: {task.repair_attempts}/{task.max_repairs}</span>
                          )}
                        </div>
                      </motion.button>
                    )
                  })}
                </AnimatePresence>

                {colTasks.length === 0 && (
                  <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border bg-white/30 p-4 text-center">
                    <span className="text-[10px] font-medium text-muted">No tasks here</span>
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
