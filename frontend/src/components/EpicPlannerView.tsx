import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Badge } from './ui/Badge'
import type { Project, Task } from '../types'
import { api } from '../lib/api'

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
      const epicsData = await api.listEpics(project.id)
      setEpics(epicsData.epics || [])

      const sprintsData = await api.listSprints(project.id)
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
      await api.createSprint(project.id, { name: sprintName.trim(), goal: sprintGoal.trim() })
      setSprintName('')
      setSprintGoal('')
      loadEpicsAndSprints()
    } catch (err: any) {
      alert(`Could not create sprint: ${err.message}`)
    }
  }

  if (!project) {
    return (
      <Card className="h-full flex items-center justify-center text-center p-8 bg-swiss-gray border-2 border-black rounded-none">
        <div>
          <div className="text-xs font-mono font-black uppercase tracking-widest text-neutral-400 mb-1">[EMPTY STATE]</div>
          <p className="text-xs font-bold uppercase tracking-wider text-black">
            SELECT A REPOSITORY TO PLAN EPICS AND SPRINTS
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 h-full divide-x divide-black/15 overflow-hidden bg-white">
      {/* Left 2 Cols: Epics & Child Tasks Hierarchy */}
      <div className="lg:col-span-2 flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-black/15 px-5 py-3.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[01] HIERARCHICAL EPICS BREAKDOWN</span>
          <Badge variant="ready">{epics.length} EPICS</Badge>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 bg-neutral-50/40">
          {epics.map((epic) => {
            const epicTasks = tasks.filter((t: any) => t.epic_id === epic.epicId)

            return (
              <div key={epic.epicId} className="p-3.5 rounded-none border border-black/15 bg-white flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-black uppercase tracking-tight text-black">{epic.title}</h4>
                    <span className="text-[10px] text-neutral-600 font-mono font-bold">ID: {epic.epicId}</span>
                  </div>
                  <Badge variant={epic.status === 'COMPLETED' ? 'done' : epic.status === 'IN_PROGRESS' ? 'progress' : 'default'}>
                    {epic.status}
                  </Badge>
                </div>

                {/* Progress Bar */}
                <div className="w-full bg-neutral-100 h-2.5 rounded-none overflow-hidden border border-black/20">
                  <div
                    className="bg-black h-full transition-all duration-200"
                    style={{ width: `${epic.progressPercentage}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-neutral-600 font-mono font-bold uppercase">
                  <span>PROGRESS: {epic.progressPercentage}%</span>
                  <span>{epic.completedTasks} / {epic.totalTasks} TASKS COMPLETE</span>
                </div>

                {/* Child Tasks List */}
                {epicTasks.length > 0 && (
                  <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-black/10">
                    {epicTasks.map((t) => (
                      <div key={t.id} className="p-2 rounded-none bg-neutral-50 border border-black/15 flex items-center justify-between text-xs">
                        <span className="font-bold uppercase text-black truncate max-w-[280px]">{t.title}</span>
                        <div className="flex items-center gap-1.5">
                          {t.linked_requirement_ids && t.linked_requirement_ids.map((r: string) => (
                            <span key={r} className="text-[9px] font-mono px-1 rounded-none bg-white border border-black/20 text-black font-bold">
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
            <div className="text-center p-8 border border-dashed border-black/20 rounded-none bg-neutral-50">
              <p className="text-xs font-bold uppercase tracking-wider text-neutral-500 font-mono">
                NO EPICS DEFINED. DECOMPOSE AN APPROVED BASELINE TO BEGIN.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Right Col: Sprints Management */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-black/15 px-5 py-3.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[02] CONFIGURE SPRINT</span>
          <span className="text-[10px] font-mono font-bold text-neutral-500 uppercase">SPRINT SCOPE</span>
        </div>

        <form onSubmit={handleCreateSprint} className="p-4 border-b border-black/15 bg-neutral-50 flex flex-col gap-3 shrink-0">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-black font-mono mb-1">
              SPRINT NAME
            </label>
            <Input
              placeholder="e.g. SPRINT 1 - FOUNDATION"
              value={sprintName}
              onChange={(e) => setSprintName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-black font-mono mb-1">
              SPRINT GOAL
            </label>
            <Input
              placeholder="DELIVER CORE ENGINE & TESTS"
              value={sprintGoal}
              onChange={(e) => setSprintGoal(e.target.value)}
            />
          </div>
          <Button variant="default" size="sm" type="submit" disabled={!sprintName.trim()}>
            CREATE SPRINT
          </Button>
        </form>

        <div className="flex items-center justify-between border-b border-black/15 px-5 py-2.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-[11px]">[03] ACTIVE SPRINTS</span>
          <span className="text-[10px] font-mono font-bold text-[#ff3000] uppercase">{sprints.length} CONFIGURED</span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5 bg-white">
          {sprints.map((s) => (
            <div key={s.id} className="p-3 rounded-none border border-black/15 bg-neutral-50 text-xs flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="font-black uppercase text-black">{s.name}</span>
                <Badge variant={s.status === 'ACTIVE' ? 'progress' : 'default'}>{s.status}</Badge>
              </div>
              {s.goal && <p className="text-[11px] font-medium text-neutral-600">{s.goal}</p>}
            </div>
          ))}
          {sprints.length === 0 && (
            <p className="text-xs font-mono font-bold uppercase text-neutral-400 text-center py-6">
              NO SPRINTS PLANNED.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
