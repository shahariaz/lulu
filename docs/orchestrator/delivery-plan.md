# Delivery Plan: Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 2 — Resolved Architectural Contracts & Execution Sequencing  
**Date:** 2026-09-09  
**Target Release:** v0.1.0 (Milestone 1: Core Vertical Slice)  

---

## 1. Phased Delivery Roadmap

The transformation of Claude-Zen from a proxy gateway into an autonomous software delivery system is structured across five sequential milestones:

```
┌────────────────────────────────┐
│ Milestone 0: Discovery & Plan  │  ◀── CURRENT PHASE (Complete)
│ Architecture & PRD Contracts   │
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│ Milestone 1: Vertical Slice    │  ◀── IMMEDIATE IMPLEMENTATION TARGET
│ Worktree Isolation to Review   │      Sequential, 1 writer, Worktrees in M1,
│                                │      Configurable roles, Fast-forward merge
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│ Milestone 2: Previews & CI     │
│ Safe Previews & Test Insights  │      Sanitized local dev preview, failure hints
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│ Milestone 3: Advanced Scoping  │
│ Impact Analysis & Multi-Epic   │      Spec versioning diffs, task rework flags
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│ Milestone 4: Parallel Swarms   │
│ Concurrent Worktree Writers    │      Multi-agent parallel execution & auto-merge
└────────────────────────────────┘
```

---

## 2. Milestone 1: Core Vertical Slice (Detailed Plan)

**Goal:** Implement the complete vertical slice: Import local repository → Discuss feature with Architect → Approve versioned baseline → Decompose task DAG → Provision isolated Git worktree → Execute bounded worker edits with execution security → Run automated verification checks → Conduct specialist adversarial diff review → Review, Accept, fast-forward integrate, and Merge in browser UI.

### 2.1 Task Dependency Graph (Milestone 1)

```
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-01: Versioned DB Migrations & Recovery Engine     │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-02: Workspace & Worktree Manager                  │
│ (Branch & Worktree Isolation for M1)                     │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-03: Conversational Baseline Engine                │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-04: Task Decomposition & DAG Scheduler            │
│ (Normalized State Model: Tasks, Runs, Blockers, Reviews) │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-05: Offline Harness Compatibility Experiment      │
│ (TSK-SPIKE-HARNESS-PARITY: CLI vs Custom Loop Spike)     │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-06: Sandboxed Worker Execution Engine             │
│ (Confinement & Process Limits Governed by Spike Outcome) │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-07: Automated Verification Engine & Repair Loop   │
│ (Tracked-File Cleanliness & Environment Recording)       │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-08: Specialist Code Review Engine                 │
│ (Exact Candidate Commit SHA & Diff Digest Evaluation)    │
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-09: Delivery Browser UI & Decoupled Governance    │
│ (Acceptance -> Fast-Forward Integration -> Feature Merge)│
└────────────────────────────┬─────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│ TSK-M1-10: End-to-End Vertical Slice Integration Test    │
└──────────────────────────────────────────────────────────┘
```

---

### 2.2 Milestone 1 Detailed Task Specifications

#### `TSK-M1-01`: Versioned Database Migrations & Non-Destructive Recovery Engine
- **Linked Requirements:** `REQ-NF-REL-01`, `REQ-NF-REL-02`, `REQ-NF-REL-03`, `REQ-NF-COST-01`, `REQ-NF-COST-02`
- **Owner Role:** Backend Engineer
- **Scope:** 
  1. Implement a dedicated versioned migration runner using Node.js native `DatabaseSync` (`~/.zen-claude/zen-orchestrator.sqlite`).
  2. Create the `schema_migrations` table and initial transactional migration (`001_initial_orchestrator_schema.sql`) defining normalized tables: `projects`, `requirements_baselines`, `milestones`, `tasks`, `task_runs`, `verification_results`, `review_records`, `acceptance_records`, `audit_logs`.
  3. Support normalized columns: `is_estimated`, `observed_tokens`, `estimated_tokens`, `worktree_path`, `base_commit_sha`, `candidate_commit_sha`, `diff_digest`, `verification_digest`, `blocked_reason`.
  4. Implement **non-destructive boot-time recovery**:
     - Verify process identity (PID, start time, command line) before sending OS signals.
     - Heartbeat expiry alone **never** triggers worktree deletion.
     - Reconcile transient runs: inspect dirty worktrees, preserve changes to `refs/zen/recovery/<task-id>-<ts>`, set task status to `Blocked` with reason `RECONCILIATION_REQUIRED`.
     - Reconcile stale `index.lock` files safely.
