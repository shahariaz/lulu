# Architecture Review: Claude-Zen Self-Hosted AI Software Delivery Platform

**Review Date:** 2026-09-09  
**Reviewer Role:** Architecture Reviewer  
**Review Target:** Phase 0 Planning Package (`docs/orchestrator/`) and Existing Gateway Codebase  
**Status:** Evaluation Complete — Actionable Findings & Corrections Defined  

---

## 1. Executive Summary & Review Verdict

### Implementation Readiness Verdict: **CONDITIONAL PASS — BLOCKED ON 3 SPECIFICATION AMENDMENTS**

The Phase 0 planning package establishes a strong, disciplined foundation for evolving Claude-Zen from a proxy gateway into an autonomous delivery platform. The separation of ordinary orchestration code from probabilistic agent models, the introduction of git worktree isolation in Milestone 1, and the decoupling of task acceptance from git committing are well-conceived.

However, application code implementation **must not begin** until three critical architectural flaws are corrected in the documentation:

1. **Destructive Recovery:** The proposed crash recovery logic automatically deletes unmapped worktrees with `git worktree remove --force`, which will destroy uncommitted developer and agent work after an ungraceful host restart.
2. **Illusory Sandbox Claims:** The documentation misrepresents basic path checking, command allowlisting, and environment variable scrubbing as an "Execution Security Sandbox." On a single-user workstation without containerization or OS sandboxing, allowlisted binaries (`npm`, `python`, `cargo`) run with full host user privileges.
3. **Conflated State Model:** Task lifecycle status, run status, waiting/blocker reasons, and review verdicts are conflated into a single overloaded state enum across the PRD, architecture proposal, and database schema.

Once these three items are corrected and the bounded compatibility spike defined in Section 5 is scheduled, Milestone 1 implementation is ready to proceed.

---

## 2. Findings Ordered by Severity

### Finding 1 (CRITICAL): Destructive Automatic Cleanup in Crash Recovery Destroys Unfinished Work
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 11.1 & 11.2 (lines 389–403)
  - `docs/orchestrator/delivery-plan.md`: `TSK-M1-01` Scope (lines 53–62)
- **Defect:**
  The proposal mandates that upon restart, the recovery manager:
  > *"queries `tasks` where status IN ('In Progress', 'Automated Checks', 'Code Review'). If heartbeat is stale (> 5 minutes), marks the run as INTERRUPTED, cleans up the task worktree (`git worktree remove --force`), and resets the task to Ready... Scans `.zen-worktrees/` for any directories not mapped to an active In Progress task in SQLite, running `git worktree remove --force` and `git worktree prune`."*
- **Impact:**
  This is catastrophic data loss. If the host machine reboots, loses power, or the orchestrator process crashes while a worker is editing files, all uncommitted code, partial edits, and scratchpad files inside the worktree are **permanently deleted**. Furthermore, if an external worker process is still alive and writing, running `git worktree remove --force` will corrupt file handles or fail with OS lock errors.
- **Correction Required:**
  - **Remove all automatic destructive cleanup of dirty worktrees.**
  - If a lease expires or orchestrator reboots:
    1. Terminate orphaned worker process groups gracefully (`SIGTERM` -> 5s -> `SIGKILL`).
    2. Check git status of the worktree (`git status --porcelain`).
    3. If dirty: create an emergency recovery commit on `refs/zen/recovery/<task-id>-<timestamp>` to preserve the exact disk state.
    4. Transition the task to `Blocked (Interrupted / Recovery Required)` and alert the owner in the UI. Never delete uncommitted work without explicit owner confirmation.
    5. Only clean up worktrees that are clean (`git status` empty) and whose changes are verified merged.

---

### Finding 2 (HIGH): Execution Boundary Misrepresented as a Security Sandbox
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 4.2 (lines 182–191)
  - `docs/orchestrator/prd.md`: Section 4.5 (`REQ-F-SEC-01` to `REQ-F-SEC-04`)
- **Defect:**
  The documents describe working directory path checking (`assertPathWithinWorktree`), environment variable scrubbing, and command runner allowlisting as an "Execution Security Sandbox," claiming:
  > *"Worker processes run with loopback-only environment bindings, preventing rogue scripts from exfiltrating code to external servers."*
- **Technical Reality:**
  - `assertPathWithinWorktree` only validates paths passed into the orchestrator's Node.js file tools. The moment the agent runs an allowlisted command (e.g. `npm test`, `pytest`, `cargo test`, `npm install`), the child process executes arbitrary code on the host OS as the host user.
  - An allowlisted tool like `python` or `npm` can read `~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.codex/auth.json`, and `/etc/passwd`, write to `/tmp`, spawn sub-daemons, or open raw TCP sockets.
  - Environment variable filtering (`process.env`) does not prevent child processes from reading credentials stored in host dotfiles.
  - "Loopback-only environment bindings" cannot block outbound socket connections from a compiled binary or node process without root-level OS firewall rules (`pf` on macOS, `iptables`/`nftables` on Linux).
