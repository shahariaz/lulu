import { useEffect } from 'react'

export const ORCHESTRATOR_EVENTS = [
  'connected', 'task_claimed', 'worker_completed', 'verification_completed',
  'review_completed', 'review_unavailable', 'qa_completed', 'qa_unavailable',
  'task_accepted', 'changes_requested', 'feature_merged', 'preview_started',
  'preview_stopped', 'swarm_scheduled', 'task_integrated_via_queue',
  'scope_invalidated', 'autonomy_changed', 'project_initialized_from_blueprint',
] as const

export function useOrchestratorEvents(onEvent: (type: string, data: unknown) => void): void {
  useEffect(() => {
    let source: EventSource | null = null
    let retryTimer: number | null = null
    let retryMs = 500
    let disposed = false

    const connect = () => {
      source = new EventSource('/api/orchestrator/events')
      for (const type of ORCHESTRATOR_EVENTS) {
        source.addEventListener(type, (event) => {
          retryMs = 500
          try { onEvent(type, JSON.parse((event as MessageEvent).data)) }
          catch { onEvent(type, (event as MessageEvent).data) }
        })
      }
      source.onerror = () => {
        source?.close()
        if (disposed) return
        retryTimer = window.setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, 10_000)
      }
    }

    connect()
    return () => {
      disposed = true
      source?.close()
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [onEvent])
}
