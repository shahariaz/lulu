# Architecture Review: Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 3 — Follow-Up Review and Remaining Gates  
**Date:** 2026-09-09  
**Reviewer Role:** Architecture Reviewer  
**Review Target:** Phase 0 Planning Package (`docs/orchestrator/`) and Existing Gateway Codebase  
**Status:** Core Contracts Corrected; Foundation Ready; Owner Choices and Harness Evidence Pending  

---

## 1. Executive Summary & Review Verdict

### Implementation Readiness Verdict: **PARTIAL PASS — FOUNDATION TASKS READY; WORKER/UI GATED**

Following detailed validation against the existing codebase and runtime environment (Node.js v24.19.0, Git 2.55.0, Claude Code 2.1.231), the Phase 0 architecture contracts have been resolved across five core technical areas:

1. **Non-Destructive Recovery:** Automatic forced worktree deletion is eliminated from all recovery, cancellation, and failure paths. The actual workspace—including tracked, untracked, and ignored files—is preserved on disk. Crash recovery relies on verified process ownership (PID, start time, command line) and handles lease inquiries without destructive side effects.
2. **Realistic Execution Boundaries:** The execution boundary is honestly characterized as a **Cooperative Runtime Boundary (Defense-in-Depth)** for Milestone 1 workstation use, with explicit limitations documented. An advanced containerized/OS-isolated tier is specified as a distinct proposal.
3. **Watertight Git Lifecycle:** One consistent lifecycle sequence is established: `Task base → candidate snapshot → automated verification → specialist review → owner acceptance → fast-forward integration into feature branch → Done`. Candidate commits stage intended changes immutably; tracked-file modifications during verification invalidate results; task integration is strictly fast-forward only (`git merge --ff-only`).
4. **Preserved Product Stages & Normalized State Model:** Visible product stages (`Backlog`, `Ready`, `In Progress`, `Automated Checks`, `Code Review`, `QA`, `Done`, `Blocked`, `Cancelled`) are fully preserved in `tasks.status`. Orthogonal concerns (`task_runs.status`, `tasks.waiting_reason`, `tasks.blocked_reason`, `review_records.verdict`, and `acceptance_records`) are separated into distinct schema fields.
5. **Empirical Compatibility Spike:** Execution engine selection remains open. An offline experiment (`TSK-SPIKE-HARNESS-PARITY`) is scheduled before worker harness implementation to empirically evaluate CLI vs. in-process execution without making live provider requests.

---

## 2. Detailed Findings & Validated Resolutions

### Finding 1 (CRITICAL): Non-Destructive Recovery & Process Reconciliation
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 7 & 11
  - `docs/orchestrator/delivery-plan.md`: `TSK-M1-01`
  - `docs/orchestrator/prd.md`: Section 5.3 (`REQ-NF-REL-02`)
- **Analysis & Defect:**
  Earlier drafts proposed running `git worktree remove --force` on stale worktrees upon orchestrator boot. This risked permanent data loss of uncommitted work and ignored files. Additionally, relying solely on an emergency Git commit is inadequate because Git commits do not capture untracked scratch files, build outputs, or ignored environment configurations.
- **Validated Architectural Resolution:**
  1. **Worker Identity & Ownership:** Before sending any signal (`SIGTERM`/`SIGKILL`), the orchestrator verifies:
     - `process_pid`, `process_start_time` (verified via `/proc` or `ps -o lstart= -p <pid>`), and `process_cmdline`.
     - Signals are sent to the verified process group (`-pid`) to avoid hitting recycled OS PIDs.
  2. **Heartbeat Expiry != Worker Death:** A worker agent or test suite may miss heartbeat updates during heavy compilation, long test runs, CPU starvation, or high reasoning model latency. Heartbeat expiry triggers a process liveness check, not automatic task cancellation or worktree deletion.
  3. **Prevention of Duplicate Execution:** Before dispatching an agent task, the scheduler verifies that no active process holds the task lease and checks file lock mutexes.
  4. **Uncertain Process State Handling:** If process ownership or completion is ambiguous (e.g. PID exists but command line shifted, or git index is locked), the orchestrator places the task in `Blocked` with reason `RECONCILIATION_REQUIRED` and alerts the owner. It does not guess or force cleanup.
  5. **Interrupted Git & Database Reconciliation:**
     - Checks for `index.lock` in the worktree. Probes whether the lock owner process is still alive. If verified dead, removes `index.lock`.
     - Compares the worktree HEAD against `task_runs.candidate_commit_sha`.
     - If uncommitted changes exist, preserves the entire worktree directory untouched.
  6. **Cleanup Eligibility:** A task worktree is eligible for deletion **only** when:
     - `tasks.status = 'Done'`.
     - The task candidate commit has been successfully merged into the feature branch via `git merge --ff-only`.
     - `git status --porcelain` is clean.
     - On any failure, cancellation, or interrupted recovery, the worktree is preserved on disk for owner review.

