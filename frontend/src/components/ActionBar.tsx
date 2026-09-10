import React, { useState } from 'react'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import type { Task, Project } from '../types'

interface ActionBarProps {
  task: Task | null
  project: Project | null
  candidateCommitSha?: string | null
  featureBranch?: string | null
  allTasksDone: boolean
  onAcceptTask: () => Promise<void>
  onRequestChanges: (notes: string) => Promise<void>
  onMergeFeature: () => Promise<void>
}

export function ActionBar({
  task,
  project,
  candidateCommitSha,
  featureBranch,
  allTasksDone,
  onAcceptTask,
  onRequestChanges,
  onMergeFeature,
}: ActionBarProps) {
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  const handleAccept = async () => {
    setLoading(true)
    try {
      await onAcceptTask()
    } finally {
      setLoading(false)
    }
  }

  const handleReject = async () => {
    if (!notes.trim()) return
    setLoading(true)
    try {
      await onRequestChanges(notes)
      setShowRejectModal(false)
      setNotes('')
    } finally {
      setLoading(false)
    }
  }

  const handleMergeFeature = async () => {
    setLoading(true)
    try {
      await onMergeFeature()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="z-20 flex min-h-14 items-center justify-between gap-3 border-t border-zinc-200 bg-white px-5">
      {/* Left: Active Task Context */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs font-semibold text-[#ea3a12] shrink-0">
          Governance
        </span>
        {task ? (
          <>
            <span className="hidden text-xs font-medium text-zinc-900 truncate max-w-[280px] sm:inline">
              {task.title}
            </span>
            <Badge variant={task.status.toLowerCase() as any}>{task.status}</Badge>
            {task.waiting_reason && (
              <span className="text-[11px] text-purple-700 bg-purple-50 px-2 py-0.5 rounded-md border border-purple-200">
                {task.waiting_reason.replace(/_/g, ' ').toLowerCase()}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-zinc-400">
            No active task selected
          </span>
        )}
      </div>

      {/* Right: Decoupled Governance Actions */}
      <div className="flex items-center gap-2.5 shrink-0">
        {/* If task is in QA stage -> Ready for Owner Acceptance */}
        {task && task.status === 'QA' && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowRejectModal(true)}
              disabled={loading}
            >
              Request changes
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleAccept}
              disabled={loading}
            >
              Accept & merge
            </Button>
          </>
        )}

        {/* If all tasks are completed -> Feature Branch Merge into Main */}
        {allTasksDone && project && (
          <Button
            variant="default"
            size="sm"
            onClick={handleMergeFeature}
            disabled={loading}
          >
            Merge feature into {project.active_branch || 'main'}
          </Button>
        )}
      </div>

      {/* Changes Request Feedback Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl">
            <div className="border-b border-zinc-100 pb-2.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900">
                Request corrections
              </h3>
              <span className="text-[11px] font-medium text-[#ea3a12]">Action required</span>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Provide feedback notes for the worker agent. The task will transition back to In Progress and the worker will refine the implementation in its container.
            </p>
            <textarea
              className="h-28 w-full rounded-lg border border-zinc-200 bg-white p-3 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
              placeholder="Specify required fixes, failing assertions, or edge cases..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
              <Button variant="outline" size="sm" onClick={() => setShowRejectModal(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={handleReject} disabled={loading || !notes.trim()}>
                Submit corrections
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

