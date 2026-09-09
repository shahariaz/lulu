import React, { useState } from 'react'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
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
    <div className="h-14 border-t border-border bg-card/80 px-6 flex items-center justify-between backdrop-blur-sm z-20">
      {/* Left: Active Task Context */}
      <div className="flex items-center gap-3">
        {task ? (
          <>
            <span className="text-xs font-semibold text-foreground truncate max-w-[280px]">
              Task: {task.title}
            </span>
            <Badge variant={task.status.toLowerCase() as any}>{task.status}</Badge>
            {task.waiting_reason && (
              <span className="text-[10px] font-mono text-purple bg-purple/10 px-2 py-0.5 rounded border border-purple/20">
                {task.waiting_reason.replace(/_/g, ' ')}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-muted">No task selected</span>
        )}
      </div>

      {/* Right: Decoupled Governance Actions */}
      <div className="flex items-center gap-2.5">
        {/* If task is in QA stage -> Ready for Owner Acceptance */}
        {task && task.status === 'QA' && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRejectModal(true)}
              disabled={loading}
            >
              Request Changes
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleAccept}
              disabled={loading}
            >
              Accept & Fast-Forward Merge
            </Button>
          </>
        )}

        {/* If all tasks are completed -> Feature Branch Merge into Main */}
        {allTasksDone && project && (
          <Button
            variant="primary"
            size="sm"
            onClick={handleMergeFeature}
            disabled={loading}
            className="bg-emerald-600 hover:bg-emerald-500 border-emerald-500"
          >
            Merge Feature into {project.active_branch || 'main'}
          </Button>
        )}
      </div>

      {/* Changes Request Feedback Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full shadow-xl flex flex-col gap-3">
            <h3 className="text-sm font-bold">Request Task Changes & Corrections</h3>
            <p className="text-xs text-muted">
              Provide feedback notes for the worker agent. The task will transition back to In Progress and the worker will refine the implementation.
            </p>
            <textarea
              className="w-full h-24 p-2.5 rounded border border-border bg-black/30 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
              placeholder="Explain the required fixes, edge cases, or test changes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowRejectModal(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={handleReject} disabled={loading || !notes.trim()}>
                Submit Correction Notes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
