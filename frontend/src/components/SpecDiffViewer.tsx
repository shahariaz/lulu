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
    <div className="grid grid-cols-1 lg:grid-cols-2 h-full divide-x-2 divide-black overflow-hidden bg-white">
      {/* Left: Baseline Selector & Changelog */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b-2 border-black px-5 py-3.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[01] REQUIREMENTS DELTA MATRIX</span>
          <span className="text-[10px] font-mono font-bold text-[#ff3000] uppercase">DIFF ENGINE</span>
        </div>

        <div className="flex items-center gap-2 p-3.5 border-b-2 border-black bg-neutral-50 flex-wrap shrink-0">
          <select
            className="flex-1 min-w-[130px] px-3 py-1.5 rounded-none border-2 border-black bg-white font-mono text-xs text-black font-bold focus:border-[#ff3000] outline-none cursor-pointer"
            value={baseId1}
            onChange={(e) => setBaseId1(e.target.value)}
          >
            <option value="">PREVIOUS BASELINE</option>
            {baselines.map((base) => (
              <option key={base.id} value={base.id}>
                {base.version} · {base.status.toUpperCase()}
              </option>
            ))}
          </select>
          <span className="text-xs font-black text-black font-mono">→</span>
          <select
            className="flex-1 min-w-[130px] px-3 py-1.5 rounded-none border-2 border-black bg-white font-mono text-xs text-black font-bold focus:border-[#ff3000] outline-none cursor-pointer"
            value={baseId2}
            onChange={(e) => setBaseId2(e.target.value)}
          >
            <option value="">NEW BASELINE</option>
            {baselines.map((base) => (
              <option key={base.id} value={base.id}>
                {base.version} · {base.status.toUpperCase()}
              </option>
            ))}
          </select>
          <Button
            variant="default"
            size="sm"
            onClick={handleRunDiff}
            disabled={loading || !baseId1 || !baseId2}
          >
            DIFF BASELINES
          </Button>
        </div>

        {/* Formatted Changelog Output */}
        <div className="flex-1 overflow-y-auto bg-swiss-gray p-4 font-mono text-xs text-black whitespace-pre-wrap leading-relaxed">
          {changelog || 'Select two baseline versions above to audit requirement changes.'}
        </div>
      </div>

      {/* Right: Automated Scope Impact Analysis */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b-2 border-black px-5 py-3.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[02] SCOPE IMPACT AUDIT</span>
          {impactReport && (
            <Badge variant={impactReport.hasImpact ? 'blocked' : 'done'}>
              {impactReport.hasImpact ? 'IMPACT DETECTED' : 'NO IMPACT'}
            </Badge>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {impactReport ? (
            <>
              {/* Affected Tasks */}
              <div>
                <h4 className="text-xs font-black uppercase tracking-wider text-[#ff3000] font-mono mb-2">
                  AFFECTED TASKS REQUIRING REWORK ({impactReport.affectedTasks.length})
                </h4>
                {impactReport.affectedTasks.map((t: any) => (
                  <div
                    key={t.taskId}
                    className="p-3 rounded-none bg-red-50 border-2 border-black text-xs mb-2 flex justify-between items-start"
                  >
                    <div>
                      <span className="font-black uppercase tracking-tight text-black">{t.title}</span>
                      <p className="text-[11px] font-mono text-[#ff3000] mt-0.5">{t.reason}</p>
                    </div>
                    <Badge variant="blocked">{t.status}</Badge>
                  </div>
                ))}
                {impactReport.affectedTasks.length === 0 && (
                  <p className="text-xs font-medium text-neutral-600">
                    No active tasks affected by these specification changes.
                  </p>
                )}
              </div>

              {/* Uncovered Requirements */}
              {impactReport.uncoveredNewRequirements.length > 0 && (
                <div>
                  <h4 className="text-xs font-black uppercase tracking-wider text-black font-mono mb-2">
                    UNCOVERED NEW REQUIREMENTS ({impactReport.uncoveredNewRequirements.length})
                  </h4>
                  {impactReport.uncoveredNewRequirements.map((r: any) => (
                    <div
                      key={r.id}
                      className="p-3 rounded-none bg-swiss-gray border-2 border-black text-xs mb-2"
                    >
                      <span className="font-mono font-black text-[#ff3000]">{r.id}: </span>
                      <span className="font-bold text-black">{r.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Apply Action Button */}
              {impactReport.affectedTasks.length > 0 && (
                <div className="pt-3 mt-auto border-t-2 border-black flex justify-end">
                  <Button variant="danger" size="sm" onClick={handleApplyImpact} disabled={loading}>
                    FLAG AFFECTED TASKS FOR REWORK
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center p-8 bg-swiss-gray border-2 border-dashed border-black/20 rounded-none m-2">
              <p className="text-xs font-mono font-bold uppercase text-neutral-400">
                RUN BASELINE DIFF TO CALCULATE SCOPE IMPACT
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