- **Deliverables:**
  - `lib/orchestrator/db/migration-runner.mjs`: Migration runner.
  - `lib/orchestrator/db/migrations/001_initial_schema.sql`: Full DDL.
  - `lib/orchestrator/db/recovery-manager.mjs`: Non-destructive recovery manager.
  - Unit tests validating migrations, foreign keys, and recovery sweeps.
- **Dependencies:** None (First task to execute)
- **Acceptance Criteria:**
  - Migrations run idempotently and record applied versions.
  - Interrupted worktrees are preserved on disk and checkpointed on crash.
- **Verification:** `node --test test/orchestrator-db.test.mjs`

---

#### `TSK-M1-02`: Repository Workspace & Worktree Manager (Milestone 1 Isolation)
- **Linked Requirements:** `REQ-F-REPO-01`, `REQ-F-REPO-02`, `REQ-F-REPO-03`, `REQ-F-REPO-04`, `REQ-F-REPO-05`, `REQ-F-REPO-06`
- **Owner Role:** Systems / Git Engineer
- **Scope:**
  1. Build repository inspection service (clean git tree verification, runtime language detection, test script discovery).
  2. Implement isolated feature branch creation (`zen/<feature-slug>`).
  3. Implement **Milestone 1 Git Worktree Isolation**: dynamically create isolated git worktrees (`.zen-worktrees/<task-id>`) checked out to `zen/task/<task-id>` branching from the feature branch.
  4. Implement fast-forward integration helper: `git merge --ff-only zen/task/<task-id>`.
  5. Worktree teardown policy: worktrees are eligible for deletion **only** after fast-forward integration succeeds (`tasks.status = 'Done'`) or on explicit owner discard.
- **Deliverables:**
  - `lib/orchestrator/git-workspace.mjs`: Branch, worktree, and fast-forward integration lifecycle manager.
  - Unit tests testing worktree creation, isolation from primary working copy, and teardown.
- **Dependencies:** `TSK-M1-01`
- **Acceptance Criteria:**
  - Worktree provisioned in `[PROPOSAL: ≤ 500ms]`.
  - Primary working directory on `main` is completely untouched by worktree edits.
  - Fast-forward merge cleanly integrates candidate commits.
- **Verification:** `node --test test/git-workspace.test.mjs`

---

#### `TSK-M1-03`: Conversational Baseline & Specification Engine
- **Linked Requirements:** `REQ-F-SPEC-01`, `REQ-F-SPEC-02`, `REQ-F-SPEC-03`, `REQ-F-SPEC-04`, `REQ-F-MOD-01`
- **Owner Role:** AI / Prompt Engineer
- **Scope:**
  1. Implement the conversational chat scoper with the Configured Planner/Architect model (using Antigravity or Codex).
  2. Implement the Architect system prompt enforcing structured PRD output with stable requirement IDs (`REQ-...`) and acceptance criteria.
  3. Implement Baseline Approval handler: assigns version `v1.0.0`, calculates content digest, locks record in `requirements_baselines` as `APPROVED`.
  4. Implement automated impact analysis skeleton for post-approval changes.
- **Deliverables:**
  - `lib/orchestrator/spec-engine.mjs`: Conversation manager, architect prompts, and baseline version locking.
  - REST endpoints for chat streaming, draft generation, and approval locking.
- **Dependencies:** `TSK-M1-01`, `TSK-M1-02`
- **Acceptance Criteria:**
  - Chat tokens stream in real time via SSE.
  - Approved baseline is immutable and stored with SHA256 digest.
- **Verification:** `node --test test/spec-engine.test.mjs`

---

