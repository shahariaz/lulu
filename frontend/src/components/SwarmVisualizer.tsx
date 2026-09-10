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
    <div className="flex flex-col h-full overflow-hidden bg-white">
      {/* Top Banner: Swarm Capacity & Concurrency */}
      <div className="grid grid-cols-1 md:grid-cols-3 border-b-2 border-black divide-x-2 divide-black bg-white shrink-0">
        <div className="p-4 bg-white">
          <span className="text-[10px] font-mono font-black text-[#ff3000] uppercase tracking-wider block">
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
          <div className="w-full bg-neutral-100 h-2 rounded-none mt-2.5 overflow-hidden border border-black">
            <div
              className="bg-black h-full transition-all duration-200"
              style={{
                width: `${metrics ? (metrics.activeCount / metrics.maxConcurrency) * 100 : 0}%`,
              }}
            />
          </div>
        </div>

        <div className="p-4 bg-white">
          <span className="text-[10px] font-mono font-black text-black uppercase tracking-wider block">
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
        </div>

        <div className="p-4 flex flex-col justify-between bg-white">
          <div>
            <span className="text-[10px] font-mono font-black text-[#ff3000] uppercase tracking-wider block">
              [03] SCOPE SCHEDULER
            </span>
            <p className="text-[11px] font-medium text-neutral-600 mt-0.5">
              Dispatches non-conflicting tasks across isolated worktrees.
            </p>
          </div>
          <div className="pt-2">
            <Button variant="default" size="sm" onClick={handleScheduleSwarm} disabled={loading || !tasks.length} className="w-full">
              {loading ? 'ANALYZING SCOPES...' : 'TRIGGER SWARM DISPATCH'}
            </Button>
          </div>
        </div>
      </div>

      {/* Main Grid: Active Worker Slots & Scope Lock Queues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 flex-1 divide-x-2 divide-black overflow-hidden bg-white">
        {/* Active Worker Slots */}
        <div className="flex flex-col h-full overflow-hidden bg-white">
          <div className="flex items-center justify-between border-b-2 border-black px-5 py-3.5 bg-white shrink-0">
            <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[01] ACTIVE WORKER SLOTS</span>
            <Badge variant="progress">CONCURRENT SWARM</Badge>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5 bg-neutral-50/50">
            {metrics?.activeWorkers?.map((w: any) => (
              <div key={w.taskId} className="p-3 rounded-none border-2 border-black bg-white flex items-center justify-between">
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
              <div className="flex-1 flex items-center justify-center p-8 border-2 border-dashed border-black/20 rounded-none bg-swiss-gray text-center m-2">
                <span className="text-xs font-mono font-bold uppercase text-neutral-400">
                  NO WORKER AGENTS ACTIVELY EXECUTING
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Queued Tasks & Scope Collisions */}
        <div className="flex flex-col h-full overflow-hidden bg-white">
          <div className="flex items-center justify-between border-b-2 border-black px-5 py-3.5 bg-white shrink-0">
            <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[02] SCOPE CONFLICT QUEUE</span>
            <span className="text-[10px] font-mono font-bold text-[#ff3000] uppercase">
              {scheduleResult?.queuedTasks?.length || 0} ENQUEUED
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5 bg-white">
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
              <div className="flex-1 flex items-center justify-center p-8 border-2 border-dashed border-black/20 rounded-none bg-swiss-gray text-center m-2">
                <span className="text-xs font-mono font-bold uppercase text-neutral-400">
                  NO TASKS BLOCKED BY WORKSPACE CONFLICTS
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
