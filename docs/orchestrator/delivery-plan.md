# Delivery Plan: Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 1 — Detailed Execution Roadmap  
**Date:** 2026-09-09  
**Target Release:** v0.1.0 (Milestone 1: Core Vertical Slice)  

---

## 1. Phased Delivery Roadmap

The transformation of Claude-Zen from a proxy gateway into an autonomous software delivery system is structured across five sequential milestones:

```
┌───────────────────────────────┐
│ Milestone 0: Discovery & Plan │  ◀── CURRENT PHASE (Complete)
│ Architecture & PRD Contracts  │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ Milestone 1: Vertical Slice   │  ◀── IMMEDIATE IMPLEMENTATION TARGET
│ Worktree Isolation to Review  │      Sequential, 1 writer, Worktrees in M1,
│                               │      Configurable roles, Bounded repair
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ Milestone 2: Previews & CI    │
│ Safe Previews & Test Insights │      Sanitized local dev preview, failure hints
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ Milestone 3: Advanced Scoping │
│ Impact Analysis & Multi-Epic  │      Spec versioning diffs, task rework flags
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ Milestone 4: Parallel Swarms  │
│ Concurrent Worktree Writers   │      Multi-agent parallel execution & auto-merge
└───────────────────────────────┘
```

---

## 2. Milestone 1: Core Vertical Slice (Detailed Plan)

**Goal:** Implement the end-to-end vertical slice: Import local repository → Discuss feature with Architect → Approve versioned baseline → Decompose task DAG → Provision isolated Git worktree → Execute bounded worker edits with execution security → Run automated verification checks → Conduct specialist adversarial diff review → Review, Accept, selectively Commit, and Merge in browser UI.

### 2.1 Task Dependency Graph (Milestone 1)

```
┌──────────────────────────────────────────────┐
│ TSK-M1-01: Versioned DB Migrations & Engine  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-02: Workspace & Worktree Manager      │
│ (Branch & Worktree Isolation for M1)         │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-03: Conversational Baseline Engine    │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-04: Task Decomposition & DAG Scheduler│
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-05: Execution Security & Worker Loop  │
│ (Worktree Confinement & Harness Integration) │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-06: Verification Engine & Repair Loop │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-07: Specialist Code Review Engine     │
│ (Exact Artifact Diff & Verification Digest)  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-08: Delivery Browser UI & Governance  │
│ (Decoupled Accept / Commit / Merge Controls) │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ TSK-M1-09: End-to-End Vertical Slice Test    │
└──────────────────────────────────────────────┘
```

---

### 2.2 Milestone 1 Detailed Task Specifications

#### `TSK-M1-01`: Versioned Database Migrations & Crash Recovery Engine
- **Linked Requirements:** `REQ-NF-REL-01`, `REQ-NF-REL-02`, `REQ-NF-REL-03`, `REQ-NF-COST-01`, `REQ-NF-COST-02`
- **Owner Role:** Backend Engineer
- **Scope:** 
  1. Implement a dedicated versioned migration runner using Node.js native `DatabaseSync` (`~/.zen-claude/zen-orchestrator.sqlite`).
  2. Create the `schema_migrations` table and initial transactional migration (`001_initial_orchestrator_schema.sql`) defining tables: `projects`, `requirements_baselines`, `milestones`, `tasks`, `task_runs`, `verification_results`, `audit_logs`.
  3. Include columns for `is_estimated`, `observed_tokens`, `estimated_tokens`, `worktree_path`, `base_commit_sha`, `candidate_commit_sha`, `diff_digest`, `verification_digest`.
  4. Implement startup crash recovery logic that detects stale task leases (> `[PROPOSAL: 5 minutes]`), resets transient tasks, and cleans up orphaned worktree locks.
- **Deliverables:**
  - `lib/orchestrator/db/migration-runner.mjs`: Versioned migration executor.
  - `lib/orchestrator/db/migrations/001_initial_schema.sql`: Full DDL.
  - `lib/orchestrator/db/recovery-manager.mjs`: Startup recovery sweep.
  - Unit tests validating migrations, schema roll-forward, and recovery sweeps.