---

### Finding 2 (HIGH): Concrete Execution Boundary & Sandbox Realism
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 4
  - `docs/orchestrator/prd.md`: Section 4.5
- **Analysis & Defect:**
  Prior text claimed that path checks, command allowlists, environment variable scrubbing, and `npm --offline` constituted an "Execution Security Sandbox" that prevented code exfiltration. In reality, any child process running `npm test` or `python` on the host executes with full host user privileges and can read any file the user can access (`~/.ssh`, `~/.aws`, `~/.codex`).
- **Validated Architectural Resolution:**
  1. **Cooperative Runtime Boundary (Milestone 1 Workstation Default):**
     - Accurately labeled as a cooperative host boundary, not an impenetrable sandbox.
     - Enforces Node.js file tool confinement via `fs.realpathSync` (`assertPathWithinWorktree`).
     - Scrubs child environment variables of provider API keys and parent process tokens.
     - Enforces POSIX process-group creation via Node.js `detached: true` and process tree timeouts (`[PROPOSAL: 120s]` with `SIGKILL`).
     - Documents explicit limitations: untrusted code running as the host user could inspect user-readable host files.
  2. **Advanced Containerized Execution (Separate Proposal):**
     - For untrusted third-party repositories, specifies an isolated container tier (rootless Podman, Docker, or Linux namespaces via `bubblewrap`; on macOS, `sandbox-exec` profiles).
     - Mounts the host root read-only, task worktree read-write, and completely unmounts main `.git` metadata.
  3. **Gateway Connectivity:**
     - The orchestrator process makes all external and local LLM requests (`127.0.0.1:8787-8789`).
     - Child test runner processes run locally and do not require gateway access unless the repository under test is Claude-Zen itself.

---

### Finding 3 (HIGH): One Consistent Git, Verification, and Acceptance Lifecycle
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 6 & 7
  - `docs/orchestrator/prd.md`: Section 3, 4.7, 4.8
  - `docs/orchestrator/delivery-plan.md`: `TSK-M1-07`, `TSK-M1-08`, `TSK-M1-09`
- **Analysis & Defect:**
  The lifecycle sequence must account for untracked files, verification-generated artifacts, immutable acceptance, and fast-forward-only integration.
- **Validated Lifecycle Sequence:**
  ```
  Task Base (zen/<feature-slug> HEAD)
    │
    ▼
  Worktree Provisioned (.zen-worktrees/<task-id> on zen/task/<task-id>)
    │
    ▼
  Worker Implementation (edits inside scope_paths)
    │
    ▼
  Candidate Snapshot Created (git add <scope_paths> && git commit -> candidate_commit_sha)
    │
    ▼
  Automated Verification (test & lint commands run against candidate_commit_sha)
    ├─ If tracked files dirtied -> Verification FAILS immediately
    ├─ If exit != 0 -> Bounded repair loop (max 3)
    └─ If exit 0 -> verification_digest computed
    │
    ▼
  Specialist Code Review (Adversarial review over diff base_commit_sha..candidate_commit_sha)
    ├─ If files modified post-verification -> Prior review and checks INVALIDATED
    └─ If APPROVE -> Ready for QA
    │
    ▼
  Owner Acceptance (QA in UI approves existing candidate_commit_sha; no replacement commit)
    │
    ▼
  Fast-Forward Integration (git checkout zen/<feature-slug> && git merge --ff-only zen/task/<task-id>)
    ├─ If ff-only fails -> Blocked (INTEGRATION_CONFLICT); work preserved
    └─ If ff-only succeeds -> Task status = Done; worktree pruned
    │
    ▼
  Downstream DAG Tasks Unblock (blockedBy satisfied)
  ```