- **Correction Required:**
  - Honestly label the execution boundary as a **Cooperative Runtime Boundary (Defense-in-Depth)**, not an adversarial security sandbox.
  - Specify concrete, proportionate protections for a single-user workstation:
    1. Run worker child processes with a non-zero process timeout (`[PROPOSAL: 120s]`) killing the entire process tree on expiration.
    2. Confine Node.js file tools to the worktree root.
    3. On macOS, evaluate optional `sandbox-exec` profiles or dedicated non-root user accounts for local server deployments; on Linux, evaluate `bubblewrap` (`bwrap`).
    4. For network access: the **orchestrator** connects to local gateways (`127.0.0.1:8787-8789`); the worker child processes executing tests must run in offline mode (`npm test --offline` or test runner equivalent) unless the project explicitly defines external network dependencies.

---

### Finding 3 (HIGH): State Model Conflates Task Status, Run Status, Waiting Reasons, and Review Verdicts
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 5 & Section 10.2 (lines 194–235, 360–380)
  - `docs/orchestrator/prd.md`: Section 4.3 & 4.7
  - `docs/orchestrator/delivery-plan.md`: `TSK-M1-04`
- **Defect:**
  The proposal forces orthogonal state domains into a single overloaded 9-state enum (`Backlog`, `Ready`, `In Progress`, `Automated Checks`, `Code Review`, `QA`, `Done`, `Blocked`, `Cancelled`):
  - In `architecture-proposal.md:214`, `Automated Checks` and `Code Review` and `QA` are listed as task states, but in `prd.md`, owner approval is called `Accept Task` and specialist review is called `Code Review`.
  - In `architecture-proposal.md:162`, the text references transient waiting conditions like `Code Review (Pending Specialist)` and `Blocked (Budget Exhausted)` as if they were states, yet they do not exist in the 9-state schema definition.
  - A task may undergo multiple worker runs and repair attempts, but there is no clean separation between the status of the overall task work-item and the status of an individual execution run.
- **Correction Required:**
  - Decouple the state model into four distinct, normalized fields in the database schema:
    1. **`tasks.status` (Work-Item Lifecycle):** `BACKLOG` | `READY` | `IN_PROGRESS` | `IN_REVIEW` | `DONE` | `BLOCKED` | `CANCELLED`.
    2. **`task_runs.status` (Execution Run Lifecycle):** `QUEUED` | `RUNNING` | `VERIFYING` | `REVIEWING` | `SUCCEEDED` | `FAILED` | `ABORTED`.
    3. **`tasks.blocked_reason` (Waiting / Blocked Reason):** `NULL` | `DEPENDENCIES_UNMET` | `REPAIR_LIMIT_EXCEEDED` | `SPECIALIST_UNAVAILABLE` | `BUDGET_EXCEEDED` | `CRASH_INTERRUPTED` | `AWAITING_OWNER_ACTION`.
    4. **`review_records.verdict` (Review Evaluation):** `APPROVE` | `CHANGES_REQUESTED`.
  - **Dependency Unblocking Rule:** Downstream tasks in `BACKLOG` transition to `READY` if and only if every task ID listed in `blocked_by` has `tasks.status = 'DONE'`.

---

### Finding 4 (MEDIUM): Git Review Lifecycle Lacks Protection Against Verification Artifacts and Non-Fast-Forward Invalidation
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 6 & 7 (lines 240–280)
  - `docs/orchestrator/prd.md`: Section 4.7 & 4.8
- **Defect:**
  1. **Verification-Generated Artifacts:** When automated tests run (`npm test`, `pytest`, `cargo test`), compilers and test runners frequently generate untracked or modified files (e.g. `.nyc_output/`, `coverage/`, `dist/`, `.pytest_cache/`, build logs). If these files dirty the worktree after the candidate commit is made, the proposed "invalidation on any file change" rule will cause an infinite loop: tests run -> tests generate `.cache` -> invalidation fires -> tests run again.
  2. **Non-Fast-Forward Feature Merging:** If the candidate commit on `zen/task/<task-id>` is rebased or squash-merged into `zen/<feature-slug>` with conflicts or code shifts, the resulting commit tree SHA differs from the `candidate_commit_sha` reviewed by the specialist and owner.
