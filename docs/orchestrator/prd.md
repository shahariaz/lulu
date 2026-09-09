# Product Requirements Document (PRD): Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 2 — Resolved Architectural Contracts  
**Date:** 2026-09-09  
**Product Name:** Claude-Zen Orchestrator  
**Target Release:** v0.1.0 (Milestone 1: Core Vertical Slice)  

---

## 1. Vision & Strategic Value Proposition

Claude-Zen is a self-hosted AI software delivery platform with a polished browser interface. It runs locally on the owner's personal computer or private server, transforming feature requirements into tested, verified, reviewed, and cleanly integrated git commits.

Unlike open-ended CLI coding assistants that execute unconstrained commands directly in the user's working checkout, Claude-Zen enforces **engineering discipline and safety**:
1. **Requirements Before Code:** Features are shaped through structured conversation with an Architect model, codified into formal markdown specifications, and locked via an explicit owner baseline approval.
2. **Deterministic Task Decomposition:** Approved baselines are broken down into a directed acyclic graph (DAG) of atomic, bounded tasks with explicit dependencies and file scopes.
3. **Worktree Isolation in Milestone 1:** Agent implementation occurs inside isolated git worktrees, preventing file lock contention and protecting the owner's primary working directory.
4. **Concrete Execution Boundaries:** Child processes run within defined execution constraints, with credential separation, process tree timeouts, and explicit boundary guarantees.
5. **Verifiable Completion Gates:** Model claims of completion are never trusted. Progress requires deterministic test passes (`exit 0`) and an independent specialist adversarial code review against an immutable candidate commit.
6. **Decoupled Governance & Fast-Forward Integration:** Task acceptance, feature-branch fast-forward integration, and base-branch merging are separate, preserving owner work and guaranteeing that what was reviewed is what gets integrated.

---

## 2. Confirmed Product Requirements vs. Technical Recommendations

### 2.1 Confirmed Product Principles (Non-Negotiable)
- **Self-Hosted, Single-Owner Governance:** Built for the local owner; no multi-tenant SaaS administration or billing in v1.
- **Sequential Execution (1 Active Writer per Project in v1):** Exactly one task writes to a project's git repository at a time.
- **Deterministic Orchestration:** Task state transitions, dependency resolution, budget ceilings, and recovery are controlled by ordinary deterministic code, not an LLM.
- **Git Worktree Isolation in Milestone 1:** Agent file edits must take place in an isolated worktree (`.zen-worktrees/<task-id>`), never in the user's active checkout.
- **Configurable Model Roles:** Zero hardcoded model selections; all roles (Planner, Worker, Reviewer) are dynamically assigned.
- **Exact Candidate Artifacts:** Code review and owner acceptance must anchor to an immutable candidate commit SHA and diff digest.
- **Fast-Forward-Only Task Integration:** Merging a completed task into the feature branch must be fast-forward only (`git merge --ff-only`), guaranteeing that the integrated tree matches the reviewed artifact.
- **Decoupled Accept / Integrate / Merge:** Accepting a task diff is independent of integrating into the feature branch, which is independent of merging the feature into the base branch (`main`).
- **Non-Destructive Recovery:** Interrupted tasks, failed reconciliations, and cancellations must preserve the actual workspace (tracked, untracked, and ignored files). Automatic forced worktree deletion is forbidden.

### 2.2 Technical Recommendations Awaiting Owner Review
- **UI Architecture Choice:** Proposal to build a lightweight Vite + Preact/React SPA served statically on port 8789 versus maintaining the monolithic 2.8k-line `lib/ui.mjs` template literal.
- **Harness Integration Strategy:** Open choice between Headless Claude Code CLI (`claude -p --output-format stream-json --permission-mode dontAsk`) and Native In-Process Node.js Tool Runner, governed by the outcome of an empirical compatibility spike (`TSK-SPIKE-HARNESS-PARITY`).
- **Execution Security Model:** Recommendation to adopt Proposal B (Cooperative Trusted-Local Mode with explicit host limits) for Milestone 1 workstation use, with Proposal A (Containerized/OS-isolated Worker) documented as an advanced security tier.
- **Numerical Proposals:** All numerical limits (token caps, repair loops, timeouts) are marked as `[PROPOSAL: ...]` and require owner calibration.