- **Key Invariants:**
  - **Candidate Snapshot:** Contains all intended task changes, including newly created files within `scope_paths`.
  - **Cleanliness Contract:** If verification modifies any tracked file outside `.gitignore`, verification fails with `E_VERIFICATION_DIRTIED_WORKING_TREE`.
  - **Unexpected Untracked Files:** Test suites must write caches to gitignored paths; unexpected untracked files outside `scope_paths` block candidate creation.
  - **Acceptance Invariance:** Acceptance approves the existing reviewed `candidate_commit_sha`. The orchestrator does not re-stage files or generate replacement commits upon acceptance.
  - **Fast-Forward Only:** Task integration into `zen/<feature-slug>` is strictly `git merge --ff-only`. If the feature branch moved out-of-band, integration fails, work is preserved, task enters `Blocked (INTEGRATION_CONFLICT)`, and downstream tasks remain blocked until rebased and re-verified.
  - **Separate Feature Merging:** Merging `zen/<feature-slug>` into `main` remains an explicit, owner-initiated step after all tasks are `Done`.

---

### Finding 4 (HIGH): State Model Normalization & Product Stage Preservation
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 5
  - `docs/orchestrator/prd.md`: Section 4.3
  - `docs/orchestrator/delivery-plan.md`: `TSK-M1-04`
- **Analysis & Defect:**
  Visible product stages (`Automated Checks`, `Code Review`, `QA`) must not be collapsed or eliminated for schema convenience. At the same time, transient run states, blocker reasons, and review verdicts must be decoupled.
- **Validated State Model:**
  1. **`tasks.status` (Visible Product Stages):**
     - `Backlog`: Prerequisite tasks in `blockedBy` are not yet `Done`.
     - `Ready`: Prerequisites met; ready for worktree provisioning.
     - `In Progress`: Active worker agent implementation in worktree.
     - `Automated Checks`: Non-LLM verifier executing test and lint suites.
     - `Code Review`: Independent specialist model evaluating candidate diff.
     - `QA`: Specialist approved; awaiting owner acceptance in browser UI.
     - `Done`: Accepted and fast-forward integrated into feature branch.
     - `Blocked`: Paused due to an explicit blocker reason; requires owner action.
     - `Cancelled`: Terminated by owner.
  2. **`task_runs.status` (Execution Attempt):**
     - `PENDING`, `RUNNING`, `VERIFYING`, `REVIEWING`, `COMPLETED`, `FAILED`, `ABORTED`.
  3. **`tasks.blocked_reason`:**
     - `NULL`, `REPAIR_LIMIT_EXCEEDED`, `BUDGET_EXCEEDED`, `RECONCILIATION_REQUIRED`, `INTEGRATION_CONFLICT`. Transient conditions such as reviewer/model unavailability are stored in `tasks.waiting_reason`; owner change requests return the task to `In Progress` without a blocker.
  4. **`review_records.verdict`:**
     - `APPROVE`, `CHANGES_REQUESTED`.
  5. **`acceptance_records`:**
     - Immutable audit record storing `task_id`, `candidate_commit_sha`, `accepted_by`, `accepted_at`, `integrated_commit_sha`, `integrated_at`.
  - **Specialist Review Rule:** If the specialist model is unavailable, the task remains in `Code Review` with `waiting_reason = 'SPECIALIST_UNAVAILABLE'`. Required review is never downgraded or bypassed.

---

### Finding 5 (MEDIUM): Harness Choice & Empirical Compatibility Spike
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 2
  - `docs/orchestrator/delivery-plan.md`: `TSK-M1-05`
  - `docs/orchestrator/decisions-and-open-questions.md`: Section 4, Question 2
