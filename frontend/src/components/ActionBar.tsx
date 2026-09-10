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
    <div className="z-20 flex min-h-14 items-center justify-between gap-3 border-t-2 border-black bg-white px-4 sm:px-7 rounded-none">
      {/* Left: Active Task Context */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-[10px] font-mono font-black uppercase tracking-wider text-swiss-red shrink-0">
          [GOVERNANCE]
        </span>
        {task ? (
          <>
            <span className="hidden text-xs font-black uppercase tracking-tight text-black truncate max-w-[280px] sm:inline font-sans">
              {task.title}
            </span>
            <Badge variant={task.status.toLowerCase() as any}>{task.status}</Badge>
            {task.waiting_reason && (
              <span className="text-[10px] font-mono font-bold uppercase text-purple-900 bg-purple-100 px-2 py-0.5 border border-black">
                {task.waiting_reason.replace(/_/g, ' ')}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs font-mono font-semibold uppercase text-neutral-500">
            NO ACTIVE TASK SELECTED
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
              REQUEST CHANGES
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleAccept}
              disabled={loading}
            >
              ACCEPT & FF-MERGE
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
            className="bg-black text-white hover:bg-swiss-red hover:border-swiss-red border-2 border-black"
          >
            MERGE FEATURE INTO {project.active_branch || 'MAIN'}
          </Button>
        )}
      </div>

      {/* Changes Request Feedback Modal */}
      {showRejectModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="flex w-full max-w-md flex-col gap-3 rounded-none border-4 border-black bg-white p-6 shadow-none">
            <div className="border-b-2 border-black pb-2 flex items-center justify-between">
              <h3 className="text-sm font-black uppercase tracking-wider text-black font-mono">
                [00] REQUEST CORRECTIONS
              </h3>
              <span className="text-[10px] font-mono font-bold text-swiss-red uppercase">ACTION REQUIRED</span>
            </div>
            <p className="text-xs font-medium text-neutral-700 leading-relaxed">
              Provide feedback notes for the worker agent. The task will transition back to In Progress and the worker will refine the implementation in its container.
            </p>
            <textarea
              className="h-28 w-full rounded-none border-2 border-black bg-white p-3 text-xs font-medium text-black placeholder:text-neutral-400 focus:border-swiss-red focus:outline-none focus:ring-1 focus:ring-swiss-red resize-none"
              placeholder="Specify required fixes, failing assertions, or edge-cases..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-black/20">
              <Button variant="outline" size="sm" onClick={() => setShowRejectModal(false)}>
                CANCEL
              </Button>
              <Button variant="danger" size="sm" onClick={handleReject} disabled={loading || !notes.trim()}>
                SUBMIT CORRECTIONS
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

