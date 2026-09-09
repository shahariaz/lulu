# Revision 03 Review Report

**Date:** 2026-09-09  
**Scope:** Documentation-only correction of the Phase 0 orchestrator contracts.

## Outcome

Foundation implementation may begin with `TSK-M1-01`. Worker-engine implementation remains gated by the offline compatibility experiment and a recorded architecture decision. UI implementation remains gated by the owner’s frontend choice.

## Corrections Applied

| Finding | Resolution |
|---|---|
| Forced cleanup remained after success | Automatic cleanup now uses normal `git worktree remove` only after successful fast-forward integration and a clean preflight. Forced removal is reserved for an explicit, separately confirmed owner discard action. |
| Recovery mutated preserved work | Recovery leaves the complete worktree untouched—tracked, untracked, and ignored files—until the owner selects a recovery action. |
| Waiting and blocked conditions were conflated | Added `tasks.waiting_reason` for temporary stage-preserving waits. `tasks.blocked_reason` is used only when `tasks.status = 'Blocked'`. |
| Run states mixed stage and attempt semantics | Added `task_runs.kind` (`WORKER`, `VERIFICATION`, `REVIEW`) and normalized attempt statuses (`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `INTERRUPTED`). |
| Compatibility spike forced a fallback choice | The spike now classifies evidence. Test/configuration defects require correction; reproducible incompatibility blocks only the affected approach; engine selection requires an ADR. |
| Streaming invocation was incomplete | Added `--verbose` and `--include-partial-messages` to the documented structured-stream invocation and requires validation against the installed CLI version. |
| Container network design conflicted | `--network none` is limited to containers requiring no gateway. Agent containers use a dedicated bridge/proxy with an allowlist, not host networking as an isolation control. |
| Container Git model was invalid | The advanced tier now uses a disposable full clone or exported candidate tree without exposing the owner checkout or shared Git common directory. |
| Node process-group API was misstated | Replaced fictional `setpgid: true` with the documented POSIX behavior of Node.js `detached: true`, subject to platform verification. |
| Arbitrary 100% coverage gate | Replaced with behavior-focused tests for migration, atomicity, integrity, and recovery branches. |
| Readiness was overstated | Documents now say foundation-ready while retaining explicit owner and compatibility gates. |

## Remaining Owner Decisions

1. Frontend: component-based SPA or continued monolithic embedded UI.
2. Milestone 1 execution tier: cooperative trusted-local mode or isolated execution.
3. Proposed budgets, repair attempts, command timeout, and lease inquiry threshold.
4. Worker engine: decided only after `TSK-M1-05` produces classified evidence and an ADR.

## First Executable Task

`TSK-M1-01`: implement versioned database migrations and non-destructive recovery persistence. Its tests must cover migration idempotency, transaction rollback, foreign keys, preservation of interrupted workspaces, and reconciliation-state recording.