- **Analysis & Defect:**
  The planning package must not claim "guaranteed stability" or "zero dependency risk" for custom loops, nor should it discard CLI integration based on theoretical fears. The choice must be decided empirically via a bounded experiment.
- **Validated Compatibility Spike Specification (`TSK-SPIKE-HARNESS-PARITY`):**
  1. **Offline & Zero Live Provider Requests:** Test against a local mock Anthropic server replaying recorded SSE fixtures (`test/anthropic-sse.test.mjs`), with no real credentials or network egress.
  2. **Audit Host Binary Options:** Inspect installed `claude` CLI version (2.1.231) flags: `--print`, `--output-format stream-json`, `--bare`, `--permission-mode dontAsk`, `--permission-prompts none`.
  3. **Complete Tool Cycle:** Exercise `tool_use` -> `tool execution` -> `tool_result` -> `final response` with real-time NDJSON stream parsing.
  4. **Verify Gateway Code with Mocked Upstream:** Route requests through actual local gateway adapters (`codex-gateway.mjs`, `antigravity-gateway.mjs`) with mocked provider responses to check header/schema forwarding.
  5. **Decision Rule:** A passing result makes Approach A viable. A failure is classified as a test/configuration defect or a reproducible CLI/gateway incompatibility. Only reproducible incompatibility blocks Approach A; the remaining approaches are then compared and recorded in an ADR.
  6. **Documented Limitation:** A mock experiment validates CLI options, NDJSON parsing, and gateway handshakes, but cannot simulate live upstream model nuances (e.g. live Gemini thinking stream chunking).

---

## 3. Recommended Decisions and Trade-Offs

| Decision | Recommendation | Trade-Off & Rationale |
| :--- | :--- | :--- |
| **Execution Boundary** | **Proposal B (Cooperative Trusted-Local Mode) for M1** | Immediate implementation with zero container setup friction on personal Macs/servers; acceptable for trusted repositories; explicit limitations documented. Proposal A (Containers) planned for untrusted code. |
| **Recovery Policy** | **Preserve Workspace on Disk; Reconcile Process Trees** | Eliminates accidental data loss on restart; requires disk management until owner reconciles or confirms discard. |
| **Git Integration** | **Fast-Forward Merge Only (`--ff-only`) for Tasks** | Guarantees that what was reviewed and approved is mathematically identical to the commit on the feature branch. Blocks integration if feature branch drifted. |
| **Harness Selection** | **Spike-Gated Selection** | Keeps options open until empirical evidence from `TSK-SPIKE-HARNESS-PARITY` establishes whether Approach A or Approach C should be coded. |
| **Model Allocation** | **Dynamic Role-to-Model Mapping** | Maximizes flexibility across OpenAI, Google, and OpenCode accounts while avoiding vendor lock-in. |

---

## 4. Bounded Compatibility-Spike Task (`TSK-SPIKE-HARNESS-PARITY`)

- **Task Identifier:** `TSK-M1-05` (scheduled prior to worker engine implementation in `TSK-M1-06`).
- **Goal:** Validate headless Claude Code CLI invocability, NDJSON streaming, and local gateway protocol handshake in an offline test.
- **Execution Rules:**
  - 100% offline; zero outbound internet requests.
  - Zero live provider credentials used.
- **Pass Criteria:**
  - Subprocess `claude -p --bare --output-format stream-json --permission-mode dontAsk` completes the mock tool cycle and exits `0`.
  - NDJSON stdout stream parses cleanly into typed events (`system/init`, `stream_event`, `assistant`, `result`).
- **Fail Criteria:**
  - CLI hangs waiting for TTY input despite `--permission-prompts none`.
  - CLI crashes on non-Anthropic gateway headers.
  - Protocol parsing fails or emits unstructured output.

---

## 5. Implementation-Readiness Verdict

**PARTIAL PASS — READY FOR FOUNDATION IMPLEMENTATION**

The database, state-contract, and non-destructive workspace foundation may begin with `TSK-M1-01`. Worker-engine implementation remains gated by `TSK-M1-05` evidence and an ADR. UI implementation remains gated by the owner’s frontend choice. Numerical limits and the Milestone 1 execution tier remain explicit owner decisions.
