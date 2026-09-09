import React from 'react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card'
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
      <Card className="h-full flex items-center justify-center text-center p-8">
        <p className="text-xs text-muted">Select a task on the board to inspect diffs, test logs, and review verdicts.</p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto pr-1">
      {/* Header Info */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold">{task.title}</span>
            <Badge variant={task.status.toLowerCase() as any}>{task.status}</Badge>
          </div>
          {candidateCommitSha && (
            <span className="text-[11px] font-mono bg-black/30 px-2 py-0.5 rounded border border-border">
              Candidate: <span className="text-accent">{formatSha(candidateCommitSha)}</span>
            </span>
          )}
        </div>
        <p className="text-xs text-muted">{task.description || 'No description provided.'}</p>
      </Card>

      {/* Specialist Review Card */}
      {reviewRecord && (
        <Card className="p-4 border-purple/30 bg-purple/5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-purple">Specialist Code Review</span>
              <Badge variant={reviewRecord.verdict === 'APPROVE' ? 'done' : 'blocked'}>
                {reviewRecord.verdict}
              </Badge>
            </div>
            <span className="text-[10px] text-muted font-mono">
              Digest: {formatSha(reviewRecord.verification_digest)}
            </span>
          </div>
          <p className="text-xs text-foreground/90 mb-2">{reviewRecord.summary}</p>

          {reviewRecord.findings && reviewRecord.findings.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-purple/20">
              {reviewRecord.findings.map((f, i) => (
                <div key={i} className="text-[11px] p-2 rounded bg-black/40 border border-border/60">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-accent">{f.file} {f.line ? `:${f.line}` : ''}</span>
                    <span className="text-[9px] uppercase px-1.5 py-0.2 rounded bg-danger/20 text-danger font-bold">
                      {f.severity}
                    </span>
                  </div>
                  <p className="text-muted">{f.description}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Automated Verification Checks Card */}
      {verificationResult && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">Automated Checks</span>
              <Badge variant={verificationResult.passed ? 'done' : 'blocked'}>
                {verificationResult.passed ? 'PASSED (exit 0)' : `FAILED (exit ${verificationResult.exit_code})`}
              </Badge>
            </div>
            <span className="text-[10px] font-mono text-muted">{verificationResult.command}</span>
          </div>
          <div className="bg-[#05070a] border border-border rounded p-3 font-mono text-[11px] text-muted max-h-[160px] overflow-y-auto whitespace-pre-wrap">
            {verificationResult.output_log || 'No log output.'}
          </div>
        </Card>
      )}

      {/* Unified Diff Viewer */}
      <Card className="p-4 flex-1 flex flex-col">
        <CardHeader className="p-0 pb-2 mb-2">
          <CardTitle className="text-xs flex items-center justify-between w-full">
            <span>Unified Diff (Task Candidate vs Base)</span>
            <span className="text-[10px] font-mono text-muted">Fast-Forward Candidate</span>
          </CardTitle>
        </CardHeader>
        <div className="bg-[#070a0f] border border-border rounded p-3 font-mono text-[11px] overflow-x-auto whitespace-pre leading-relaxed flex-1 max-h-[400px]">
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
                      ? 'bg-success/10 text-emerald-300'
                      : isDel
                      ? 'bg-danger/10 text-red-300'
                      : isHeader
                      ? 'text-accent font-bold py-0.5'
                      : 'text-foreground/80'
                  }
                >
                  {line}
                </div>
              )
            })
          ) : (
            <span className="text-muted">No candidate diff available. Execute worker task to generate candidate commit.</span>
          )}
        </div>
      </Card>
    </div>
  )
}