#### `TSK-M1-04`: Task Decomposition & DAG Scheduler (Normalized State Model)
- **Linked Requirements:** `REQ-F-TASK-01`, `REQ-F-TASK-02`, `REQ-F-TASK-03`, `REQ-NF-PERF-03`
- **Owner Role:** Backend Engineer
- **Scope:**
  1. Prompt the Architect model to parse the approved baseline into a JSON array of bounded tasks (`TSK-...`), input/output file scopes (`scope_paths`), and dependencies (`blockedBy`).
  2. Implement the normalized state machine managing visible product stages (`Backlog`, `Ready`, `In Progress`, `Automated Checks`, `Code Review`, `QA`, `Done`, `Blocked`, `Cancelled`).
  3. Manage decoupled execution run records (`task_runs`), blocker reasons (`tasks.blocked_reason`), and review verdicts.
  4. Enforce sequential execution: exactly one task may be `In Progress` per project.
  5. Enforce dependency unblocking: downstream tasks in `Backlog` transition to `Ready` only when all prerequisite tasks have `status = 'Done'`.
- **Deliverables:**
  - `lib/orchestrator/dag-scheduler.mjs`: State machine and dependency graph engine.
  - Unit tests validating state transitions, dependency unblocking, and blocker assignments.
- **Dependencies:** `TSK-M1-03`
- **Acceptance Criteria:**
  - Downstream tasks remain blocked until all prerequisites reach `Done`.
  - State transitions execute in `[PROPOSAL: ≤ 250ms]`.
- **Verification:** `node --test test/dag-scheduler.test.mjs`

---

#### `TSK-M1-05`: Offline Harness Compatibility Experiment (`TSK-SPIKE-HARNESS-PARITY`)
- **Linked Requirements:** `REQ-F-EXEC-01`, Architecture Proposal Section 2.4
- **Owner Role:** Core Systems Engineer
- **Scope:**
  1. Implement an automated, offline test spike to empirically settle the worker harness choice without making live provider requests.
  2. Audit installed `claude` CLI binary (version 2.1.231) options.
  3. Spin up an offline mock Anthropic `/v1/messages` server replaying SSE fixtures from `test/anthropic-sse.test.mjs`.
  4. Test spawning `claude -p "smoke test" --bare --output-format stream-json --permission-mode dontAsk` against the mock server.
  5. Test full `tool_use` -> `tool execution` -> `tool_result` -> `final response` cycle with NDJSON streaming.
  6. Document pass/fail determination:
     - If PASS: Select Approach A (Headless CLI) for worker engine.
     - If FAIL: Select Approach C (Custom In-Process Loop) for worker engine.
- **Deliverables:**
  - `test/harness-compat-spike.test.mjs`: Automated offline experiment script.
  - Compatibility report outputting tested headers, streaming events, and final verdict.
- **Dependencies:** `TSK-M1-01` through `TSK-M1-04` (Executes before worker engine implementation)
- **Acceptance Criteria:**
  - Runs 100% offline with zero external API calls or real credentials.
  - Decisively outputs a PASS or FAIL verdict governing `TSK-M1-06`.
- **Verification:** `node --test test/harness-compat-spike.test.mjs`

---

#### `TSK-M1-06`: Sandboxed Worker Execution Engine
- **Linked Requirements:** `REQ-F-EXEC-01`, `REQ-F-EXEC-02`, `REQ-F-EXEC-03`, `REQ-F-SEC-01`, `REQ-F-SEC-02`, `REQ-F-SEC-03`, `REQ-F-SEC-04`, `REQ-F-MOD-01`
- **Owner Role:** Core Systems / Security Engineer
- **Scope:**
  1. Build the worker execution harness implementing the engine selected by `TSK-M1-05`:
     - If Approach A: spawns `claude` CLI in worktree with NDJSON stream parser.
     - If Approach C: runs native Node.js agentic loop over local gateway `/v1/messages`.
  2. Implement concrete execution boundary protections:
     - Working directory confinement: `assertPathWithinWorktree` blocks access outside `.zen-worktrees/<task-id>`.
     - Environment variable sanitization: strip provider API keys and parent process tokens.
     - Process tree timeouts (`[PROPOSAL: 120s]`) killing process group via `setpgid`.
     - Command allowlist: build/test binaries (`npm`, `pytest`, `cargo`, `go`) only; shell interpreters blocked.
  3. Connect worker to the Configured Worker model (e.g. Gemini 3.8 Flash via Antigravity).
  4. When implementation completes, stage intended files in `scope_paths` and commit `candidate_commit_sha`.
