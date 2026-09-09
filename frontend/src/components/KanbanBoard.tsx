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
]

export function KanbanBoard({ tasks, activeTaskId, onSelectTask }: KanbanBoardProps) {
  return (
    <div className="flex-1 overflow-x-auto pb-4">
      <div className="flex gap-3 min-w-[1300px] h-full">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.id)

          return (
            <div
              key={col.id}
              className="flex-1 flex flex-col bg-card/40 border border-border/70 rounded-lg p-2.5 min-w-[180px] max-w-[260px] h-full"
            >
              {/* Column Header */}
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/60">
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted">
                  {col.label}
                </span>
                <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-white/5 text-muted">
                  {colTasks.length}
                </span>
              </div>

              {/* Task Cards List */}
              <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
                <AnimatePresence mode="popLayout">
                  {colTasks.map((task) => {
                    const isSelected = activeTaskId === task.id
                    const isBlocked = task.status === 'Blocked'

                    return (
                      <motion.div
                        key={task.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.2 }}
                        onClick={() => onSelectTask(task)}
                        className={`p-3 rounded-md border text-left cursor-pointer transition-all ${
                          isSelected
                            ? 'border-accent bg-accent/10 shadow-sm'
                            : 'border-border bg-card hover:border-border/90 hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1 mb-1.5">
                          <span className="text-xs font-semibold text-foreground line-clamp-2">
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
                              ⏳ {task.waiting_reason.replace(/_/g, ' ')}
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
                        <div className="flex items-center justify-between text-[10px] text-muted font-mono pt-1 border-t border-border/40">
                          <span>{task.scope_paths.length} file(s)</span>
                          {task.repair_attempts > 0 && (
                            <span className="text-warning">Repairs: {task.repair_attempts}/{task.max_repairs}</span>
                          )}
                        </div>
                      </motion.div>
                    )
                  })}
                </AnimatePresence>

                {colTasks.length === 0 && (
                  <div className="flex-1 flex items-center justify-center p-4 border border-dashed border-border/40 rounded text-center">
                    <span className="text-[11px] text-muted/60">Empty</span>
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
