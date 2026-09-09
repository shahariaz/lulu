# Revision 02 Traceability Report: Architecture Contracts Resolution (DOC-REV-02)

**Document Status:** Complete  
**Date:** 2026-09-09  
**Review Target:** Phase 0 Planning Package (`docs/orchestrator/`)  

---

## 1. Finding → Changed File / Section → Resolution Traceability Matrix

| Area & Finding | Changed File & Section | Concrete Resolution |
| :--- | :--- | :--- |
| **1. Non-Destructive Recovery**<br>Forced worktree deletion destroyed uncommitted work; emergency Git commit alone is not a full disk backup; process liveness unverified. | - `docs/orchestrator/architecture-proposal.md` (§7, §11)<br>- `docs/orchestrator/prd.md` (§4.1, §5.3)<br>- `docs/orchestrator/delivery-plan.md` (`TSK-M1-01`, `TSK-M1-02`)<br>- `docs/orchestrator/architecture-review.md` (§2 Finding 1) | **Resolved:**<br>1. Completely removed automatic forced worktree deletion from recovery, cancellation, and failure paths.<br>2. Mandated preserving the entire workspace directory on disk, including tracked, untracked, and ignored files.<br>3. Specified worker process verification (PID + start time + command line) before sending OS signals to verified process groups (`setpgid`).<br>4. Defined that heartbeat expiry triggers a process inquiry, not process termination or task reset (compilation, slow tests, or high reasoning latency may delay heartbeats).<br>5. Implemented active lease locks to prevent duplicate execution during reconciliation.<br>6. Specified that uncertain process states or locked git indexes trigger a hold in `Blocked` with reason `RECONCILIATION_REQUIRED`.<br>7. Defined worktree cleanup eligibility: ONLY when task is `Done`, cleanly integrated via fast-forward merge, and git status is clean. |
| **2. Actual Execution Boundary**<br>Path checks, cwd, and environment scrubbing alone were mislabeled as an "Execution Security Sandbox." | - `docs/orchestrator/architecture-proposal.md` (§4.2)<br>- `docs/orchestrator/prd.md` (§4.5)<br>- `docs/orchestrator/decisions-and-open-questions.md` (§1 `DEC-03`, §3 #3, §4 #3)<br>- `docs/orchestrator/architecture-review.md` (§2 Finding 2) | **Resolved:**<br>1. Reframed execution boundary accurately as a **Cooperative Runtime Boundary (Defense-in-Depth)** for Milestone 1 workstation use, removing claims of an impenetrable sandbox.<br>2. Documented explicit limitations: allowlisted binaries (`npm`, `python`, `cargo`) execute with host user privileges on the host OS.<br>3. Defined Proposal A (Containerized/OS-isolated Worker using rootless Podman/Docker or macOS sandbox) as an advanced separate security proposal.<br>4. Formulated concrete workstation protections for Proposal B: Node.js realpath worktree confinement, environment credential scrubbing, process tree timeouts (`[PROPOSAL: 120s]` with `SIGKILL`), and command allowlists.<br>5. Clarified network policy: orchestrator talks to local gateways (`127.0.0.1:8787-8789`); test runners execute offline (`npm test --offline`) where supported. |
| **3. One Git, Verification & Acceptance Lifecycle**<br>Lifecycle sequence was inconsistent; test artifacts could dirty git status; non-fast-forward merges risked altering reviewed code. | - `docs/orchestrator/architecture-proposal.md` (§6, §7)<br>- `docs/orchestrator/prd.md` (§3, §4.6, §4.7, §4.8)<br>- `docs/orchestrator/delivery-plan.md` (`TSK-M1-06`, `TSK-M1-07`, `TSK-M1-08`, `TSK-M1-09`)<br>- `docs/orchestrator/architecture-review.md` (§2 Finding 3) | **Resolved:**<br>1. Codified one unified, consistent lifecycle across all documents:<br>`Task base → candidate snapshot → automated verification → specialist review → owner acceptance → fast-forward integration into feature branch → Done`.<br>2. Candidate snapshots stage all intended changes, including intended new files within `scope_paths`.<br>3. Verification evaluates candidate commit with recorded toolchain environment metadata (OS, runtime version, git commit).<br>4. Established strict cleanliness rule: any tracked-file alteration during verification fails with `E_VERIFICATION_DIRTIED_WORKING_TREE`.<br>5. Defined treatment of untracked files: test caches must write to gitignored paths; unexpected untracked files block candidate creation.<br>6. Acceptance approves the existing reviewed `candidate_commit_sha` without re-staging mutable files or creating replacement commits.<br>7. Task integration into `zen/<feature-slug>` is strictly `git merge --ff-only`. If fast-forward fails, work is preserved, task blocks on `INTEGRATION_CONFLICT`, and downstream tasks remain blocked.<br>8. Downstream tasks unblock only when prerequisite reaches `Done` (cleanly integrated).<br>9. Merging the feature into `main` remains an explicit, separate owner action. |
| **4. State Model Normalization & Product Stages**<br>State model conflated task status, run status, waiting reasons, and review verdicts; earlier drafts threatened to collapse visible product stages. | - `docs/orchestrator/architecture-proposal.md` (§5, §10.2)<br>- `docs/orchestrator/prd.md` (§4.3, §4.4, §4.7)<br>- `docs/orchestrator/delivery-plan.md` (`TSK-M1-04`)<br>- `docs/orchestrator/architecture-review.md` (§2 Finding 4) | **Resolved:**<br>1. Preserved visible product stages in `tasks.status`: `Backlog`, `Ready`, `In Progress`, `Automated Checks`, `Code Review`, `QA`, `Done`, `Blocked`, `Cancelled`.<br>2. Separated orthogonal execution concerns into normalized schema fields:<br>- `task_runs.status`: `PENDING`, `RUNNING`, `VERIFYING`, `REVIEWING`, `COMPLETED`, `FAILED`, `ABORTED`.<br>- `tasks.blocked_reason`: `NULL`, `DEPENDENCIES_UNMET`, `REPAIR_LIMIT_EXCEEDED`, `SPECIALIST_UNAVAILABLE`, `BUDGET_EXCEEDED`, `RECONCILIATION_REQUIRED`, `INTEGRATION_CONFLICT`, `OWNER_CHANGES_REQUESTED`.<br>- `review_records.verdict`: `APPROVE`, `CHANGES_REQUESTED`.<br>- `acceptance_records`: immutable audit log of acceptance and integration.<br>3. Defined rule: required specialist review must remain in `Code Review` with `blocked_reason = 'SPECIALIST_UNAVAILABLE'` when allowed models are unavailable; never bypassed or downgraded. |
| **5. Empirical Compatibility Spike**<br>Harness selection assumed unverified stability or custom loop superiority without evidence. | - `docs/orchestrator/architecture-proposal.md` (§2.4)<br>- `docs/orchestrator/delivery-plan.md` (`TSK-M1-05`)<br>- `docs/orchestrator/decisions-and-open-questions.md` (§4 Question 2)<br>- `docs/orchestrator/architecture-review.md` (§2 Finding 5, §4) | **Resolved:**<br>1. Kept execution-engine selection open and removed unsubstantiated claims ("guaranteed stability", "zero dependency risk").<br>2. Designed a bounded, 100% offline compatibility spike (`TSK-SPIKE-HARNESS-PARITY` scheduled as `TSK-M1-05` before worker implementation `TSK-M1-06`).<br>3. Spike tests: installed `claude` CLI (v2.1.231) options, mock Anthropic SSE server, full `tool_use` -> `tool_result` cycle with NDJSON streaming, and local gateway protocol forwarding with mocked upstream.<br>4. Clear decision rule: if PASS -> Approach A (Headless CLI); if FAIL -> Approach C (Custom Loop).<br>5. Explicitly documented what mocked tests cannot establish about live-provider behavior. |
| **6. Delivery Plan Consistency & Token Governance**<br>Task sequencing had worker engine before spike; token budgets were presented as exact ceilings rather than post-turn thresholds. | - `docs/orchestrator/delivery-plan.md` (§2.1, §2.2)<br>- `docs/orchestrator/architecture-proposal.md` (§9)<br>- `docs/orchestrator/prd.md` (§5.1)<br>- `docs/orchestrator/decisions-and-open-questions.md` (§4 Question 4) | **Resolved:**<br>1. Resequenced Milestone 1 tasks into 10 explicit steps, placing `TSK-M1-05` (Spike) strictly before `TSK-M1-06` (Worker Harness).<br>2. Removed unsupported model defaults and stale claims that corrections were complete.<br>3. Marked all numerical limits as `[PROPOSAL: ...]`.<br>4. Explicitly distinguished observed usage (API metrics) from estimated usage (character heuristics), and documented limits that cannot be enforced exactly in real-time streaming. |

---

## 2. Remaining Decisions, Recommendations, and Milestone Impact

Before implementing Milestone 1 code, the following decisions remain for owner sign-off:

### Decision 1: Frontend Architecture (`TSK-M1-09`)
- **Question:** Build a modern lightweight SPA (Vite + Preact/React) served statically on port 8789, or continue expanding the monolithic 2,822-line vanilla template in `lib/ui.mjs`?
- **Recommendation:** **Option A (Vite + Preact/React SPA).** Component-based architecture is essential for interactive syntax-highlighted diff viewers, markdown specification editing, and live SSE event boards.
- **Milestone Impact:** Determines tooling and dependencies for task `TSK-M1-09`.

### Decision 2: Worker Harness Integration Strategy (`TSK-M1-05` / `TSK-M1-06`)
- **Question:** How should the orchestrator execute the Worker Agent?
- **Recommendation:** **Option A (Spike-First).** Execute `TSK-SPIKE-HARNESS-PARITY` offline against mock fixtures. If the installed CLI (`2.1.231`) successfully completes NDJSON tool streaming against local gateways, adopt Approach A (Headless CLI); if it fails on headers or flags, adopt Approach C (Custom Loop).
- **Milestone Impact:** Eliminates architectural speculation and governs `TSK-M1-06` implementation.

### Decision 3: Execution Security Tier for Milestone 1 (`TSK-M1-06`)
- **Question:** Which execution security tier should be implemented for Milestone 1?
- **Recommendation:** **Option A (Proposal B: Cooperative Trusted-Local Mode).** Realpath worktree confinement, environment credential scrubbing, process tree timeouts (`setpgid`), and command allowlists. Avoids container setup friction on personal workstations while documenting host user limitations.
- **Milestone Impact:** Adopting Proposal A (Containers) would add Docker/Podman container daemon dependencies to `TSK-M1-06` and `TSK-M1-07`.

### Decision 4: Calibration of Proposed Numerical Limits
- **Question:** Confirm proposed numerical thresholds:
  - Feature budget: `500,000 tokens`.
  - Task budget: `150,000 tokens`.
  - Specialist reviewer budget: `80,000 tokens`.
  - Maximum repair attempts: `3 attempts`.
  - Command timeout: `120 seconds`.
  - Inactive lease timeout: `5 minutes`.
- **Recommendation:** **Accept proposed defaults.** They provide safe initial guardrails against runaway agent loops.
- **Milestone Impact:** Configured in `TSK-M1-01`, `TSK-M1-04`, `TSK-M1-06`, and `TSK-M1-07`.

---

## 3. Proposed First Executable Task and Acceptance Criteria

Upon plan sign-off, the first executable task to implement is:

### `TSK-M1-01`: Versioned Database Migrations & Non-Destructive Recovery Engine
- **Source Paths:**
  - `lib/orchestrator/db/migration-runner.mjs`
  - `lib/orchestrator/db/migrations/001_initial_schema.sql`
  - `lib/orchestrator/db/recovery-manager.mjs`
  - `test/orchestrator-db.test.mjs`
- **Scope:**
  1. Implement Node.js native `DatabaseSync` migration runner with `schema_migrations` table at `~/.zen-claude/zen-orchestrator.sqlite`.
  2. Execute migration `001_initial_schema.sql` defining normalized tables: `projects`, `requirements_baselines`, `milestones`, `tasks`, `task_runs`, `verification_results`, `review_records`, `acceptance_records`, `audit_logs`.
  3. Implement non-destructive recovery logic:
     - Verify process identity (PID, start time, cmdline) before sending OS signals.
     - Heartbeat expiry alone never triggers worktree deletion.
     - Interrupted or orphaned worktrees are preserved on disk and recorded as `Blocked` with reason `RECONCILIATION_REQUIRED`.
     - Stale `index.lock` files are cleared only after verifying that the owning process is dead.
- **Acceptance Criteria:**
  - `node --test test/orchestrator-db.test.mjs` passes with 100% test coverage for migration idempotency, foreign key integrity, and recovery sweeps.
  - Recovery sweep preserves dirty worktree directories untouched on disk and sets task status to `Blocked`.

---

## 4. Remaining Blockers

1. **Owner Sign-Off on Blocking Decisions:** Owner confirmation of Decisions 1–4 above is required before writing application code.
2. **Empirical Spike Execution (`TSK-M1-05`):** Worker harness code (`TSK-M1-06`) remains blocked until the offline compatibility spike runs and outputs an empirical PASS/FAIL determination.

---

## 5. Checks Actually Performed

To ground this revision strictly in reality, the following checks were executed in the local environment:

1. **Installed Toolchain Verification:**
   - Executed `claude --version`: confirmed installed binary is `2.1.231 (Claude Code)`.
   - Executed `git --version`: confirmed installed binary is `git version 2.55.0`.
   - Executed `node --version`: confirmed runtime is `v24.19.0`.
2. **CLI Invocation Options Inspection:**
   - Executed `claude --help`: verified exact supported flags in v2.1.231, including `-p/--print`, `--output-format (text|json|stream-json)`, `--input-format (text|stream-json)`, `--include-partial-messages`, `--bare`, `--permission-mode (acceptEdits|auto|bypassPermissions|manual|dontAsk|plan)`, `--permission-prompts none`, `--allowedTools`, `--disallowedTools`, `--tools`, `--worktree`, and `--settings`.
3. **Repository Working Copy & Code Integrity Verification:**
   - Verified that no application code in `bin/`, `lib/`, `test/`, or root scripts was altered.
   - Verified that `git status` reflects only documentation files in `docs/orchestrator/`.
   - Verified zero live provider calls or credential reads were performed.
4. **Cross-Document Consistency Audit:**
   - Audited all 7 documents in `docs/orchestrator/` to ensure identical lifecycle sequences (`Task base → candidate snapshot → automated verification → specialist review → owner acceptance → fast-forward integration into feature branch → Done`), normalized state names, preserved product stages, and consistent task IDs (`TSK-M1-01` to `TSK-M1-10`).