- **Deliverables:**
  - `lib/orchestrator/worker-harness.mjs`: Sandboxed worker engine.
  - `lib/orchestrator/security-boundary.mjs`: Path check, env scrubber, process tree manager.
  - Security unit tests verifying path traversal blocking and process termination.
- **Dependencies:** `TSK-M1-02`, `TSK-M1-04`, `TSK-M1-05`
- **Acceptance Criteria:**
  - Worker edits local files exclusively inside the assigned worktree.
  - Path traversal outside the worktree fails with a security violation.
  - Commits `candidate_commit_sha` on `zen/task/<task-id>`.
- **Verification:** `node --test test/worker-harness.test.mjs`

---

#### `TSK-M1-07`: Automated Verification Engine & Bounded Repair Loop
- **Linked Requirements:** `REQ-F-VERI-01`, `REQ-F-VERI-02`, `REQ-F-VERI-03`, `REQ-F-VERI-04`, `REQ-F-VERI-05`, `REQ-NF-COST-03`
- **Owner Role:** Backend / DevOps Engineer
- **Scope:**
  1. Implement the deterministic verifier that executes project test and lint suites inside the task worktree against `candidate_commit_sha`.
  2. Record environment metadata (OS, runtime version, git commit) and execution logs.
  3. **Tracked File Cleanliness Rule:** If verification execution modifies any tracked file in the worktree, verification **fails** immediately with `E_VERIFICATION_DIRTIED_WORKING_TREE`.
  4. If checks pass (`exit 0`), compute `verification_digest` (SHA256) and advance task to `Code Review`.
  5. If checks fail (`exit != 0`), feed error logs back to worker, increment `repair_attempts`, and retry.
  6. Enforce bounded repair loops: maximum `[PROPOSAL: 3]` attempts before transitioning task to `Blocked` with reason `REPAIR_LIMIT_EXCEEDED`.
- **Deliverables:**
  - `lib/orchestrator/verifier-engine.mjs`: Test runner, log capturer, digest computer, and repair loop controller.
  - Unit tests testing clean test runs, dirty working tree rejections, and repair limits.
- **Dependencies:** `TSK-M1-06`
- **Acceptance Criteria:**
  - Passing tests advance task to `Code Review` with verification digest.
  - Dirtied tracked files fail verification.
  - 3 failing repairs transitions task to `Blocked`.
- **Verification:** `node --test test/verifier-engine.test.mjs`

---

#### `TSK-M1-08`: Specialist Code Review Engine
- **Linked Requirements:** `REQ-F-REV-01`, `REQ-F-REV-02`, `REQ-F-REV-03`, `REQ-F-MOD-01`, `REQ-F-MOD-04`
- **Owner Role:** AI / Prompt Engineer
- **Scope:**
  1. Implement Specialist Reviewer harness using the Configured Strong Model.
  2. Bind review strictly to the immutable review artifact: `base_commit_sha`, `candidate_commit_sha`, `diff_digest`, and `verification_digest`.
  3. Enforce review invalidation: if any worktree file is altered post-verification, invalidate prior verification and review, resetting task to `Automated Checks`.
  4. Parse structured review findings: verdict (`APPROVE` or `CHANGES_REQUESTED`), summary, categorized issues.
  5. Enforce specialist availability rule: if specialist model is unavailable, hold task in `Code Review` with blocker reason `SPECIALIST_UNAVAILABLE` without bypass.
- **Deliverables:**
  - `lib/orchestrator/review-engine.mjs`: Review harness, diff generator, digest verifier, and verdict parser.
  - Unit tests verifying structured outputs, invalidation on file alteration, and quota pending holding.
