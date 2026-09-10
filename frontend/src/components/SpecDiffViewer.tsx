import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import type { Project, RequirementsBaseline } from '../types'
import { api } from '../lib/api'

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
      const data = await api.getProject(project.id)
      setBaselines(data.baselines || [])
      if (data.baselines?.length >= 2) {
        setBaseId1(data.baselines[1].id)
        setBaseId2(data.baselines[0].id)
      }
    } catch {}
  }

  const handleRunDiff = async () => {
    if (!baseId1 || !baseId2) return
    setLoading(true)
    try {
      const data = await api.diffBaselines(baseId1, baseId2)
      setChangelog(data.changelog || '')
      setDiffResult(data.diffResult)

      // Run scope impact analysis
      const impData = await api.analyzeScopeImpact(project!.id, baseId1, baseId2)
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
      const data = await api.applyScopeImpact(project.id, impactReport)
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
      <Card className="h-full flex items-center justify-center text-center p-8 bg-swiss-gray border-2 border-black rounded-none">
        <div>
          <div className="text-xs font-mono font-black uppercase tracking-widest text-neutral-400 mb-1">[EMPTY STATE]</div>
          <p className="text-xs font-bold uppercase tracking-wider text-black">
            SELECT A REPOSITORY TO COMPARE BASELINE REQUIREMENTS
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 h-full divide-x divide-zinc-200 overflow-hidden bg-white">
      {/* Left: Baseline Selector & Changelog */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
          <span className="font-semibold text-zinc-900 text-xs tracking-tight">Requirements delta matrix</span>
          <span className="text-[11px] font-mono text-zinc-500">Diff engine</span>
        </div>

        <div className="flex items-center gap-2.5 p-3.5 border-b border-zinc-200 bg-zinc-50/60 flex-wrap shrink-0">
          <select
            className="flex-1 min-w-[130px] px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-800 font-medium focus:border-zinc-400 outline-none cursor-pointer shadow-2xs"
            value={baseId1}
            onChange={(e) => setBaseId1(e.target.value)}
          >
            <option value="">Previous baseline</option>
            {baselines.map((base) => (
              <option key={base.id} value={base.id}>
                {base.version} · {base.status}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-400 font-medium">→</span>
          <select
            className="flex-1 min-w-[130px] px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-800 font-medium focus:border-zinc-400 outline-none cursor-pointer shadow-2xs"
            value={baseId2}
            onChange={(e) => setBaseId2(e.target.value)}
          >
            <option value="">New baseline</option>
            {baselines.map((base) => (
              <option key={base.id} value={base.id}>
                {base.version} · {base.status}
              </option>
            ))}
          </select>
          <Button
            variant="default"
            size="sm"
            onClick={handleRunDiff}
            disabled={loading || !baseId1 || !baseId2}
          >
            Diff baselines
          </Button>
        </div>

        {/* Formatted Changelog Output */}
        <div className="flex-1 overflow-y-auto bg-zinc-50/40 p-4 font-mono text-xs text-zinc-800 whitespace-pre-wrap leading-relaxed">
          {changelog || 'Select two baseline versions above to audit requirement changes.'}
        </div>
      </div>

      {/* Right: Automated Scope Impact Analysis */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
          <span className="font-semibold text-zinc-900 text-xs tracking-tight">Scope impact audit</span>
          {impactReport && (
            <Badge variant={impactReport.hasImpact ? 'blocked' : 'done'}>
              {impactReport.hasImpact ? 'Impact detected' : 'No impact'}
            </Badge>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {impactReport ? (
            <>
              {/* Affected Tasks */}
              <div>
                <h4 className="text-xs font-semibold text-[#ea3a12] mb-2">
                  Affected tasks requiring rework ({impactReport.affectedTasks.length})
                </h4>
                {impactReport.affectedTasks.map((t: any) => (
                  <div
                    key={t.taskId}
                    className="p-3 rounded-lg bg-rose-50/60 border border-rose-200 text-xs mb-2 flex justify-between items-start shadow-2xs"
                  >
                    <div>
                      <span className="font-semibold text-zinc-900">{t.title}</span>
                      <p className="text-[11px] font-mono text-rose-700 mt-0.5">{t.reason}</p>
                    </div>
                    <Badge variant="blocked">{t.status}</Badge>
                  </div>
                ))}
                {impactReport.affectedTasks.length === 0 && (
                  <p className="text-xs text-zinc-500 font-normal">
                    No active tasks affected by these specification changes.
                  </p>
                )}
              </div>

              {/* Uncovered Requirements */}
              {impactReport.uncoveredNewRequirements.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-zinc-800 mb-2">
                    Uncovered new requirements ({impactReport.uncoveredNewRequirements.length})
                  </h4>
                  {impactReport.uncoveredNewRequirements.map((r: any) => (
                    <div
                      key={r.id}
                      className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 text-xs mb-2 shadow-2xs"
                    >
                      <span className="font-mono font-semibold text-[#ea3a12]">{r.id}: </span>
                      <span className="font-medium text-zinc-900">{r.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Apply Action Button */}
              {impactReport.affectedTasks.length > 0 && (
                <div className="pt-3 mt-auto border-t border-zinc-100 flex justify-end">
                  <Button variant="danger" size="sm" onClick={handleApplyImpact} disabled={loading}>
                    Flag affected tasks for rework
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center p-8 bg-zinc-50 border border-dashed border-zinc-200 rounded-xl m-2">
              <p className="text-xs text-zinc-400 font-medium">
                Run baseline diff to calculate scope impact
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

