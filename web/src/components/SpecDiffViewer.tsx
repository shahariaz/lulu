import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import type { Project, RequirementsBaseline } from '../types'

interface SpecDiffViewerProps {
  project: Project | null
}

export function SpecDiffViewer({ project }: SpecDiffViewerProps) {
  const [baselines, setBaselines] = useState<RequirementsBaseline[]>([])
  const [baseId1, setBaseId1] = useState<string>('')
  const [baseId2, setBaseId2] = useState<string>('')
  const [changelog, setChangelog] = useState<string>('')
  const [diffResult, setDiffResult] = useState<any>(null)
  const [impactReport, setImpactReport] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [appliedCount, setAppliedCount] = useState<number | null>(null)

  useEffect(() => {
    if (project) {
      loadBaselines()
    }
  }, [project?.id])

  const loadBaselines = async () => {
    if (!project) return
    try {
      const res = await fetch(`/api/orchestrator/projects/${project.id}`)
      const data = await res.json()
      // We can load baselines from the project
    } catch {}
  }

  const handleRunDiff = async () => {
    if (!baseId1 || !baseId2) return
    setLoading(true)
    try {
      const res = await fetch(`/api/orchestrator/baselines/${baseId1}/diff/${baseId2}`)
      const data = await res.json()
      setChangelog(data.changelog || '')
      setDiffResult(data.diffResult)

      // Run scope impact analysis
      const impRes = await fetch('/api/orchestrator/baselines/scope-impact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project?.id,
          previousBaselineId: baseId1,
          newBaselineId: baseId2,
        }),
      })
      const impData = await impRes.json()
      setImpactReport(impData.report)
    } catch (err: any) {
      alert(`Diff failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleApplyImpact = async () => {
    if (!impactReport || !project) return
    setLoading(true)
    try {
      const res = await fetch('/api/orchestrator/baselines/apply-impact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          impactReport,
        }),
      })
      const data = await res.json()
      setAppliedCount(data.affectedCount)
      alert(`Scope impact successfully applied! ${data.affectedCount} task(s) flagged for rework.`)
    } catch (err: any) {
      alert(`Could not apply impact: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  if (!project) {
    return (
      <Card className="h-full flex items-center justify-center text-center p-8">
        <p className="text-xs text-muted">Select a project to compare baseline requirements versions.</p>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full overflow-hidden">
      {/* Left: Baseline Selector & Changelog */}
      <Card className="flex flex-col h-full p-4">
        <CardHeader className="p-0 pb-3 mb-3">
          <CardTitle className="text-xs flex items-center justify-between">
            <span>Requirements Version Comparison</span>
            <Badge variant="ready">PRD Diff Engine</Badge>
          </CardTitle>
        </CardHeader>

        <div className="flex items-center gap-2 mb-3">
          <input
            className="flex-1 px-3 py-1.5 rounded border border-border bg-black/30 font-mono text-xs text-foreground"
            placeholder="Previous Baseline ID (v1.0.0)"
            value={baseId1}
            onChange={(e) => setBaseId1(e.target.value)}
          />
          <span className="text-xs text-muted">&rarr;</span>
          <input
            className="flex-1 px-3 py-1.5 rounded border border-border bg-black/30 font-mono text-xs text-foreground"
            placeholder="New Baseline ID (v1.1.0)"
            value={baseId2}
            onChange={(e) => setBaseId2(e.target.value)}
          />
          <Button variant="primary" size="sm" onClick={handleRunDiff} disabled={loading || !baseId1 || !baseId2}>
            Diff Baselines
          </Button>
        </div>

        {/* Formatted Changelog Output */}
        <div className="flex-1 overflow-y-auto bg-[#070a0f] border border-border rounded p-3 font-mono text-xs text-foreground whitespace-pre-wrap leading-relaxed">
          {changelog || 'Enter two baseline IDs above to inspect requirement changes and release notes.'}
        </div>
      </Card>

      {/* Right: Automated Scope Impact Analysis */}
      <Card className="flex flex-col h-full p-4">
        <CardHeader className="p-0 pb-3 mb-3">
          <CardTitle className="text-xs flex items-center justify-between">
            <span>Automated Task Scope Impact</span>
            {impactReport && (
              <Badge variant={impactReport.hasImpact ? 'blocked' : 'done'}>
                {impactReport.hasImpact ? 'Impact Detected' : 'No Task Impact'}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>

        <div className="flex-1 overflow-y-auto flex flex-col gap-3">
          {impactReport ? (
            <>
              {/* Affected Tasks */}
              <div>
                <h4 className="text-xs font-bold text-danger mb-1.5">
                  Affected Tasks Requiring Rework ({impactReport.affectedTasks.length})
                </h4>
                {impactReport.affectedTasks.map((t: any) => (
                  <div key={t.taskId} className="p-2 rounded bg-danger/10 border border-danger/30 text-xs mb-1.5 flex justify-between">
                    <div>
                      <span className="font-semibold">{t.title}</span>
                      <p className="text-[10px] text-danger/80">{t.reason}</p>
                    </div>
                    <Badge variant="blocked">{t.status}</Badge>
                  </div>
                ))}
                {impactReport.affectedTasks.length === 0 && (
                  <p className="text-xs text-muted">No existing tasks affected by these requirement changes.</p>
                )}
              </div>

              {/* Uncovered Requirements */}
              {impactReport.uncoveredNewRequirements.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-accent mb-1.5">
                    Uncovered New Requirements ({impactReport.uncoveredNewRequirements.length})
                  </h4>
                  {impactReport.uncoveredNewRequirements.map((r: any) => (
                    <div key={r.id} className="p-2 rounded bg-accent/10 border border-accent/30 text-xs mb-1.5">
                      <span className="font-bold">{r.id}: </span>
                      <span>{r.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Apply Action Button */}
              {impactReport.affectedTasks.length > 0 && (
                <div className="pt-3 mt-auto border-t border-border flex justify-end">
                  <Button variant="danger" size="sm" onClick={handleApplyImpact} disabled={loading}>
                    Flag Affected Tasks for Rework
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center p-8">
              <p className="text-xs text-muted">Run a baseline diff to detect scope impact on existing project tasks.</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