- **Dependencies:** `TSK-M1-07`
- **Acceptance Criteria:**
  - Review evaluates exact candidate diff.
  - `APPROVE` verdict advances task to `QA`.
  - `CHANGES_REQUESTED` verdict returns task to `In Progress`.
- **Verification:** `node --test test/review-engine.test.mjs`

---

#### `TSK-M1-09`: Delivery Browser UI & Decoupled Governance Controls
- **Linked Requirements:** `REQ-F-GOV-01`, `REQ-F-GOV-02`, `REQ-F-GOV-03`, `REQ-F-GOV-04`, `REQ-NF-PERF-01`
- **Owner Role:** Frontend Engineer
- **Scope:**
  1. Build the browser UI views on port 8789:
     - Project Explorer & Importer.
     - Interactive Chat Scoper with streaming tokens.
     - Baseline Version Approver.
     - Task Kanban Board (showing visible product stages: Backlog, Ready, In Progress, Automated Checks, Code Review, QA, Done, Blocked).
     - Unified Diff Viewer highlighting candidate commit changes, test logs, and reviewer remarks.
  2. Implement decoupled governance actions:
     - **Accept Task (QA):** Approves `candidate_commit_sha`, runs `git merge --ff-only` into `zen/<feature-slug>`, prunes worktree, marks task `Done`, and unblocks downstream tasks.
     - **Request Changes:** Returns task to `In Progress` with feedback notes.
     - **Merge Feature:** Explicit owner button to merge `zen/<feature-slug>` into `main` when all tasks are `Done`.
- **Deliverables:**
  - Web application bundled and served locally by the Claude-Zen server.
  - Real-time SSE subscriber for streaming chat and live task events.
- **Dependencies:** `TSK-M1-01` through `TSK-M1-08`
- **Acceptance Criteria:**
  - UI renders all visible product stages clearly.
  - Fast-forward integration merges accepted candidate cleanly.
- **Verification:** Playwright UI test suite in `test/orchestrator-ui.test.mjs`.

---

#### `TSK-M1-10`: End-to-End Vertical Slice Integration Test
- **Linked Requirements:** All Milestone 1 requirements (PRD Section 6)
- **Owner Role:** Lead Architect / QA Engineer
- **Scope:**
  1. Create an automated end-to-end integration test against a fixture git repository.
  2. Execute complete lifecycle: Import clean repo → Discuss feature → Approve Baseline v1.0.0 → Decompose 2 tasks → Provision worktree → Worker implements code and tests → Automated checks pass → Specialist review approves candidate diff → Owner accepts task → Fast-forward merge to feature branch succeeds → Worktree removed → Second task unblocks.
- **Deliverables:**
  - `test/e2e-vertical-slice.test.mjs`: Complete end-to-end integration test script.
- **Dependencies:** `TSK-M1-01` through `TSK-M1-09`
- **Acceptance Criteria:**
  - Entire vertical slice executes cleanly and deterministically.
  - Feature branch has clean commits containing only scoped files.
  - Owner's primary working copy was never modified during execution.
- **Verification:** Run `npm run test:e2e-vertical-slice`.

---

## 3. High-Level Roadmap for Later Milestones

### 3.1 Milestone 2: Workspace Hardening & Safe Previews
- **Isolated Local Previews:** Spawns local dev servers on isolated localhost ports with environment filtering.
- **Interactive Failure Inspector:** Provides owner guidance hints and error log search for `Blocked` tasks.
- **Automated Feature Merging & Branch Cleanup:** Squash/rebase automation with interactive git conflict resolution.

### 3.2 Milestone 3: Advanced Scoping & Requirements Impact Analysis
- **Multi-Epic & Sprint Planning:** Hierarchical decomposition of complex requirements.
- **Requirements Version Diffing:** Visual comparison of `v1.0.0` vs. `v1.1.0`.
- **Automated Impact Analysis:** When a baseline changes, the Architect flags affected tasks for rework.

### 3.3 Milestone 4: Parallel Worktrees & Multi-Agent Swarms
- **Concurrent Worktree Execution:** Multiple worker agents writing in parallel to independent git worktrees.
- **Conflict-Free Merge Coordinator:** Sequentially validates and merges completed worktree branches.
