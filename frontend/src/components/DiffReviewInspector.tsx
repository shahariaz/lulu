import React from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Badge } from './ui/Badge'
import { formatSha } from '../lib/utils'
import type { Task, ReviewRecord, VerificationResult } from '../types'

interface DiffReviewInspectorProps {
  task: Task | null
  candidateCommitSha?: string | null
  diffPatch?: string | null
  verificationResult?: VerificationResult | null
  reviewRecord?: ReviewRecord | null
}

export function DiffReviewInspector({
  task,
  candidateCommitSha,
  diffPatch,
  verificationResult,
  reviewRecord,
}: DiffReviewInspectorProps) {
  if (!task) {
    return (
      <Card className="h-full flex items-center justify-center text-center p-8 bg-zinc-50 border border-zinc-200 rounded-xl">
        <div>
          <p className="text-xs font-medium text-zinc-500">
            Select a task to inspect diffs, test logs, and review verdicts
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto pr-1">
      {/* Header Info */}
      <Card className="p-4 border border-zinc-200/80 bg-white rounded-xl shadow-2xs">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-900">{task.title}</span>
            <Badge variant={task.status.toLowerCase() as any}>{task.status}</Badge>
          </div>
          {candidateCommitSha && (
            <span className="text-[10px] font-mono font-medium bg-zinc-100 text-zinc-700 px-2 py-0.5 rounded-md border border-zinc-200">
              Candidate: <span className="font-semibold text-zinc-900">{formatSha(candidateCommitSha)}</span>
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500">{task.description || 'No description provided.'}</p>
      </Card>

      {/* Specialist Review Card */}
      {reviewRecord && (
        <Card className="p-4 border border-zinc-200/80 bg-white rounded-xl shadow-2xs">
          <div className="flex items-center justify-between mb-2 border-b border-zinc-100 pb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-900">Specialist review</span>
              <Badge variant={reviewRecord.verdict === 'APPROVE' ? 'done' : 'blocked'}>
                {reviewRecord.verdict === 'APPROVE' ? 'Approved' : 'Changes requested'}
              </Badge>
            </div>
            <span className="text-[10px] text-zinc-400 font-mono">
              Digest: {formatSha(reviewRecord.verification_digest)}
            </span>
          </div>
          <p className="text-xs text-zinc-700 mb-3 leading-relaxed">{reviewRecord.summary}</p>

          {reviewRecord.findings && reviewRecord.findings.length > 0 && (
            <div className="flex flex-col gap-2 pt-2 border-t border-zinc-100">
              <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Review findings</span>
              {reviewRecord.findings.map((f, i) => (
                <div key={i} className="text-xs p-2.5 rounded-lg bg-zinc-50 border border-zinc-200/70 font-mono">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-zinc-900">{f.file} {f.line ? `:${f.line}` : ''}</span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-rose-50 text-rose-700 font-medium rounded-md border border-rose-200">
                      {f.severity}
                    </span>
                  </div>
                  <p className="text-zinc-600 text-xs font-sans mt-0.5">{f.description}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Automated Verification Checks Card */}
      {verificationResult && (
        <Card className="p-4 border border-zinc-200/80 bg-white rounded-xl shadow-2xs">
          <div className="flex items-center justify-between mb-2 border-b border-zinc-100 pb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-900">Automated checks</span>
              <Badge variant={verificationResult.passed ? 'done' : 'blocked'}>
                {verificationResult.passed ? 'Passed' : `Failed (${verificationResult.exit_code})`}
              </Badge>
            </div>
            <span className="text-[10px] font-mono text-zinc-500">{verificationResult.command}</span>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 font-mono text-xs text-zinc-200 max-h-[160px] overflow-y-auto whitespace-pre-wrap selection:bg-zinc-700">
            {verificationResult.output_log || 'No log output recorded.'}
          </div>
        </Card>
      )}

      {/* Unified Diff Viewer */}
      <Card className="p-4 flex-1 flex flex-col border border-zinc-200/80 bg-white rounded-xl shadow-2xs">
        <CardHeader className="p-0 pb-2 mb-2 border-b border-zinc-100">
          <CardTitle className="text-xs flex items-center justify-between w-full font-sans">
            <span className="font-semibold text-zinc-900">Unified diff (candidate vs base)</span>
            <span className="text-[10px] font-medium text-zinc-400">Candidate patch</span>
          </CardTitle>
        </CardHeader>
        <div
          role="region"
          tabIndex={0}
          aria-label="Candidate unified diff"
          className="bg-zinc-50/70 border border-zinc-200/80 rounded-lg p-3 font-mono text-xs overflow-x-auto whitespace-pre leading-relaxed flex-1 max-h-[400px]"
        >
          {diffPatch ? (
            diffPatch.split('\n').map((line, idx) => {
              const isAdd = line.startsWith('+') && !line.startsWith('+++')
              const isDel = line.startsWith('-') && !line.startsWith('---')
              const isHeader = line.startsWith('diff --git') || line.startsWith('@@')

              return (
                <div
                  key={idx}
                  className={
                    isAdd
                      ? 'bg-emerald-50 text-emerald-800 font-medium px-1 rounded-xs'
                      : isDel
                      ? 'bg-rose-50 text-rose-800 font-medium px-1 rounded-xs'
                      : isHeader
                      ? 'bg-zinc-200 text-zinc-800 font-semibold px-1 my-0.5 rounded-xs'
                      : 'text-zinc-700 px-1'
                  }
                >
                  {line}
                </div>
              )
            })
          ) : (
            <span className="text-zinc-400 text-xs font-normal">
              No candidate diff available. Run worker task to generate candidate patch.
            </span>
          )}
        </div>
      </Card>
    </div>
  )
}

