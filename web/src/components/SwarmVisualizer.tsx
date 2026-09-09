import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import type { Task, Project } from '../types'

interface SwarmVisualizerProps {
  project: Project | null
  tasks: Task[]
}

export function SwarmVisualizer({ project, tasks }: SwarmVisualizerProps) {
  const [metrics, setMetrics] = useState<any>(null)
  const [mergeQueueInfo, setMergeQueueInfo] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [scheduleResult, setScheduleResult] = useState<any>(null)

  useEffect(() => {
    loadMetrics()
    const timer = setInterval(loadMetrics, 3000)
    return () => clearInterval(timer)
  }, [])

  const loadMetrics = async () => {
    try {
      const res = await fetch('/api/orchestrator/swarm/metrics')
      const data = await res.json()
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
      const res = await fetch(`/api/orchestrator/milestones/${milestoneId}/schedule-swarm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrency: 3 }),
      })
      const data = await res.json()
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
        <Card className="p-4 bg-accent/5 border-accent/30">
          <span className="text-[10px] font-mono text-muted uppercase">Worker Swarm Concurrency</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-accent">
              {metrics ? metrics.activeCount : 0}
            </span>
            <span className="text-xs text-muted">/ {metrics ? metrics.maxConcurrency : 3} Slots Active</span>
          </div>
          <div className="w-full bg-black/40 h-1.5 rounded-full mt-3 overflow-hidden">
            <div
              className="bg-accent h-full transition-all duration-300"
              style={{
                width: `${metrics ? (metrics.activeCount / metrics.maxConcurrency) * 100 : 0}%`,
              }}
            />
          </div>
        </Card>

        <Card className="p-4 bg-purple/5 border-purple/30">
          <span className="text-[10px] font-mono text-muted uppercase">Sequential Merge Queue</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-purple">
              {mergeQueueInfo ? mergeQueueInfo.length : 0}
            </span>
            <span className="text-xs text-muted">Enqueued Tasks</span>
          </div>
          <p className="text-[10px] text-muted mt-2">
            Status: {mergeQueueInfo?.isProcessing ? '⚡ Processing Rebase & Verification' : 'Idle'}
          </p>
        </Card>

        <Card className="p-4 flex flex-col justify-between">
          <div>
            <span className="text-[10px] font-mono text-muted uppercase">Scope Overlap Scheduler</span>
            <p className="text-xs text-muted mt-1">Dispatches non-conflicting tasks across isolated git worktrees.</p>
          </div>
          <Button variant="primary" size="sm" onClick={handleScheduleSwarm} disabled={loading || !tasks.length}>
            {loading ? 'Analyzing Scopes...' : 'Trigger Swarm Dispatch'}
          </Button>
        </Card>
      </div>

      {/* Main Grid: Active Worker Slots & Scope Lock Queues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1">
        {/* Active Worker Slots */}
        <Card className="p-4 flex flex-col">
          <CardHeader className="p-0 pb-3 mb-3">
            <CardTitle className="text-xs flex items-center justify-between">
              <span>Active Worker Execution Slots</span>
              <Badge variant="progress">Multi-Agent Swarm</Badge>
            </CardTitle>
          </CardHeader>

          <div className="flex-1 flex flex-col gap-2.5">
            {metrics?.activeWorkers?.map((w: any, idx: number) => (
              <div key={w.taskId} className="p-3 rounded-lg border border-accent/30 bg-accent/5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" />
                  <div>
                    <h5 className="text-xs font-bold">{w.taskId}</h5>
                    <span className="text-[10px] font-mono text-muted">
                      PID: {w.pid || 'allocating'} · Uptime: {Math.round(w.uptimeMs / 1000)}s
                    </span>
                  </div>
                </div>
                <Badge variant="progress">{w.status}</Badge>
              </div>
            ))}

            {(!metrics?.activeWorkers || metrics.activeWorkers.length === 0) && (
              <div className="flex-1 flex items-center justify-center p-8 border border-dashed border-border/40 rounded text-center">
                <span className="text-xs text-muted">No worker agents actively executing.</span>
              </div>
            )}
          </div>
        </Card>

        {/* Queued Tasks & Scope Collisions */}
        <Card className="p-4 flex flex-col">
          <CardHeader className="p-0 pb-3 mb-3">
            <CardTitle className="text-xs flex items-center justify-between">
              <span>Queued Tasks & Scope Locks</span>
              <span className="text-[10px] font-mono text-muted">{scheduleResult?.queuedTasks?.length || 0} Queued</span>
            </CardTitle>
          </CardHeader>

          <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
            {scheduleResult?.queuedTasks?.map((q: any) => (
              <div key={q.task.id} className="p-2.5 rounded border border-warning/30 bg-warning/5 text-xs flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{q.task.title}</span>
                  <Badge variant="blocked">{q.reason}</Badge>
                </div>
                {q.collidingPaths.length > 0 && (
                  <p className="text-[10px] font-mono text-warning/80">
                    Colliding files: {q.collidingPaths.join(', ')}
                  </p>
                )}
              </div>
            ))}

            {(!scheduleResult?.queuedTasks || scheduleResult.queuedTasks.length === 0) && (
              <div className="flex-1 flex items-center justify-center p-8 border border-dashed border-border/40 rounded text-center">
                <span className="text-xs text-muted">No tasks currently blocked by scope collisions.</span>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