- **Dependencies:** None (First task to execute)
- **Acceptance Criteria:**
  - Migrations run idempotently and record applied versions in `schema_migrations`.
  - Stale task leases are cleanly reset to `Interrupted` or `Ready` on boot.
- **Verification:** `node --test test/orchestrator-db.test.mjs`

---

#### `TSK-M1-02`: Repository Workspace & Worktree Manager (Milestone 1 Isolation)
- **Linked Requirements:** `REQ-F-REPO-01`, `REQ-F-REPO-02`, `REQ-F-REPO-03`, `REQ-F-REPO-04`, `REQ-F-REPO-05`, `REQ-F-REPO-06`
- **Owner Role:** Systems / Git Engineer
- **Scope:**
  1. Build the repository inspection service (clean git tree verification, runtime language detection, test script discovery).
  2. Implement isolated feature branch creation (`zen/<feature-slug>`).
  3. Implement **Milestone 1 Git Worktree Isolation**: dynamically create isolated git worktrees (`.zen-worktrees/<task-id>`) checked out to `zen/task/<task-id>`.
  4. Implement worktree removal and pruning (`git worktree remove --force`, `git worktree prune`).
  5. Ensure the owner's primary working directory (e.g. `main`) is never locked or dirtied while an agent works.
- **Deliverables:**
  - `lib/orchestrator/git-workspace.mjs`: Branch and worktree lifecycle manager.
  - Unit tests testing worktree creation, clean/dirty detection, and teardown on temporary git repos.
- **Dependencies:** `TSK-M1-01`
- **Acceptance Criteria:**
  - Worktree provisioned in `[PROPOSAL: ≤ 500ms]`.
  - Edits inside the worktree do not appear in `git status` of the primary repository root.
  - Teardown prunes all temporary worktree references.
- **Verification:** `node --test test/git-workspace.test.mjs`

---

#### `TSK-M1-03`: Conversational Baseline & Specification Engine
- **Linked Requirements:** `REQ-F-SPEC-01`, `REQ-F-SPEC-02`, `REQ-F-SPEC-03`, `REQ-F-SPEC-04`, `REQ-F-MOD-01`
- **Owner Role:** AI / Prompt Engineer
- **Scope:**
  1. Implement the conversational chat scoper with the Configured Planner/Architect model (using Antigravity or Codex).
  2. Implement the Architect system prompt enforcing structured PRD output with stable requirement IDs (`REQ-...`) and acceptance criteria.
  3. Implement the Baseline Approval handler: assigns version `v1.0.0`, calculates content digest, locks record in `requirements_baselines` as `APPROVED`.
  4. Implement automated impact analysis skeleton for post-approval changes.
- **Deliverables:**
  - `lib/orchestrator/spec-engine.mjs`: Conversation manager, architect prompts, and baseline version locking.
  - REST endpoints for chat streaming, draft generation, and approval locking.
- **Dependencies:** `TSK-M1-01`, `TSK-M1-02`
- **Acceptance Criteria:**
  - Chat tokens stream in real time via SSE.
  - Generated markdown adheres to the specification schema.
  - Approved baseline is immutable and stored with SHA256 digest.
- **Verification:** `node --test test/spec-engine.test.mjs`

---

#### `TSK-M1-04`: Task Decomposition & Deterministic DAG Scheduler
- **Linked Requirements:** `REQ-F-TASK-01`, `REQ-F-TASK-02`, `REQ-F-TASK-03`, `REQ-NF-PERF-03`
- **Owner Role:** Backend Engineer
- **Scope:**
  1. Prompt the Architect model to parse the approved baseline into a JSON array of bounded tasks (`TSK-...`), input/output file scopes (`scope_paths`), and dependencies (`blockedBy`).
  2. Implement the deterministic 9-state task state machine (`Backlog`, `Ready`, `In Progress`, `Automated Checks`, `Code Review`, `QA`, `Done`, `Blocked`, `Cancelled`).
  3. Enforce the single active writer rule: exactly one task may write to a project at a time in Milestone 1.
  4. Block invalid state transitions with validation errors.
