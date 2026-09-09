import path from 'node:path'

/**
 * Check whether two sets of scope paths have any file or directory overlap.
 */
export function checkScopeOverlap(pathsA = [], pathsB = []) {
  if (!pathsA || !pathsB || pathsA.length === 0 || pathsB.length === 0) {
    return { overlaps: false, collidingPaths: [] }
  }

  const colliding = new Set()

  const normA = pathsA.map((p) => path.normalize(p).replace(/^[./]+/, ''))
  const normB = pathsB.map((p) => path.normalize(p).replace(/^[./]+/, ''))

  for (const a of normA) {
    for (const b of normB) {
      if (a === b) {
        colliding.add(a)
      } else if (a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
        // Directory subsumption (one path contains the other)
        colliding.add(`${a} <-> ${b}`)
      }
    }
  }

  const collidingPaths = Array.from(colliding)
  return {
    overlaps: collidingPaths.length > 0,
    collidingPaths,
  }
}

/**
 * Multi-Writer Task Scheduler for Parallel Swarms.
 * Schedules independent, non-conflicting tasks to run concurrently across isolated worktrees.
 */
export function scheduleConcurrentTasks({
  readyTasks = [],
  activeTasks = [],
  maxConcurrency = 3,
}) {
  const schedulableTasks = []
  const queuedTasks = []

  // Collect all currently locked scopes across active tasks
  const currentlyLockedScopes = []
  for (const task of activeTasks) {
    const scopes = task.scope_paths || []
    currentlyLockedScopes.push(...scopes)
  }

  const newlyScheduledScopes = [...currentlyLockedScopes]

  for (const task of readyTasks) {
    const taskScopes = task.scope_paths || []

    // 1. If task has no specified scopes (touches anything), it requires exclusive lock
    if (taskScopes.length === 0) {
      const totalRunningCount = activeTasks.length + schedulableTasks.length
      if (totalRunningCount === 0) {
        schedulableTasks.push(task)
      } else {
        queuedTasks.push({
          task,
          reason: 'REQUIRES_EXCLUSIVE_LOCK',
          collidingPaths: ['*'],
        })
      }
      continue
    }

    // 2. Check collision against all active and already-scheduled tasks
    const collision = checkScopeOverlap(taskScopes, newlyScheduledScopes)
    if (collision.overlaps) {
      queuedTasks.push({
        task,
        reason: 'SCOPE_LOCKED',
        collidingPaths: collision.collidingPaths,
      })
      continue
    }

    // 3. Check if concurrency slot limit reached
    const totalRunningCount = activeTasks.length + schedulableTasks.length
    if (totalRunningCount >= maxConcurrency) {
      queuedTasks.push({
        task,
        reason: 'CONCURRENCY_LIMIT_REACHED',
        collidingPaths: [],
      })
      continue
    }

    schedulableTasks.push(task)
    newlyScheduledScopes.push(...taskScopes)
  }

  return {
    schedulableTasks,
    queuedTasks,
    activeCount: activeTasks.length,
    newlyScheduledCount: schedulableTasks.length,
    maxConcurrency,
  }
}
