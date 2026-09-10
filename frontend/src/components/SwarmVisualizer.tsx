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
      <div className="grid grid-cols-1 md:grid-cols-3 border-b border-zinc-200 divide-x divide-zinc-200 bg-white shrink-0">
        <div className="p-4 bg-white">
          <span className="text-xs font-semibold text-[#ea3a12] block mb-1">
            Swarm capacity
          </span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold font-mono text-zinc-900">
              {metrics ? metrics.activeCount : 0}
            </span>
            <span className="text-xs text-zinc-500 font-medium">
              / {metrics ? metrics.maxConcurrency : 3} slots active
            </span>
          </div>
          <div className="w-full bg-zinc-100 h-2 rounded-full mt-2.5 overflow-hidden border border-zinc-200">
            <div
              className="bg-zinc-900 h-full transition-all duration-200 rounded-full"
              style={{
                width: `${metrics ? (metrics.activeCount / metrics.maxConcurrency) * 100 : 0}%`,
              }}
            />
          </div>
        </div>

        <div className="p-4 bg-white">
          <span className="text-xs font-semibold text-zinc-900 block mb-1">
            Merge pipeline
          </span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold font-mono text-zinc-900">
              {mergeQueueInfo ? mergeQueueInfo.length : 0}
            </span>
            <span className="text-xs text-zinc-500 font-medium">enqueued commits</span>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            Status: {mergeQueueInfo?.isProcessing ? '⚡ Verifying rebase' : 'Idle'}
          </p>
        </div>

        <div className="p-4 flex flex-col justify-between bg-white">
          <div>
            <span className="text-xs font-semibold text-[#ea3a12] block mb-1">
              Scope scheduler
            </span>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Dispatches non-conflicting tasks across isolated worktrees.
            </p>
          </div>
          <div className="pt-2">
            <Button variant="default" size="sm" onClick={handleScheduleSwarm} disabled={loading || !tasks.length} className="w-full">
              {loading ? 'Analyzing scopes...' : 'Trigger swarm dispatch'}
            </Button>
          </div>
        </div>
      </div>

      {/* Main Grid: Active Worker Slots & Scope Lock Queues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 flex-1 divide-x divide-zinc-200 overflow-hidden bg-white">
        {/* Active Worker Slots */}
        <div className="flex flex-col h-full overflow-hidden bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
            <span className="font-semibold text-zinc-900 text-xs tracking-tight">Active worker slots</span>
            <Badge variant="progress">Concurrent swarm</Badge>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5 bg-zinc-50/40">
            {metrics?.activeWorkers?.map((w: any) => (
              <div key={w.taskId} className="p-3.5 rounded-lg border border-zinc-200 bg-white flex items-center justify-between shadow-2xs">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-600 animate-pulse" />
                  <div>
                    <h5 className="text-xs font-semibold text-zinc-900 font-mono">{w.taskId}</h5>
                    <span className="text-[11px] font-mono text-zinc-500">
                      PID: {w.pid || 'allocating'} · Uptime: {Math.round(w.uptimeMs / 1000)}s
                    </span>
                  </div>
                </div>
                <Badge variant="progress">{w.status}</Badge>
              </div>
            ))}

            {(!metrics?.activeWorkers || metrics.activeWorkers.length === 0) && (
              <div className="flex-1 flex items-center justify-center p-8 border border-dashed border-zinc-200 rounded-xl bg-white/40 text-center m-2">
                <span className="text-xs text-zinc-400 font-medium">
                  No worker agents actively executing
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Queued Tasks & Scope Collisions */}
        <div className="flex flex-col h-full overflow-hidden bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
            <span className="font-semibold text-zinc-900 text-xs tracking-tight">Scope conflict queue</span>
            <span className="text-xs text-zinc-500">
              {scheduleResult?.queuedTasks?.length || 0} enqueued
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5 bg-white">
            {scheduleResult?.queuedTasks?.map((q: any) => (
              <div key={q.task.id} className="p-3.5 rounded-lg border border-amber-200 bg-amber-50/60 text-xs flex flex-col gap-1 shadow-2xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-900">{q.task.title}</span>
                  <Badge variant="blocked">{q.reason}</Badge>
                </div>
                {q.collidingPaths.length > 0 && (
                  <p className="text-[11px] font-mono text-amber-800">
                    Colliding files: {q.collidingPaths.join(', ')}
                  </p>
                )}
              </div>
            ))}

            {(!scheduleResult?.queuedTasks || scheduleResult.queuedTasks.length === 0) && (
              <div className="flex-1 flex items-center justify-center p-8 border border-dashed border-zinc-200 rounded-xl bg-zinc-50/50 text-center m-2">
                <span className="text-xs text-zinc-400 font-medium">
                  No tasks blocked by workspace conflicts
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
