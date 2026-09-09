import { terminateProcessGroup, isPidAlive } from './db/recovery-manager.mjs'

/**
 * Multi-Agent Worker Pool Manager for Concurrent Swarms.
 * Enforces concurrency limits, manages slot allocation, tracks leases,
 * and handles graceful pool-wide shutdown.
 */
export class WorkerPoolManager {
  constructor({ maxConcurrency = 3, defaultTimeoutMs = 120000 } = {}) {
    this.maxConcurrency = maxConcurrency
    this.defaultTimeoutMs = defaultTimeoutMs
    this.activeWorkers = new Map() // taskId -> WorkerSlot
    this.waitQueue = []            // Array<{ taskId, resolve, reject }>
  }

  /**
   * Acquire an execution slot in the worker pool.
   * Resolves immediately if under capacity; queues if full.
   */
  acquireSlot(taskId, metadata = {}) {
    if (this.activeWorkers.has(taskId)) {
      throw new Error(`Task ${taskId} already holds an active worker slot`)
    }

    return new Promise((resolve, reject) => {
      const slotRequest = {
        taskId,
        metadata,
        resolve: () => {
          const slot = {
            taskId,
            metadata,
            acquiredAt: Date.now(),
            pid: null,
            status: 'ALLOCATED',
          }
          this.activeWorkers.set(taskId, slot)
          resolve(slot)
        },
        reject,
      }

      if (this.activeWorkers.size < this.maxConcurrency) {
        slotRequest.resolve()
      } else {
        this.waitQueue.push(slotRequest)
      }
    })
  }

  /**
   * Register the spawned OS process PID with the active slot.
   */
  registerProcess(taskId, pid) {
    const slot = this.activeWorkers.get(taskId)
    if (slot) {
      slot.pid = pid
      slot.status = 'RUNNING'
    }
  }

  /**
   * Release a worker slot upon task run completion or error.
   * Dispatches the next queued worker if available.
   */
  releaseSlot(taskId) {
    const slot = this.activeWorkers.get(taskId)
    if (!slot) return false

    this.activeWorkers.delete(taskId)

    // Dispatch next queued task if slots available
    if (this.waitQueue.length > 0 && this.activeWorkers.size < this.maxConcurrency) {
      const next = this.waitQueue.shift()
      next.resolve()
    }

    return true
  }

  /**
   * Gracefully terminate all active worker process groups in the pool.
   */
  shutdownPool({ timeoutMs = 5000 } = {}) {
    const terminatedPids = []

    for (const [taskId, slot] of this.activeWorkers.entries()) {
      if (slot.pid && isPidAlive(slot.pid)) {
        terminateProcessGroup(slot.pid, { graceMs: timeoutMs })
        terminatedPids.push(slot.pid)
      }
    }

    // Reject all pending queued requests
    while (this.waitQueue.length > 0) {
      const item = this.waitQueue.shift()
      item.reject(new Error('Worker pool is shutting down'))
    }

    this.activeWorkers.clear()
    return {
      terminatedCount: terminatedPids.length,
      terminatedPids,
    }
  }

  /**
   * Query pool metrics and active worker slots.
   */
  getPoolMetrics() {
    const active = []
    for (const [taskId, slot] of this.activeWorkers.entries()) {
      active.push({
        taskId,
        pid: slot.pid,
        status: slot.status,
        uptimeMs: Date.now() - slot.acquiredAt,
        metadata: slot.metadata,
      })
    }

    return {
      maxConcurrency: this.maxConcurrency,
      activeCount: this.activeWorkers.size,
      queuedCount: this.waitQueue.length,
      availableSlots: Math.max(0, this.maxConcurrency - this.activeWorkers.size),
      activeWorkers: active,
      queuedTaskIds: this.waitQueue.map((q) => q.taskId),
    }
  }
}
