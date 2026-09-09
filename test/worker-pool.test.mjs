import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WorkerPoolManager } from '../lib/orchestrator/worker-pool.mjs'

test('WorkerPoolManager enforces concurrency limits and queues excess requests', async () => {
  const pool = new WorkerPoolManager({ maxConcurrency: 2 })

  // Acquire 2 slots (fills pool capacity)
  const slot1 = await pool.acquireSlot('t1', { role: 'worker' })
  assert.equal(slot1.taskId, 't1')
  assert.equal(slot1.status, 'ALLOCATED')

  const slot2 = await pool.acquireSlot('t2', { role: 'worker' })
  assert.equal(slot2.taskId, 't2')

  // Check metrics: 2 active, 0 available, 0 queued
  let metrics = pool.getPoolMetrics()
  assert.equal(metrics.activeCount, 2)
  assert.equal(metrics.availableSlots, 0)
  assert.equal(metrics.queuedCount, 0)

  // Request 3rd slot -> should queue and wait!
  let slot3Resolved = false
  const slot3Promise = pool.acquireSlot('t3', { role: 'worker' }).then((slot) => {
    slot3Resolved = true
    return slot
  })

  // Brief tick: verify slot3 is queued and not resolved yet
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(slot3Resolved, false)
  metrics = pool.getPoolMetrics()
  assert.equal(metrics.queuedCount, 1)
  assert.deepEqual(metrics.queuedTaskIds, ['t3'])

  // Release slot 1 -> should immediately unblock slot 3!
  pool.releaseSlot('t1')
  const slot3 = await slot3Promise
  assert.equal(slot3.taskId, 't3')
  assert.equal(slot3Resolved, true)

  metrics = pool.getPoolMetrics()
  assert.equal(metrics.activeCount, 2)
  assert.equal(metrics.queuedCount, 0)

  // Release remaining
  pool.releaseSlot('t2')
  pool.releaseSlot('t3')
  metrics = pool.getPoolMetrics()
  assert.equal(metrics.activeCount, 0)
  assert.equal(metrics.availableSlots, 2)
})

test('WorkerPoolManager registers process PID and shuts down pool gracefully', async () => {
  const pool = new WorkerPoolManager({ maxConcurrency: 2 })

  // Spawn a long-running dummy child process to safely test pool shutdown
  const child = spawn('node', ['-e', 'setTimeout(() => {}, 10000)'], {
    detached: true,
    stdio: 'ignore',
  })

  const slot = await pool.acquireSlot('t_proc', { test: true })
  pool.registerProcess('t_proc', child.pid)

  const metrics = pool.getPoolMetrics()
  assert.equal(metrics.activeWorkers[0].pid, child.pid)
  assert.equal(metrics.activeWorkers[0].status, 'RUNNING')

  // Queue a task
  let queueRejected = false
  pool.acquireSlot('t_proc_2')
  pool.acquireSlot('t_proc_3').catch((err) => {
    queueRejected = true
  })

  // Shutdown pool
  const shutdown = pool.shutdownPool({ timeoutMs: 100 })
  assert.ok(shutdown.terminatedPids.includes(child.pid))

  await new Promise((r) => setTimeout(r, 50))
  assert.equal(queueRejected, true, 'Queued tasks must be rejected on pool shutdown')
  assert.equal(pool.getPoolMetrics().activeCount, 0)
})
