import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import type { Task, Project } from '../types'
import { api } from '../lib/api'

interface SwarmVisualizerProps {
  project: Project | null
  tasks: Task[]
  refreshToken?: number
}

export function SwarmVisualizer({ project, tasks, refreshToken = 0 }: SwarmVisualizerProps) {
  const [metrics, setMetrics] = useState<any>(null)
  const [mergeQueueInfo, setMergeQueueInfo] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [scheduleResult, setScheduleResult] = useState<any>(null)

  useEffect(() => {
    loadMetrics()
  }, [refreshToken])

  const loadMetrics = async () => {
    try {
      const data = await api.getSwarmMetrics()
      setMetrics(data.metrics)
      setMergeQueueInfo({
        length: data.mergeQueueLength,
        isProcessing: data.isMergeProcessing,
      })
    } catch {}
  }

  const handleScheduleSwarm = async () => {
    if (!tasks.length) return
    const milestoneId = tasks[0].milestone_id
    setLoading(true)
    try {
      const data = await api.scheduleSwarm(milestoneId, 3)
      setScheduleResult(data)
      loadMetrics()
    } catch (err: any) {
      alert(`Swarm scheduling failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pr-1">
      {/* Top Banner: Swarm Capacity & Concurrency */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="p-4 border-2 border-black bg-white rounded-none">
          <span className="text-[10px] font-mono font-black text-swiss-red uppercase tracking-wider">
            [01] SWARM CAPACITY
          </span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-3xl font-black font-mono text-black">
              {metrics ? metrics.activeCount : 0}
            </span>
            <span className="text-xs font-mono font-bold text-neutral-500 uppercase">
              / {metrics ? metrics.maxConcurrency : 3} SLOTS ACTIVE
            </span>
          </div>
          <div className="w-full bg-swiss-gray h-2 rounded-none mt-3 overflow-hidden border border-black">
            <div
              className="bg-black h-full transition-all duration-200"
              style={{
                width: `${metrics ? (metrics.activeCount / metrics.maxConcurrency) * 100 : 0}%`,
              }}
            />
          </div>
        </Card>

        <Card className="p-4 border-2 border-black bg-white rounded-none">
          <span className="text-[10px] font-mono font-black text-black uppercase tracking-wider">
            [02] MERGE PIPELINE
          </span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-3xl font-black font-mono text-black">
              {mergeQueueInfo ? mergeQueueInfo.length : 0}
            </span>
            <span className="text-xs font-mono font-bold text-neutral-500 uppercase">ENQUEUED COMMITS</span>
          </div>
          <p className="text-[10px] font-mono font-bold text-neutral-600 mt-2 uppercase">
            STATUS: {mergeQueueInfo?.isProcessing ? '⚡ VERIFYING REBASE' : 'IDLE'}
          </p>
        </Card>

        <Card className="p-4 flex flex-col justify-between border-2 border-black bg-white rounded-none">
          <div>
            <span className="text-[10px] font-mono font-black text-swiss-red uppercase tracking-wider">
              [03] SCOPE SCHEDULER
            </span>
            <p className="text-xs font-medium text-neutral-600 mt-1">
              Dispatches non-conflicting tasks across isolated worktrees.
            </p>
          </div>
          <Button variant="default" size="sm" onClick={handleScheduleSwarm} disabled={loading || !tasks.length}>
            {loading ? 'ANALYZING SCOPES...' : 'TRIGGER SWARM DISPATCH'}
          </Button>
        </Card>
      </div>

      {/* Main Grid: Active Worker Slots & Scope Lock Queues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1">
        {/* Active Worker Slots */}
        <Card className="p-4 flex flex-col border-2 border-black bg-white rounded-none">
          <CardHeader className="p-0 pb-3 mb-3 border-b-2 border-black">
            <CardTitle className="text-xs flex items-center justify-between w-full font-mono">
              <span className="font-black uppercase tracking-wider text-black">[01] ACTIVE WORKER SLOTS</span>
              <Badge variant="progress">CONCURRENT SWARM</Badge>
            </CardTitle>
          </CardHeader>

          <div className="flex-1 flex flex-col gap-2.5">
            {metrics?.activeWorkers?.map((w: any) => (
              <div key={w.taskId} className="p-3 rounded-none border-2 border-black bg-swiss-gray flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-none bg-emerald-600 border border-black animate-pulse" />
                  <div>
                    <h5 className="text-xs font-black uppercase text-black font-mono">{w.taskId}</h5>
                    <span className="text-[10px] font-mono text-neutral-600 font-bold uppercase">
                      PID: {w.pid || 'ALLOCATING'} · UPTIME: {Math.round(w.uptimeMs / 1000)}S
                    </span>
                  </div>
                </div>
                <Badge variant="progress">{w.status}</Badge>
              </div>
            ))}

            {(!metrics?.activeWorkers || metrics.activeWorkers.length === 0) && (
              <div className="flex-1 flex items-center justify-center p-8 border-2 border-dashed border-black/20 rounded-none bg-swiss-gray text-center">
                <span className="text-xs font-mono font-bold uppercase text-neutral-400">
                  NO WORKER AGENTS ACTIVELY EXECUTING
                </span>
              </div>
            )}
          </div>
        </Card>

        {/* Queued Tasks & Scope Collisions */}
        <Card className="p-4 flex flex-col border-2 border-black bg-white rounded-none">
          <CardHeader className="p-0 pb-3 mb-3 border-b-2 border-black">
            <CardTitle className="text-xs flex items-center justify-between w-full font-mono">
              <span className="font-black uppercase tracking-wider text-black">[02] SCOPE CONFLICT QUEUE</span>
              <span className="text-[10px] font-mono font-bold text-swiss-red uppercase">
                {scheduleResult?.queuedTasks?.length || 0} ENQUEUED
              </span>
            </CardTitle>
          </CardHeader>

          <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
            {scheduleResult?.queuedTasks?.map((q: any) => (
              <div key={q.task.id} className="p-3 rounded-none border-2 border-black bg-amber-50 border-l-4 border-l-amber-600 text-xs flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-black uppercase tracking-tight text-black">{q.task.title}</span>
                  <Badge variant="blocked">{q.reason}</Badge>
                </div>
                {q.collidingPaths.length > 0 && (
                  <p className="text-[10px] font-mono text-amber-900 font-bold uppercase">
                    COLLIDING FILES: {q.collidingPaths.join(', ')}
                  </p>
                )}
              </div>
            ))}

            {(!scheduleResult?.queuedTasks || scheduleResult.queuedTasks.length === 0) && (
              <div className="flex-1 flex items-center justify-center p-8 border-2 border-dashed border-black/20 rounded-none bg-swiss-gray text-center">
                <span className="text-xs font-mono font-bold uppercase text-neutral-400">
                  NO TASKS BLOCKED BY WORKSPACE CONFLICTS
                </span>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
