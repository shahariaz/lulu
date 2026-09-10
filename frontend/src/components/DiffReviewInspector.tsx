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
      <Card className="h-full flex items-center justify-center text-center p-8 bg-swiss-gray border-2 border-black">
        <div>
          <div className="text-xs font-mono font-black uppercase tracking-widest text-neutral-400 mb-1">[EMPTY STATE]</div>
          <p className="text-xs font-bold uppercase tracking-wider text-black">
            SELECT A TASK TO INSPECT DIFFS, TEST LOGS, AND REVIEW VERDICTS
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto pr-1">
      {/* Header Info */}
      <Card className="p-4 border-2 border-black bg-white rounded-none">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-black text-[#ff3000]">[TASK]</span>
            <span className="text-xs font-black uppercase tracking-tight text-black">{task.title}</span>
            <Badge variant={task.status.toLowerCase() as any}>{task.status}</Badge>
          </div>
          {candidateCommitSha && (
            <span className="text-[10px] font-mono font-bold bg-black text-white px-2 py-0.5 border border-black uppercase">
              SHA: <span className="text-[#ff3000]">{formatSha(candidateCommitSha)}</span>
            </span>
          )}
        </div>
        <p className="text-xs font-medium text-neutral-600">{task.description || 'No description provided.'}</p>
      </Card>

      {/* Specialist Review Card */}
      {reviewRecord && (
        <Card className="p-4 border-2 border-black bg-white rounded-none">
          <div className="flex items-center justify-between mb-2 border-b-2 border-black pb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-black uppercase text-purple-900">[REVIEW PASS]</span>
              <span className="text-xs font-black uppercase tracking-wider text-black">Specialist Audit</span>
              <Badge variant={reviewRecord.verdict === 'APPROVE' ? 'done' : 'blocked'}>
                {reviewRecord.verdict}
              </Badge>
            </div>
            <span className="text-[10px] text-neutral-600 font-mono font-bold uppercase">
              DIGEST: {formatSha(reviewRecord.verification_digest)}
            </span>
          </div>
          <p className="text-xs font-medium text-black mb-3">{reviewRecord.summary}</p>

          {reviewRecord.findings && reviewRecord.findings.length > 0 && (
            <div className="flex flex-col gap-2 pt-2 border-t border-black/20">
              <span className="text-[10px] font-mono font-black uppercase tracking-wider text-neutral-500">FINDINGS AUDIT</span>
              {reviewRecord.findings.map((f, i) => (
                <div key={i} className="text-[11px] p-2.5 rounded-none bg-swiss-gray border-2 border-black font-mono">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-black">{f.file} {f.line ? `:${f.line}` : ''}</span>
                    <span className="text-[9px] uppercase px-1.5 py-0.5 bg-[#ff3000] text-white font-black border border-black">
                      {f.severity}
                    </span>
                  </div>
                  <p className="text-neutral-700 text-xs font-sans">{f.description}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Automated Verification Checks Card */}
      {verificationResult && (
        <Card className="p-4 border-2 border-black bg-white rounded-none">
          <div className="flex items-center justify-between mb-2 border-b-2 border-black pb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-black uppercase text-[#ff3000]">[CHECKS]</span>
              <span className="text-xs font-black uppercase tracking-wider text-black">Automated Harness</span>
              <Badge variant={verificationResult.passed ? 'done' : 'blocked'}>
                {verificationResult.passed ? 'PASSED (0)' : `FAILED (${verificationResult.exit_code})`}
              </Badge>
            </div>
            <span className="text-[10px] font-mono font-bold text-neutral-700 uppercase">{verificationResult.command}</span>
          </div>
          <div className="bg-black border-2 border-black rounded-none p-3 font-mono text-[11px] text-neutral-200 max-h-[160px] overflow-y-auto whitespace-pre-wrap selection:bg-[#ff3000] selection:text-white">
            {verificationResult.output_log || 'No log output recorded.'}
          </div>
        </Card>
      )}

      {/* Unified Diff Viewer */}
      <Card className="p-4 flex-1 flex flex-col border-2 border-black bg-white rounded-none">
        <CardHeader className="p-0 pb-2 mb-2 border-b-2 border-black">
          <CardTitle className="text-xs flex items-center justify-between w-full font-mono">
            <span className="font-black uppercase tracking-wider text-black">[DIFF] UNIFIED PATCH VIEW</span>
            <span className="text-[10px] font-bold text-[#ff3000] uppercase">CANDIDATE DELTA</span>
          </CardTitle>
        </CardHeader>
        <div
          role="region"
          tabIndex={0}
          aria-label="Candidate unified diff"
          className="bg-neutral-50 border-2 border-black rounded-none p-3 font-mono text-[11px] overflow-x-auto whitespace-pre leading-relaxed flex-1 max-h-[400px]"
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
                      ? 'bg-emerald-100 text-emerald-950 font-bold px-1'
                      : isDel
                      ? 'bg-red-100 text-red-950 font-bold px-1'
                      : isHeader
                      ? 'bg-black text-white font-black px-1 my-0.5'
                      : 'text-neutral-900 px-1'
                  }
                >
                  {line}
                </div>
              )
            })
          ) : (
            <span className="text-neutral-400 font-bold uppercase tracking-wide">
              No candidate diff available. Run worker task to generate candidate patch.
            </span>
          )}
        </div>
      </Card>
    </div>
  )
}