---

## 3. Core User Journeys

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              Unified End-to-End Lifecycle Sequence                                     │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│ 1. Import Repository   │─────▶│ 2. Discuss Scope       │─────▶│ 3. Baseline Spec       │
│ Clean tree check       │      │ Converse with Architect│      │ Lock immutable v1.0.0  │
└────────────────────────┘      └────────────────────────┘      └────────────────────────┘
                                                                            │
                                                                            ▼
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│ 6. Automated Checks    │◀─────│ 5. Worktree Execution  │◀─────│ 4. Decompose DAG       │
│ Evaluate candidate     │      │ Provision task worktree│      │ Order tasks & scopes   │
└────────────────────────┘      └────────────────────────┘      └────────────────────────┘
            │
            ▼
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│ 7. Specialist Review   │─────▶│ 8. Owner Acceptance    │─────▶│ 9. Fast-Forward Merge  │
│ Adversarial diff eval  │      │ Accept exact candidate │      │ ff-only into feature br│
└────────────────────────┘      └────────────────────────┘      └────────────────────────┘
                                                                            │
                                                                            ▼
                                                                ┌────────────────────────┐
                                                                │ 10. Done & Next Task   │
                                                                │ Unblock downstream DAG │
                                                                └────────────────────────┘
```

### Journey 1: Repository Onboarding
The owner selects a local repository directory. Claude-Zen verifies that Git is clean, scans package configurations (`package.json`, `go.mod`, `Cargo.toml`), identifies test commands, and registers the project.

### Journey 2: Conversational Scoping & Specification
The owner requests a new feature and converses interactively with the **Configured Planner/Architect** model. The Architect asks clarifying questions, identifies edge cases, and drafts a structured specification package (PRD, functional requirements, user journeys, architecture decisions, and verification criteria).

### Journey 3: Scope Baseline & Version Approval
The owner inspects the generated specification in the UI, edits text if desired, and clicks **Approve Baseline**. The specification is locked as immutable `v1.0.0`. Any subsequent scope changes require impact analysis.

### Journey 4: Task Decomposition & Dependency Mapping
The orchestrator automatically decomposes the approved baseline into a directed acyclic graph (DAG) of atomic, bounded tasks with explicit dependencies (`blockedBy: [...]`) and file scope definitions (`scope_paths: [...]`).

### Journey 5: Worktree Provisioning & Worker Implementation
The orchestrator provisions a dedicated git worktree (`.zen-worktrees/<task-id>`) branched from the feature branch (`zen/<feature-slug>`). The **Configured Worker** model implements code and tests within the worktree. Upon finishing, the worker requests candidate snapshotting.

### Journey 6: Candidate Snapshotting & Automated Verification
The orchestrator stages intended changes (including new files within `scope_paths`) and creates an immutable **candidate commit** on `zen/task/<task-id>`. The verifier executes test and lint suites against this candidate commit:
- If checks **pass** without dirtying tracked files, the orchestrator computes the verification digest and advances to Code Review.
- If checks **fail**, failure logs return to the worker in a bounded repair loop (max `[PROPOSAL: 3]` attempts). If unresolved, the task transitions to `Blocked`.

### Journey 7: Independent Specialist Code Review
The **Configured Specialist Reviewer** model performs an adversarial review against the exact candidate commit diff and verification digest. If the specialist model is unavailable, the review remains pending without downgrade or bypass.

### Journey 8: Owner Acceptance (QA)
The owner reviews the unified diff, test outputs, and review comments in the browser UI. The owner clicks **Accept**, approving the existing candidate commit SHA.

### Journey 9: Fast-Forward Integration into Feature Branch
The orchestrator integrates the accepted candidate commit into `zen/<feature-slug>` via `git merge --ff-only`. Once integrated, the task transitions to `Done`, the worktree is cleaned up, and downstream tasks unblock.

### Journey 10: Feature Branch Merge
When all tasks in the milestone are `Done`, the owner initiates an explicit **Merge Feature Branch** action in the UI (or via terminal) to merge `zen/<feature-slug>` into `main`.

---

## 4. Functional Requirements

### 4.1 Project & Workspace Management

- **`REQ-F-REPO-01`**: The system SHALL allow the owner to import an existing local git repository by filesystem path.
- **`REQ-F-REPO-02`**: The system SHALL inspect the repository and detect: git status, current branch, clean/dirty state, HEAD commit SHA, language runtime, and test commands.
- **`REQ-F-REPO-03`**: The system SHALL reject importing a repository if the working tree has uncommitted changes, unless the owner explicitly provides a dirty working tree override.
- **`REQ-F-REPO-04`**: For each feature, the system SHALL create an isolated git feature branch (`zen/<feature-slug>`) rooted at the base commit SHA.
- **`REQ-F-REPO-05`**: For each task execution, the system SHALL provision an isolated git worktree (`.zen-worktrees/<task-id>`) checked out to a task branch (`zen/task/<task-id>`), ensuring the user's primary working directory remains untouched during agent execution.
- **`REQ-F-REPO-06`**: Worktrees SHALL be eligible for removal ONLY after the task is `Done` (cleanly integrated into the feature branch) or explicitly discarded by the owner. Worktrees associated with interrupted, failed, or cancelled tasks SHALL be preserved for owner inspection.

### 4.2 Specification & Baseline Management

- **`REQ-F-SPEC-01`**: The system SHALL provide a conversational chat interface with the Configured Planner/Architect model to formulate feature requirements.
- **`REQ-F-SPEC-02`**: The Planner model SHALL generate a structured specification containing: summary, functional requirements (`REQ-...`), nonfunctional requirements, and verification criteria.
- **`REQ-F-SPEC-03`**: The system SHALL provide an "Approve Baseline" action in the UI that:
  - Assigns a semantic version (`v1.0.0`).
  - Stores an immutable snapshot and content hash in SQLite.
  - Transitions the specification to `APPROVED` status.
- **`REQ-F-SPEC-04`**: Any modification to an approved baseline SHALL trigger an automated impact analysis identifying affected tasks before producing a new version (`v1.1.0`).

### 4.3 Task Decomposition & Dependency Scheduling

- **`REQ-F-TASK-01`**: The system SHALL automatically decompose an approved baseline into an ordered sequence of tasks with explicit IDs (`TSK-...`), scope paths (`scope_paths`), and dependency arrays (`blockedBy: [...]`).
- **`REQ-F-TASK-02`**: The orchestrator SHALL schedule tasks deterministically. A task SHALL NOT transition to `Ready` until all dependencies in `blockedBy` have `status = 'Done'`.
- **`REQ-F-TASK-03`**: The system SHALL enforce sequential execution (exactly one active writer task per project) in Milestone 1.

### 4.4 Configurable Model Strategy

- **`REQ-F-MOD-01`**: The system SHALL allow the owner to independently configure the provider, model, and reasoning effort for each role:
  - **Planner / Architect:** Configured Strong Model.
  - **Worker / Implementer:** Configured Worker Model (e.g. Gemini 3.8 Flash via Antigravity).
  - **Specialist Reviewer:** Configured Strong Model.
- **`REQ-F-MOD-02`**: The system SHALL NOT hardcode any proprietary model identifier as mandatory.
- **`REQ-F-MOD-03`**: If a configured model becomes unavailable (rate limit, quota exhaustion), the orchestrator SHALL attempt configured fallback accounts or models within that role tier.
- **`REQ-F-MOD-04`**: If the Specialist Reviewer role has no available models, the task SHALL enter `Code Review` with blocker reason `SPECIALIST_UNAVAILABLE` and SHALL NOT proceed without review or explicit owner bypass.

### 4.5 Execution Security & Sandboxing Boundaries

- **`REQ-F-SEC-01`**: The system SHALL enforce working directory confinement. Node.js file tools SHALL resolve target paths and throw an immediate access error if any path traverses outside the assigned task worktree directory.
- **`REQ-F-SEC-02`**: The system SHALL sanitize environment variables passed to child processes, explicitly stripping API keys, OAuth tokens (`ANTHROPIC_API_KEY`, Google refresh tokens, OpenAI tokens), and parent process credentials.
- **`REQ-F-SEC-03`**: The system SHALL execute shell commands via an allowlisted command runner with process tree timeouts (`[PROPOSAL: 120s]`). High-risk administrative commands (`sudo`, `mkfs`, `rm -rf /`) SHALL be rejected.
- **`REQ-F-SEC-04`**: The system SHALL document explicit limitations: on a single-user workstation without OS-level containerization, child processes spawned by build/test tools execute with host user privileges. An advanced containerized execution tier SHALL be specified as a separate proposal.

### 4.6 Candidate Snapshotting, Verification & Bounded Repair

- **`REQ-F-VERI-01`**: When a worker requests verification, the orchestrator SHALL stage all intended file additions and modifications within `scope_paths` and commit an immutable **candidate commit** (`candidate_commit_sha`).
- **`REQ-F-VERI-02`**: The orchestrator SHALL independently execute the configured test and lint commands against the candidate commit in the worktree, recording environment toolchain metadata, execution duration, and exit codes.
- **`REQ-F-VERI-03`**: If verification modifies any tracked file in the repository (regardless of `.gitignore`), verification SHALL fail with `E_VERIFICATION_DIRTIED_WORKING_TREE`.
- **`REQ-F-VERI-04`**: If checks pass (`exit 0`), the orchestrator SHALL compute a `verification_digest` and advance the task to `Code Review`.
- **`REQ-F-VERI-05`**: If checks fail, the orchestrator SHALL return failure logs to the worker and increment `repair_attempts`. If repair attempts exceed `[PROPOSAL: 3]`, the task transitions to `Blocked` with blocker reason `REPAIR_LIMIT_EXCEEDED`.

### 4.7 Exact Review Artifact Contract

- **`REQ-F-REV-01`**: The Specialist Reviewer model SHALL evaluate exclusively:
  - `base_commit_sha`: The commit SHA from which the task worktree branched.
  - `candidate_commit_sha` & `diff_digest`: The exact commit SHA and SHA256 digest of the working diff.
  - `verification_digest`: SHA256 digest of the passing test execution logs and exit codes.
- **`REQ-F-REV-02`**: The Reviewer model SHALL output a structured JSON verdict (`APPROVE` or `CHANGES_REQUESTED`), summary, and categorized findings.
- **`REQ-F-REV-03`**: Any alteration to tracked files in the worktree post-verification SHALL automatically invalidate prior verification and review verdicts, resetting the task to `Automated Checks`.

### 4.8 Decoupled Acceptance, Fast-Forward Integration & Merging

- **`REQ-F-GOV-01`**: The browser UI SHALL provide a three-stage decoupled governance model:
  1. **Task Acceptance (QA):** Owner reviews diff, test logs, and specialist remarks, and marks the task `Accepted`. Acceptance SHALL reference the existing reviewed `candidate_commit_sha` without creating replacement commits.
  2. **Fast-Forward Integration:** The orchestrator integrates the accepted candidate into `zen/<feature-slug>` via `git merge --ff-only`. If fast-forward fails, work is preserved, task transitions to `Blocked` with reason `INTEGRATION_CONFLICT`, and downstream tasks remain blocked.
  3. **Feature Merging:** Merging `zen/<feature-slug>` into `main` SHALL be a distinct, explicit owner action (`REQ-F-GOV-04`).
- **`REQ-F-GOV-02`**: If the owner selects "Request Changes", the task resets to `In Progress` with feedback notes injected into the worker context.
- **`REQ-F-GOV-03`**: The owner SHALL be able to pause, resume, or cancel active execution at any time.
- **`REQ-F-GOV-04`**: The system SHALL provide a "Merge Feature" action in the UI that merges `zen/<feature-slug>` into the base branch only when all tasks are `Done`.

---

## 5. Nonfunctional Requirements & Proposed Limits

All numerical values in this section are proposals (`[PROPOSAL: ...]`) requiring owner confirmation.

### 5.1 Token & Cost Governance

- **`REQ-NF-COST-01`**: The system SHALL distinguish between **observed usage** (actual token counts reported by upstream provider APIs) and **estimated usage** (heuristic token calculations derived from character counts / 4).
- **`REQ-NF-COST-02`**: If an upstream provider returns missing or null token metrics, the orchestrator SHALL compute an estimated usage value and flag the record as `is_estimated = 1` in SQLite.
- **`REQ-NF-COST-03`**: The system SHALL support independent budget allocations:
  - Total Feature Token Ceiling: `[PROPOSAL: 500,000 tokens]`.
  - Single Task Token Ceiling: `[PROPOSAL: 150,000 tokens]`.
  - Dedicated Specialist Reviewer Budget: `[PROPOSAL: 80,000 tokens]`.
- **`REQ-NF-COST-04`**: When cumulative task usage reaches `[PROPOSAL: 90%]`, a warning SHALL display; at `100%`, execution SHALL pause immediately with status `Blocked` and reason `BUDGET_EXCEEDED`.

### 5.2 Performance & Responsiveness

- **`REQ-NF-PERF-01`**: The browser UI SHALL load project dashboards, task boards, and diff views in `[PROPOSAL: ≤ 1.5s]` on local networks.
- **`REQ-NF-PERF-02`**: Worktree provisioning and teardown SHALL complete in `[PROPOSAL: ≤ 500ms]` for standard repositories.
- **`REQ-NF-PERF-03`**: State machine transitions SHALL process within `[PROPOSAL: ≤ 250ms]`.

### 5.3 Reliability, Persistence & Non-Destructive Recovery

- **`REQ-NF-REL-01`**: Database schema evolution SHALL be governed by sequential, versioned migrations tracked in a `schema_migrations` table.
- **`REQ-NF-REL-02`**: Upon startup, the orchestrator SHALL reconcile transient tasks non-destructively:
  - Verify worker process identity (PID, start time, command line) before sending any OS signal.
  - Heartbeat expiry alone SHALL NOT cause worktree deletion.
  - Interrupted or orphaned worktrees SHALL be preserved on disk and recorded as `Blocked` with reason `RECONCILIATION_REQUIRED`.
  - Stale git locks (`index.lock`) SHALL be cleared ONLY after verifying that no process owns the lock.
- **`REQ-NF-REL-03`**: SQLite database operations SHALL execute in WAL mode with a busy timeout of `[PROPOSAL: 10,000ms]`.

---

## 6. Milestone 1 Acceptance Criteria

Milestone 1 is complete when the following end-to-end scenario passes:

1. **Import:** Owner imports a clean local repository.
2. **Scoping:** Owner chats with the Planner model to define a new feature.
3. **Baseline:** System generates a valid PRD; owner approves Baseline `v1.0.0`.
4. **Decomposition:** Orchestrator creates 2 tasks with scope paths and dependencies.
5. **Worktree Isolation:** System provisions an isolated git worktree for `TSK-01`; owner's primary working directory remains untouched on `main`.
6. **Implementation:** Configured Worker implements code and tests within the worktree.
7. **Candidate Snapshot:** Candidate commit `candidate_commit_sha` is staged and committed to `zen/task/TSK-01`.
8. **Verification:** Automated tests pass (`exit 0`) without dirtying tracked files.
9. **Specialist Review:** Reviewer model evaluates the candidate diff and emits `APPROVE`.
10. **Acceptance & Fast-Forward Integration:** Owner inspects diff in UI and clicks **Accept**. The orchestrator fast-forward merges `candidate_commit_sha` into `zen/<feature-slug>` and removes the worktree.
11. **Downstream Unblocking:** `TSK-02` transitions to `Ready`.
