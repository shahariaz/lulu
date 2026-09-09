import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkScopeOverlap,
  scheduleConcurrentTasks,
} from '../lib/orchestrator/swarm-coordinator.mjs'

test('checkScopeOverlap accurately detects exact matches, directory subsumptions, and disjoint scopes', () => {
  // 1. Exact file match
  const exact = checkScopeOverlap(['src/calc.js'], ['src/calc.js', 'src/other.js'])
  assert.equal(exact.overlaps, true)
  assert.deepEqual(exact.collidingPaths, ['src/calc.js'])

  // 2. Directory subsumption (src/auth contains src/auth/token.js)
  const dir = checkScopeOverlap(['src/auth'], ['src/auth/token.js'])
  assert.equal(dir.overlaps, true)

  // 3. Disjoint paths (no overlap)
  const disjoint = checkScopeOverlap(['src/auth/login.js'], ['src/billing/pay.js', 'test/billing.test.js'])
  assert.equal(disjoint.overlaps, false)
  assert.deepEqual(disjoint.collidingPaths, [])

  // 4. Empty paths
  const empty = checkScopeOverlap([], ['src/app.js'])
  assert.equal(empty.overlaps, false)
})

test('scheduleConcurrentTasks allocates slots for independent tasks and queues colliding tasks', () => {
  const activeTasks = [
    { id: 't_active_1', title: 'Active Auth', scope_paths: ['src/auth/oauth.js'] },
  ]

  const readyTasks = [
    { id: 't_ready_1', title: 'Billing Gateway', scope_paths: ['src/billing/pay.js'] }, // Non-colliding -> should be scheduled!
    { id: 't_ready_2', title: 'Token Refresher', scope_paths: ['src/auth/oauth.js'] },  // Collides with t_active_1 -> should queue!
    { id: 't_ready_3', title: 'User Profile', scope_paths: ['src/user/profile.js'] },   // Non-colliding -> should be scheduled!
    { id: 't_ready_4', title: 'Reports Engine', scope_paths: ['src/reports/gen.js'] },  // Would exceed maxConcurrency (3) -> should queue!
  ]

  const result = scheduleConcurrentTasks({
    readyTasks,
    activeTasks,
    maxConcurrency: 3,
  })

  // Schedulable: t_ready_1 and t_ready_3
  assert.equal(result.schedulableTasks.length, 2)
  assert.equal(result.schedulableTasks[0].id, 't_ready_1')
  assert.equal(result.schedulableTasks[1].id, 't_ready_3')

  // Queued: t_ready_2 (scope locked) and t_ready_4 (concurrency limit)
  assert.equal(result.queuedTasks.length, 2)
  const t2Queued = result.queuedTasks.find((q) => q.task.id === 't_ready_2')
  assert.equal(t2Queued.reason, 'SCOPE_LOCKED')
  assert.deepEqual(t2Queued.collidingPaths, ['src/auth/oauth.js'])

  const t4Queued = result.queuedTasks.find((q) => q.task.id === 't_ready_4')
  assert.equal(t4Queued.reason, 'CONCURRENCY_LIMIT_REACHED')
})
