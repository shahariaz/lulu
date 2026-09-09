import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Badge } from './ui/Badge'
import type { Project, Milestone, Task } from '../types'

interface EpicProgress {
  epicId: string
  title: string
  status: string
  totalTasks: number
  completedTasks: number
  progressPercentage: number
}

interface EpicPlannerViewProps {
  project: Project | null
  tasks: Task[]
}

export function EpicPlannerView({ project, tasks }: EpicPlannerViewProps) {
  const [epics, setEpics] = useState<EpicProgress[]>([])
  const [sprints, setSprints] = useState<any[]>([])
  const [sprintName, setSprintName] = useState('')
  const [sprintGoal, setSprintGoal] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (project) {
      loadEpicsAndSprints()
    }
  }, [project?.id])

  const loadEpicsAndSprints = async () => {
    if (!project) return
    setLoading(true)
    try {
      const epicsRes = await fetch(`/api/orchestrator/projects/${project.id}/epics`)
      const epicsData = await epicsRes.json()
      setEpics(epicsData.epics || [])

      const sprintsRes = await fetch(`/api/orchestrator/projects/${project.id}/sprints`)
      const sprintsData = await sprintsRes.json()
      setSprints(sprintsData.sprints || [])
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateSprint = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!project || !sprintName.trim()) return
    try {
      await fetch(`/api/orchestrator/projects/${project.id}/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sprintName.trim(), goal: sprintGoal.trim() }),
      })
      setSprintName('')
      setSprintGoal('')
      loadEpicsAndSprints()
    } catch (err: any) {
      alert(`Could not create sprint: ${err.message}`)
    }
  }

  if (!project) {
    return (
      <Card className="h-full flex items-center justify-center text-center p-8">
        <p className="text-xs text-muted">Select a project to plan epics and sprints.</p>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full overflow-hidden">
      {/* Left 2 Cols: Epics & Child Tasks Hierarchy */}
      <div className="lg:col-span-2 flex flex-col gap-3 h-full overflow-y-auto pr-1">
        <Card className="p-4">
          <CardHeader className="p-0 pb-3 mb-3">
            <CardTitle className="text-xs flex items-center justify-between">
              <span>Hierarchical Epics Breakdown</span>
              <Badge variant="ready">{epics.length} Epics</Badge>
            </CardTitle>
          </CardHeader>

          <div className="flex flex-col gap-3">
            {epics.map((epic) => {
              const epicTasks = tasks.filter((t: any) => t.epic_id === epic.epicId)

              return (
                <div key={epic.epicId} className="p-3.5 rounded-lg border border-border bg-black/20 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-foreground">{epic.title}</h4>
                      <span className="text-[10px] text-muted font-mono">ID: {epic.epicId}</span>
                    </div>
                    <Badge variant={epic.status === 'COMPLETED' ? 'done' : epic.status === 'IN_PROGRESS' ? 'progress' : 'default'}>
                      {epic.status}
                    </Badge>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-black/40 h-2 rounded-full overflow-hidden border border-border/50">
                    <div
                      className="bg-accent h-full transition-all duration-500"
                      style={{ width: `${epic.progressPercentage}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted font-mono">
                    <span>Progress: {epic.progressPercentage}%</span>
                    <span>{epic.completedTasks} / {epic.totalTasks} Tasks Done</span>
                  </div>

                  {/* Child Tasks List */}
                  {epicTasks.length > 0 && (
                    <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-border/40">
                      {epicTasks.map((t) => (
                        <div key={t.id} className="p-2 rounded bg-card border border-border/60 flex items-center justify-between text-xs">
                          <span className="font-medium text-foreground truncate max-w-[280px]">{t.title}</span>
                          <div className="flex items-center gap-1.5">
                            {t.linked_requirement_ids && t.linked_requirement_ids.map((r: string) => (
                              <span key={r} className="text-[9px] font-mono px-1 rounded bg-white/5 border border-border text-muted">
                                {r}
                              </span>
                            ))}
                            <Badge variant={t.status.toLowerCase() as any}>{t.status}</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}

            {epics.length === 0 && (
              <div className="text-center p-8 border border-dashed border-border/40 rounded">
                <p className="text-xs text-muted">No epics created yet. Decompose an approved baseline into hierarchical epics to begin.</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Right Col: Sprints Management */}
      <div className="flex flex-col gap-3 h-full overflow-y-auto">
        <Card className="p-4">
          <CardHeader className="p-0 pb-3 mb-3">
            <CardTitle className="text-xs">Create Sprint</CardTitle>
          </CardHeader>

          <form onSubmit={handleCreateSprint} className="flex flex-col gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-muted mb-1">Sprint Name</label>
              <Input
                placeholder="e.g. Sprint 1 - Foundation"
                value={sprintName}
                onChange={(e) => setSprintName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-muted mb-1">Sprint Goal</label>
              <Input
                placeholder="Deliver core engine and tests"
                value={sprintGoal}
                onChange={(e) => setSprintGoal(e.target.value)}
              />
            </div>
            <Button variant="primary" size="sm" type="submit" disabled={!sprintName.trim()}>
              Create Sprint
            </Button>
          </form>
        </Card>

        <Card className="p-4 flex-1">
          <CardHeader className="p-0 pb-3 mb-3">
            <CardTitle className="text-xs flex items-center justify-between">
              <span>Configured Sprints</span>
              <span className="text-[10px] font-mono text-muted">{sprints.length}</span>
            </CardTitle>
          </CardHeader>

          <div className="flex flex-col gap-2">
            {sprints.map((s) => (
              <div key={s.id} className="p-2.5 rounded border border-border bg-black/20 text-xs flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{s.name}</span>
                  <Badge variant={s.status === 'ACTIVE' ? 'progress' : 'default'}>{s.status}</Badge>
                </div>
                {s.goal && <p className="text-[11px] text-muted">{s.goal}</p>}
              </div>
            ))}
            {sprints.length === 0 && (
              <p className="text-xs text-muted text-center py-4">No sprints planned.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