- **Correction Required:**
  - **Artifact Cleanliness Contract:**
    - Candidate commits stage **only** files matching `scope_paths`.
    - Automated tests must run with outputs directed to ignored directories or temporary paths. If verification modifies any file tracked in git outside `.gitignore`, the verification **fails** with `E_VERIFICATION_DIRTIED_WORKING_TREE`.
  - **Integration Integrity Contract:**
    - In Milestone 1 (sequential execution), integrating an accepted task into `zen/<feature-slug>` must be strictly **fast-forward only**:
      ```bash
      git checkout zen/<feature-slug>
      git merge --ff-only zen/task/<task-id>
      ```
    - Because it is a fast-forward merge, the commit SHA and tree SHA on `zen/<feature-slug>` are guaranteed to be **identical** to the reviewed `candidate_commit_sha`.
    - If a fast-forward merge fails (indicating the owner modified the feature branch out-of-band), integration is blocked, and the task must be rebased and re-verified.

---

### Finding 5 (MEDIUM): Harness Selection Assumes Unverified Parity Without Empirical Handshake Verification
- **Document References:**
  - `docs/orchestrator/architecture-proposal.md`: Section 2 (lines 20–97)
  - `docs/orchestrator/decisions-and-open-questions.md`: Section 4, Question 2
- **Defect:**
  The proposal correctly flags `[UNVERIFIED: Gateway Parity]` for running the headless Claude Code CLI (`claude -p --output-format stream-json --bare`) against local proxies (`http://127.0.0.1:8787-8789`). However, it leaves this as an open question without defining an empirical test to settle it.
  Existing code evidence shows that Claude Code sends dynamic tool schemas and protocol quirks that already required custom handling in `zen-proxy.mjs:311` (`Claude Code sends server-side tool stubs with no schema; skip those`). If the CLI sends unexpected beta headers or payload configurations that the local gateways reject, Approach A will fail completely in production.
- **Correction Required:**
  Implement a bounded, offline compatibility spike (detailed in Section 4 below) as a gating task before implementing the worker harness.

---

## 3. Recommended Decisions and Trade-offs

| Decision Topic | Recommended Decision | Rationale & Trade-offs |
| :--- | :--- | :--- |
| **Execution Boundary** | **Cooperative Process Boundary + Process Tree Timeout** | True OS virtualization (Docker / VM) adds prohibitive setup overhead for a single-user tool. Cooperative path confinement in Node.js + credential stripping + process tree timeouts (`SIGKILL`) provides strong, practical defense against accidental damage on local workstations. |
| **Recovery Strategy** | **Non-Destructive Emergency Checkpointing** | Never delete uncommitted work. If a lease expires, checkpoint the worktree to `refs/zen/recovery/<task-id>-<ts>` and transition the task to `Blocked`. The owner can inspect or resume via UI. Trade-off: Requires disk space until owner confirms discard. |
| **Git Integration** | **Fast-Forward Merge Only for Task Integration** | Ensures the git commit SHA on the feature branch is mathematically identical to the SHA evaluated by the specialist reviewer and owner. Trade-off: Disallows out-of-band commits to the feature branch while a task is in progress. |
| **Harness Strategy** | **Approach C (Custom In-Process Loop) as Baseline, Approach A (CLI) Opt-In Post-Spike** | Approach C guarantees zero external binary dependency risk, native multi-port routing (`:8787` vs `:8788`), and total control over HTTP payloads. If the compatibility spike passes, Approach A can be offered as an optional engine. |
| **State Normalization**| **Separate Task Status from Run Status & Blockers** | Decoupling `task.status` from `task_run.status` and `blocked_reason` prevents enum explosion, eliminates state machine ambiguities, and accurately models multi-run repair loops. |

---

## 4. Exact Document Corrections Required

The following specific amendments must be made to the Phase 0 planning package:

### 1. `docs/orchestrator/architecture-proposal.md`
- **Section 4.2:** Change heading from "Execution Security & Sandboxing Policies" to "Cooperative Runtime Execution Boundary." Replace claims of "preventing rogue scripts from exfiltrating code" with clear documentation that host child processes run with host user privileges and require command allowlisting and process tree timeouts.
- **Section 5.1:** Update the state machine diagram and transition table to use normalized statuses: `tasks.status` (`BACKLOG`, `READY`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`, `BLOCKED`, `CANCELLED`), `task_runs.status`, and explicit `blocked_reason` values.
- **Section 6.1:** Add the rule that verification execution must not modify git-tracked files outside `.gitignore`.
- **Section 7:** Specify that integrating task commits into `zen/<feature-slug>` is strictly `git merge --ff-only`.
- **Section 11.1 & 11.2:** Remove `git worktree remove --force` from the recovery routine. Add the emergency checkpointing routine (`refs/zen/recovery/...`) and task transition to `Blocked (Interrupted)`.

### 2. `docs/orchestrator/prd.md`
- **Section 4.5:** Update `REQ-F-SEC-01` through `REQ-F-SEC-04` to reflect cooperative process isolation, credential scrubbing, and process timeouts rather than an impenetrable sandbox.
- **Section 4.7:** Add `REQ-F-REV-04` mandating that verification-generated changes to tracked files invalidate the candidate commit.
- **Section 4.8:** Update `REQ-F-GOV-01` and `REQ-F-GOV-04` to specify fast-forward integration for task commits.
- **Section 5.3:** Update `REQ-NF-REL-02` to require non-destructive recovery of interrupted worktrees.

### 3. `docs/orchestrator/delivery-plan.md`
- **Section 2.2 (`TSK-M1-01`):** Remove destructive worktree pruning from recovery scope. Add non-destructive checkpointing to `refs/zen/recovery/`.
- **Section 2.2 (`TSK-M1-05`):** Insert the Bounded Compatibility Spike as a preliminary milestone task (`TSK-M1-04B` or subtask of `TSK-M1-05`).

### 4. `docs/orchestrator/decisions-and-open-questions.md`
- **Section 1 (`DEC-03`):** Clarify that process execution security is a cooperative host boundary with timeouts and path confinement, not a hypervisor/container sandbox.
- **Section 1 (`DEC-09`):** Explicitly document that recovery is non-destructive.

---

## 5. Bounded Compatibility-Spike Task Specification

To resolve the harness selection question without making live provider requests or incurring token costs, execute this bounded compatibility spike prior to building `TSK-M1-05`:

### Spike Task: `TSK-SPIKE-HARNESS-PARITY`
- **Goal:** Verify whether headless Claude Code CLI (`claude -p --output-format stream-json --bare`) can communicate with local proxy gateways (`http://127.0.0.1:8787-8789`) without rejecting headers, stalling, or throwing protocol errors.
- **Test Design (Zero Live Provider Calls):**
  1. **Mock Gateway Server:** Spin up a temporary local HTTP server on `127.0.0.1:9876` that implements the Anthropic `/v1/messages` endpoint using recorded fixture responses from `test/anthropic-sse.test.mjs`.
  2. **Subprocess Invocation:** Spawn `claude` with:
     ```bash
     ANTHROPIC_BASE_URL="http://127.0.0.1:9876" \
     ANTHROPIC_API_KEY="test-mock-key" \
     claude -p "Return test" \
       --bare \
       --output-format stream-json \
       --tools "Read,Edit" \
       --permission-mode dontAsk \
       --permission-prompts none
     ```
  3. **Inspect Handshake:**
     - The mock server logs request headers (`anthropic-version`, `anthropic-beta`) and request payload (`system`, `tools`, `messages`).
     - The mock server responds with a valid chunked SSE stream containing a mock `tool_use` event, followed by a text response.
  4. **Inspect Client Output:**
     - Verify that `claude` outputs valid NDJSON on stdout (`system/init`, `stream_event`, `result`).
     - Verify that `claude` exits cleanly with status code `0`.
- **Pass Criteria:**
  - `claude` connects to `127.0.0.1:9876`, parses the mock SSE stream, emits structured NDJSON on stdout, and exits `0`.
  - No unsupported beta header crashes, no TTY prompt hangs, and no unhandled exceptions.
- **Fail Criteria:**
  - `claude` hangs waiting for TTY input despite `--permission-prompts none`.
  - `claude` crashes due to missing proprietary Anthropic headers or endpoint validation.
  - Parsing stdout fails or yields unstructured text.
- **Fallback on Failure:**
  - Immediately adopt **Approach C (Pure Custom Node.js Agent Loop)** for the worker harness, which has zero external binary dependency risk.

---

## 6. Implementation Readiness Summary

| Evaluation Area | Current Status | Required Action Prior to Coding |
| :--- | :--- | :--- |
| **1. Execution Boundary** | Defect Identified (Illusory sandbox claims) | Update docs to reflect cooperative boundary, command allowlisting, process tree timeouts, and test network policy. |
| **2. Recovery & Cancellation** | Defect Identified (Destructive worktree cleanup) | Replace destructive cleanup with emergency checkpointing (`refs/zen/recovery/`) and non-destructive `Blocked` task holding. |
| **3. Git & Review Lifecycle** | Needs Clarification | Codify artifact cleanliness rule (tests must not dirty git files) and strict fast-forward integration rule (`git merge --ff-only`). |
| **4. State Model** | Inconsistent across docs | Normalize into 4 distinct fields: `task.status`, `task_run.status`, `blocked_reason`, and `review.verdict`. |
| **5. Harness Choice** | Pending Verification | Execute `TSK-SPIKE-HARNESS-PARITY` against an offline mock server to empirically select Approach A or Approach C. |

**Final Recommendation:** Approve Phase 0 planning package subject to the document corrections listed in Section 4. Once updated, proceed directly to `TSK-M1-01` (Versioned Database Migrations).
