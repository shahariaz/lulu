# Product Requirements Document (PRD): Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 1 — Grounded Requirements & Contracts  
**Date:** 2026-09-09  
**Product Name:** Claude-Zen Orchestrator  
**Target Release:** v0.1.0 (Milestone 1: Core Vertical Slice)  

---

## 1. Vision & Strategic Value Proposition

Claude-Zen is a self-hosted AI software delivery platform with a polished browser interface. It runs locally on the owner's personal computer or private server, transforming feature requests into tested, reviewed, and verifiable git commits.

Unlike open-ended CLI coding assistants that execute unconstrained bash commands directly in the user's working copy, Claude-Zen enforces **engineering discipline and safety**:
1. **Requirements Before Code:** Features are shaped through structured conversation with an Architect model, codified into formal markdown specifications, and locked via an explicit owner baseline approval.
2. **Worktree & Execution Isolation:** Agent implementation occurs inside isolated git worktrees, preventing file lock contention and protecting the owner's working directory.
3. **Execution Security:** Process execution is confined to the task worktree with sanitized environments, strict command allowlisting, and network boundaries.
4. **Verifiable Completion Gates:** Model claims of completion are never trusted. Progress requires deterministic test passes (`exit 0`) and an independent specialist adversarial code review against an immutable diff artifact.
5. **Impact-Analyzed Change Control:** Post-baseline modifications trigger automated impact analysis and semantic version increments.
6. **Decoupled Governance:** Task acceptance, git committing, and branch merging are independent steps, preserving owner work and excluding unrelated files.

---

## 2. Confirmed Product Requirements vs. Technical Recommendations

To maintain absolute clarity during Phase 0 planning, this document strictly delineates **Confirmed Product Requirements** (mandated product capabilities) from **Technical Recommendations** (implementation strategies awaiting owner sign-off).

### 2.1 Confirmed Product Principles (Non-Negotiable)
- **Self-Hosted, Single-Owner Governance:** Built for the local owner; no multi-tenant SaaS administration or billing in v1.
- **Sequential Execution (1 Active Writer per Project in v1):** Exactly one task writes to a project's git repository at a time.
- **Deterministic Orchestration:** Task state transitions, dependency resolution, budget ceilings, and recovery are controlled by ordinary deterministic code, not an LLM.
- **Git Worktree Isolation in Milestone 1:** Agent file edits must take place in an isolated worktree (`.zen-worktrees/<task-id>`), never in the user's active checkout.
- **Configurable Model Roles:** Zero hardcoded model selections; all roles are dynamically assigned.
- **Exact Diff Artifacts:** Code review and owner acceptance must anchor to an immutable commit SHA / diff digest.
- **Decoupled Accept / Commit / Merge:** Accepting a task diff must be independent of committing to the feature branch, which must be independent of merging into the main branch.

### 2.2 Technical Recommendations Awaiting Owner Sign-Off
- **UI Technology Choice:** Recommendation to scaffold a lightweight Vite + Preact/React SPA rather than continuing to expand the monolithic 2.8k-line `lib/ui.mjs` template literal.
- **Worker Harness Implementation:** Recommendation to evaluate a native path-confined Node.js tool runner versus spawning headless Claude Code CLI subprocesses with `--output-format stream-json --permission-mode dontAsk`.
- **Numerical Proposals:** All numerical limits (token caps, repair loops, timeouts) are marked as `[PROPOSAL: ...]` and require owner calibration.

---

## 3. Core User Journeys

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                             End-to-End Core User Journey                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 1. Import Repo   │───▶│ 2. Discuss Scope │───▶│ 3. Baseline Spec │───▶│ 4. Decompose DAG │
│ Inspect & verify │    │ Converse w/ Arch │    │ Review & Approve │    │ Order tasks      │
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
                                                                                 │
                                                                                 ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 8. Merge Branch  │◀───│ 7. Owner Accept  │◀───│ 6. Specialist Rev│◀───│ 5. Worktree Impl │