- **Deliverables:**
  - `lib/orchestrator/dag-scheduler.mjs`: State machine and dependency graph engine.
  - Unit tests validating state transitions, dependency satisfaction, and illegal state rejections.
- **Dependencies:** `TSK-M1-03`
- **Acceptance Criteria:**
  - Tasks in `blockedBy` must reach `Done` before a downstream task becomes `Ready`.
  - State machine transitions process in `[PROPOSAL: ≤ 250ms]`.
- **Verification:** `node --test test/dag-scheduler.test.mjs`

---

#### `TSK-M1-05`: Execution Security Sandbox & Bounded Worker Harness
- **Linked Requirements:** `REQ-F-EXEC-01`, `REQ-F-EXEC-02`, `REQ-F-EXEC-03`, `REQ-F-SEC-01`, `REQ-F-SEC-02`, `REQ-F-SEC-03`, `REQ-F-SEC-04`, `REQ-F-MOD-01`
- **Owner Role:** Core Systems / Security Engineer
- **Scope:**
  1. Implement execution security distinct from git isolation:
     - Working directory confinement: `assertPathWithinWorktree` enforces realpath boundaries within `.zen-worktrees/<task-id>`.
     - Environment variable sanitization: explicitly scrub API keys, OAuth tokens, and host secrets before spawning processes.
     - Command runner allowlist: permit only standard build/test binaries (`npm`, `pytest`, `cargo`, `go`); block destructive root commands (`sudo`, `mkfs`, `rm -rf /`).
     - Network boundary enforcement: prevent worker direct WAN egress.
  2. Implement the worker agent execution harness:
     - Wire to the Configured Worker model (default: Gemini 3.8 Flash via Antigravity).
     - Provide worktree-confined tools: `read_file`, `write_file`, `edit_file`, `list_files`, `run_command`.
     - Evaluate / test harness integration: verify whether headless CLI (`claude -p --output-format stream-json --permission-mode dontAsk`) or native Node.js agent loop is selected based on gateway parity checks.
- **Deliverables:**
  - `lib/orchestrator/security-sandbox.mjs`: Path confinement, environment sanitization, command filter.
  - `lib/orchestrator/worker-harness.mjs`: Sandboxed worker agent loop.
  - Security unit tests verifying that path traversal (`../../etc/passwd`) and banned commands are blocked.
- **Dependencies:** `TSK-M1-02`, `TSK-M1-04`
- **Acceptance Criteria:**
  - Worker edits local files exclusively inside the assigned worktree.
  - Path traversal outside the worktree fails with a security violation.
  - Environment variables do not leak provider tokens to child processes.
  - Worker signals `request_verification` when work is ready.
- **Verification:** `node --test test/worker-security.test.mjs`

---

#### `TSK-M1-06`: Automated Verification Engine & Bounded Repair Loop
- **Linked Requirements:** `REQ-F-VERI-01`, `REQ-F-VERI-02`, `REQ-F-VERI-03`, `REQ-F-VERI-04`, `REQ-NF-COST-03`
- **Owner Role:** Backend / DevOps Engineer
- **Scope:**
  1. Implement the deterministic verifier that executes project test and lint suites inside the task worktree.
  2. Capture execution logs, duration, exit codes, and compute a `verification_digest` (SHA256).
  3. If checks pass (`exit 0`), stage changes, commit a candidate checkpoint SHA (`candidate_commit_sha`), and advance task to `Code Review`.
  4. If checks fail (`exit != 0`), feed error logs back to the worker and increment `repair_attempts`.
  5. Enforce bounded repair loops: maximum `[PROPOSAL: 3]` attempts before transitioning task to `Blocked`.
- **Deliverables:**
  - `lib/orchestrator/verifier-engine.mjs`: Test execution runner, log capturer, digest computer, and repair loop controller.
  - Unit tests simulating passing checks, failing checks, and repair exhaustion.
- **Dependencies:** `TSK-M1-05`
- **Acceptance Criteria:**
  - Passing tests advance task to `Code Review` with candidate commit SHA and digest.
  - Failing tests trigger repair loop with failure logs.
  - Reaching 3 failing repairs transitions task to `Blocked`.
- **Verification:** `node --test test/verifier-engine.test.mjs`

---

#### `TSK-M1-07`: Specialist Code Review Engine & Exact Artifact Contract
- **Linked Requirements:** `REQ-F-REV-01`, `REQ-F-REV-02`, `REQ-F-REV-03`, `REQ-F-MOD-01`, `REQ-F-MOD-04`
- **Owner Role:** AI / Prompt Engineer
- **Scope:**
  1. Implement the Specialist Reviewer harness using the Configured Strong Model (Claude 3.7 Sonnet Thinking or GPT-5.6-sol).
  2. Bind review strictly to the exact review artifact: `base_commit_sha`, `candidate_commit_sha`, `diff_digest`, and `verification_digest`.
  3. Enforce review invalidation: if any worktree file changes after verification, immediately invalidate review and reset task to `Automated Checks`.
  4. Parse structured review findings: verdict (`APPROVE` or `CHANGES_REQUESTED`), summary, and categorized issues.
  5. Enforce specialist availability rule: if the specialist model is unavailable, hold task in `Code Review (Pending Specialist)` without bypass.
- **Deliverables:**
  - `lib/orchestrator/review-engine.mjs`: Review harness, diff generator, digest verifier, and verdict parser.
  - Unit tests verifying structured outputs, invalidation on file alteration, and quota pending holding.
- **Dependencies:** `TSK-M1-06`
- **Acceptance Criteria:**
  - Review analyzes exact candidate diff.
  - An `APPROVE` verdict advances task to `QA`.
  - A `CHANGES_REQUESTED` verdict returns task to `In Progress`.
  - Invalidation triggers if worktree files change post-verification.
- **Verification:** `node --test test/review-engine.test.mjs`

---

#### `TSK-M1-08`: Delivery Browser UI & Decoupled Governance Controls
- **Linked Requirements:** `REQ-F-GOV-01`, `REQ-F-GOV-02`, `REQ-F-GOV-03`, `REQ-F-GOV-04`, `REQ-NF-PERF-01`
- **Owner Role:** Frontend Engineer
- **Scope:**
  1. Build the browser UI application on port 8789:
     - Project Explorer & Repository Importer.
     - Interactive Chat Scoper with streaming tokens.
     - Baseline Approval view with markdown rendering.
     - Task Kanban Board & DAG dependency visualizer.
     - Unified Diff Viewer highlighting candidate changes, test outputs, and review comments.
  2. Implement decoupled governance actions:
     - **Accept Task:** Marks task `Accepted`; stages **only** files in `scope_paths` to the feature branch; cleans up worktree; unblocks downstream tasks.
     - **Request Changes:** Injects owner feedback and returns task to `In Progress`.
     - **Merge Feature:** Explicit owner button to merge `zen/<feature-slug>` into `main` when all tasks are `Done`.
- **Deliverables:**
  - Modern web application served locally by the Claude-Zen server.
  - Real-time SSE subscriber for streaming chat and live task events.
- **Dependencies:** `TSK-M1-01` through `TSK-M1-07`
- **Acceptance Criteria:**
  - UI loads in `[PROPOSAL: ≤ 1.5s]`.
  - Accepting a task selectively commits task-scoped files, leaving unrelated owner edits intact.
  - Feature merging is a distinct, explicit owner action.
- **Verification:** Playwright UI test suite in `test/orchestrator-ui.test.mjs`.

---

#### `TSK-M1-09`: End-to-End Vertical Slice Integration Test
- **Linked Requirements:** All Milestone 1 requirements (PRD Section 6)
- **Owner Role:** Lead Architect / QA Engineer
- **Scope:**
  1. Create an automated end-to-end integration test running against a fixture git repository.
  2. Execute the entire lifecycle: Import clean repo → Discuss feature → Approve Baseline v1.0.0 → Decompose 2 tasks → Provision worktree → Gemini worker implements code and tests → Automated checks pass → Specialist review approves diff digest → Owner accepts task → Scoped commit recorded → Second task unblocks.
- **Deliverables:**
  - `test/e2e-vertical-slice.test.mjs`: Complete end-to-end integration test script.
- **Dependencies:** `TSK-M1-01` through `TSK-M1-08`
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