│ Explicit owner   │    │ Commit scoped    │    │ Adversarial diff │    │ Gemini edits     │
│ merge into main  │    │ changes only     │    │ & verify digest  │    │ & auto checks    │
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
```

### Journey 1: Repository Onboarding
The owner opens the browser UI and selects a local repository directory. Claude-Zen verifies that Git is clean, scans package configurations (`package.json`, `go.mod`, `Cargo.toml`), identifies test commands, and registers the project.

### Journey 2: Conversational Scoping & Specification
The owner requests a new feature. They converse interactively with the **Configured Planner/Architect** model. The Architect asks clarifying questions, identifies edge cases, and drafts a structured specification package (PRD, functional requirements, user journeys, architecture decisions, and verification criteria).

### Journey 3: Scope Baseline & Version Approval
The owner inspects the generated specification in the UI, edits text if desired, and clicks **Approve Baseline**. The specification is locked as immutable `v1.0.0`. Any subsequent scope changes require impact analysis.

### Journey 4: Task Decomposition & Dependency Mapping
The orchestrator automatically decomposes the approved baseline into a directed acyclic graph (DAG) of atomic, bounded tasks with explicit dependencies (`blockedBy: [...]`) and file scope definitions (`scope_paths: [...]`).

### Journey 5: Worktree Provisioning & Worker Implementation
The orchestrator provisions a dedicated git worktree (`.zen-worktrees/<task-id>`) branched from the feature branch (`zen/<feature-slug>`). The **Configured Worker** model (e.g. Gemini 3.8 Flash via Antigravity) is dispatched with strictly sandboxed tools (worktree-confined file edits, credential-scrubbed environment). The worker writes code and tests, then signals `Request Verification`.

### Journey 6: Automated Verification & Bounded Repair
The non-LLM verifier executes the project's test and lint commands inside the worktree.
- If checks **pass**, the orchestrator commits a candidate checkpoint SHA and advances to Code Review.
- If checks **fail**, failure logs return to the worker in a bounded repair loop (max `[PROPOSAL: 3]` attempts). If unresolved, the task transitions to `Blocked`.

### Journey 7: Independent Specialist Code Review
The **Configured Specialist Reviewer** model (Configured Strong Model) performs an adversarial code review against the exact candidate diff and verification digest. If the specialist model is rate-limited or unavailable, the review remains pending without downgrade or bypass.

### Journey 8: Owner Acceptance & Scoped Commit
The owner reviews the unified diff, test outputs, and review comments in the browser UI. The owner clicks **Accept**. The orchestrator stages **only** the files defined in the task's scope paths (preserving any unrelated owner edits) and records a clean commit on the feature branch. The worktree is cleaned up, and downstream tasks unblock.

### Journey 9: Feature Merge
When all tasks in the milestone are accepted, the owner clicks **Merge Feature Branch** (or merges manually via terminal), merging `zen/<feature-slug>` into the base branch.

---

## 4. Functional Requirements

### 4.1 Project & Repository Management

- **`REQ-F-REPO-01`**: The system SHALL allow the owner to import an existing local git repository by filesystem path.
- **`REQ-F-REPO-02`**: The system SHALL inspect the repository and detect: git status, current branch, clean/dirty state, HEAD commit SHA, language runtime, and test commands.
- **`REQ-F-REPO-03`**: The system SHALL reject importing a repository if the working tree has uncommitted changes, unless the owner explicitly provides a dirty working tree override.
- **`REQ-F-REPO-04`**: For each feature, the system SHALL create an isolated git feature branch (`zen/<feature-slug>`) rooted at the base commit SHA.
- **`REQ-F-REPO-05`**: For each task execution, the system SHALL provision an isolated git worktree (`.zen-worktrees/<task-id>`) checked out to a task branch (`zen/task/<task-id>`), ensuring the user's primary working directory remains untouched during agent execution.
- **`REQ-F-REPO-06`**: Upon task completion or cancellation, the system SHALL automatically remove the temporary git worktree and prune worktree metadata.

### 4.2 Specification & Baseline Management

- **`REQ-F-SPEC-01`**: The system SHALL provide a conversational chat interface with the Configured Planner/Architect model to formulate feature requirements.
- **`REQ-F-SPEC-02`**: The Planner model SHALL generate a structured specification containing: summary, functional requirements (`REQ-...`), nonfunctional requirements, and verification criteria.
- **`REQ-F-SPEC-03`**: The system SHALL provide an "Approve Baseline" action in the UI that:
  - Assigns a semantic version (`v1.0.0`).
  - Stores an immutable snapshot and content hash in SQLite.
  - Transitions the specification to `APPROVED` status.
- **`REQ-F-SPEC-04`**: Any modification to an approved baseline SHALL trigger an automated impact analysis identifying affected tasks before producing a new version (`v1.1.0`).

### 4.3 Task Decomposition & Scheduling

- **`REQ-F-TASK-01`**: The system SHALL automatically decompose an approved baseline into an ordered sequence of tasks with explicit IDs (`TSK-...`), scope paths (`scope_paths`), and dependency arrays (`blockedBy: [...]`).
- **`REQ-F-TASK-02`**: The orchestrator SHALL schedule tasks deterministically. A task SHALL NOT transition to `Ready` until all dependencies in `blockedBy` are `Done`.
- **`REQ-F-TASK-03`**: The system SHALL enforce sequential execution (exactly one active writer task per project) in Milestone 1.

### 4.4 Configurable Model Strategy

- **`REQ-F-MOD-01`**: The system SHALL allow the owner to independently configure the provider, model, and reasoning effort for each role:
  - **Planner / Architect:** Default Configured Strong Model (e.g. Claude 3.7 Sonnet / Opus via Antigravity or GPT-5.6-sol via Codex).
  - **Worker / Implementer:** Default Configured Worker Model (e.g. Gemini 3.8 Flash via Antigravity).
  - **Specialist Reviewer:** Default Configured Strong Model (e.g. Claude 3.7 Sonnet Thinking via Antigravity or GPT-5.6-sol via Codex).
- **`REQ-F-MOD-02`**: The system SHALL NOT hardcode any proprietary model identifier as mandatory.
- **`REQ-F-MOD-03`**: If a configured model becomes unavailable (rate limit, quota exhaustion), the orchestrator SHALL attempt configured fallback accounts or models within that role tier.
- **`REQ-F-MOD-04`**: If the Specialist Reviewer role has no available models, the task SHALL enter `Code Review (Pending Specialist)` and SHALL NOT proceed without review or explicit owner bypass.

### 4.5 Execution Security & Sandboxing

- **`REQ-F-SEC-01`**: The system SHALL enforce working directory confinement. File tools SHALL resolve target paths and throw an immediate access error if any path traverses outside the assigned task worktree directory.
- **`REQ-F-SEC-02`**: The system SHALL sanitize environment variables passed to child processes, explicitly stripping API keys, OAuth tokens (`ANTHROPIC_API_KEY`, Google refresh tokens, OpenAI tokens), and parent process credentials.
- **`REQ-F-SEC-03`**: The system SHALL execute shell commands via an allowlisted command runner. High-risk administrative commands (e.g., `sudo`, `mkfs`, `rm -rf /`) SHALL be rejected.
- **`REQ-F-SEC-04`**: The worker agent process SHALL be restricted from initiating direct outbound network requests outside the local loopback (`127.0.0.1`).

### 4.6 Automated Verification & Bounded Repair Loops

- **`REQ-F-VERI-01`**: When a worker requests verification, the orchestrator SHALL execute project test and lint suites inside the task worktree.
- **`REQ-F-VERI-02`**: If all checks exit with code 0, the orchestrator SHALL capture a candidate commit SHA and verification digest, advancing the task to `Code Review`.
- **`REQ-F-VERI-03`**: If checks fail, the orchestrator SHALL return failure logs to the worker and increment the repair attempt counter.
- **`REQ-F-VERI-04`**: The orchestrator SHALL enforce a maximum repair loop limit (`[PROPOSAL: 3]` attempts). If exceeded, the task SHALL transition to `Blocked`.

### 4.7 Exact Review Artifact Contract

- **`REQ-F-REV-01`**: The Specialist Reviewer model SHALL be invoked exclusively against an exact review artifact consisting of:
  - `base_commit_sha`: The commit SHA from which the task worktree branched.
  - `candidate_commit_sha` & `diff_digest`: The exact commit SHA and SHA256 digest of the working diff.
  - `verification_digest`: SHA256 digest of the passing test execution logs and exit codes.
- **`REQ-F-REV-02`**: The Reviewer model SHALL output a structured JSON verdict (`APPROVE` or `CHANGES_REQUESTED`), summary, and categorized findings.
- **`REQ-F-REV-03`**: If any file in the worktree changes after verification or during review, prior verification and review verdicts SHALL be automatically invalidated, resetting the task to `Automated Checks`.

### 4.8 Decoupled Acceptance, Committing, and Merging

- **`REQ-F-GOV-01`**: The browser UI SHALL provide a three-stage decoupled governance model:
  1. **Task Acceptance:** Owner reviews diff, test logs, and specialist remarks, and marks the task `Accepted`.
  2. **Selective Committing:** The orchestrator stages **only** files specified in the task's `scope_paths`, commits to the feature branch, and preserves uncommitted owner edits in unrelated files.
  3. **Feature Merging:** Merging the feature branch into `main` SHALL be a distinct, explicit owner action (`REQ-F-GOV-04`).
- **`REQ-F-GOV-02`**: If the owner selects "Request Changes", they SHALL provide feedback notes; the task resets to `In Progress` with feedback injected into the worker context.
- **`REQ-F-GOV-03`**: The owner SHALL be able to pause, resume, or cancel active execution at any time.
- **`REQ-F-GOV-04`**: The system SHALL provide a "Merge Feature" action in the UI that rebases or squash-merges `zen/<feature-slug>` into the base branch only when all tasks are `Done`.

---

## 5. Nonfunctional Requirements & Proposed Limits

All numerical values in this section are marked as proposals until owner calibration.

### 5.1 Token & Cost Governance

- **`REQ-NF-COST-01`**: The system SHALL distinguish between **observed usage** (actual token counts reported by upstream provider APIs) and **estimated usage** (heuristic token calculations derived from character counts / 4).
- **`REQ-NF-COST-02`**: If an upstream provider returns missing or null token metrics, the orchestrator SHALL compute an estimated usage value and flag the record as `is_estimated = 1` in SQLite.
- **`REQ-NF-COST-03`**: The system SHALL support independent budget allocations:
  - Total Feature Token Ceiling: `[PROPOSAL: 500,000 tokens]`.
  - Single Task Token Ceiling: `[PROPOSAL: 150,000 tokens]`.
  - Dedicated Specialist Reviewer Budget: `[PROPOSAL: 80,000 tokens]`.
- **`REQ-NF-COST-04`**: When cumulative task usage reaches `[PROPOSAL: 90%]` of its ceiling, a warning SHALL be emitted; at `100%`, execution SHALL pause immediately with status `Blocked (Budget Exhausted)`.

### 5.2 Performance & Responsiveness

- **`REQ-NF-PERF-01`**: The browser UI SHALL load project dashboards, task boards, and diff views in `[PROPOSAL: ≤ 1.5s]` on local networks.
- **`REQ-NF-PERF-02`**: Worktree provisioning and teardown SHALL complete in `[PROPOSAL: ≤ 500ms]` for standard repositories.
- **`REQ-NF-PERF-03`**: State machine transitions SHALL process within `[PROPOSAL: ≤ 250ms]`.

### 5.3 Reliability, Persistence & Recovery

- **`REQ-NF-REL-01`**: Database schema evolution SHALL be governed by sequential, versioned migrations tracked in a `schema_migrations` table.
- **`REQ-NF-REL-02`**: Upon service startup, the orchestrator SHALL perform crash recovery:
  - Identify tasks in transient states (`In Progress`, `Automated Checks`, `Code Review`).
  - Check lease heartbeats. If inactive > `[PROPOSAL: 5 minutes]`, transition to `Interrupted` or `Ready (Retry)`.
  - Prune orphaned git worktrees and release stale locks.
- **`REQ-NF-REL-03`**: SQLite database operations SHALL execute in WAL mode with a busy timeout of `[PROPOSAL: 10,000ms]`.

---

## 6. Milestone 1 Acceptance Criteria

Milestone 1 is complete when the following end-to-end scenario passes:

1. **Import:** Owner imports a clean local repository.
2. **Scoping:** Owner chats with the Planner model to define a new utility function and tests.
3. **Baseline:** System generates a valid PRD; owner approves Baseline `v1.0.0`.
4. **Decomposition:** Orchestrator creates 2 tasks with scope paths and dependencies.
5. **Worktree Isolation:** System provisions an isolated git worktree for `TSK-01`; the owner's active checkout remains clean on `main`.
6. **Implementation:** Configured Worker implements code and tests within the worktree.
7. **Verification:** Automated tests pass (`exit 0`).
8. **Specialist Review:** Reviewer model evaluates the diff digest and emits `APPROVE`.
9. **Accept & Commit:** Owner inspects diff in UI and clicks **Accept**. The orchestrator commits only task-scoped files to the feature branch and removes the worktree.
10. **Downstream Unblocking:** `TSK-02` transitions to `Ready`.
