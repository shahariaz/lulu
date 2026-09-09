# Claude-Zen Orchestrator: Phase 0 Planning Package

**Document Status:** Revision 2 — Settled Architecture Contracts & Implementation Baseline  
**Date:** 2026-09-09  
**Target System:** Claude-Zen Self-Hosted AI Software Delivery Application  
**Operating Context:** Self-hosted workstation or personal server (macOS / Linux)  

---

## 1. Executive Summary

Claude-Zen is evolving from a multi-provider proxy and account-pooling gateway for the Claude Code CLI into an autonomous, self-hosted AI software delivery application with a polished browser UI.

This Phase 0 planning package establishes the product requirements, technical architecture, delivery roadmap, and architecture review. Revision 2 resolves and settles all architecture contracts:

1. **Non-Destructive Recovery:** Automatic forced worktree deletion is eliminated from all recovery, cancellation, and failure paths. The actual workspace—including tracked, untracked, and ignored files—is preserved on disk. Crash recovery relies on verified process ownership (PID, start time, command line) and handles lease inquiries without destructive side effects.
2. **Realistic Execution Boundaries:** The execution boundary is honestly characterized as a **Cooperative Runtime Boundary (Defense-in-Depth)** for Milestone 1 workstation use, with explicit limitations documented. An advanced containerized/OS-isolated tier is specified as a distinct proposal.
3. **Watertight Git Lifecycle:** One consistent lifecycle sequence is established: `Task base → candidate snapshot → automated verification → specialist review → owner acceptance → fast-forward integration into feature branch → Done`. Candidate commits stage intended changes immutably; tracked-file modifications during verification invalidate results; task integration is strictly fast-forward only (`git merge --ff-only`).
4. **Preserved Product Stages & Normalized State Model:** Visible product stages (`Backlog`, `Ready`, `In Progress`, `Automated Checks`, `Code Review`, `QA`, `Done`, `Blocked`, `Cancelled`) are fully preserved in `tasks.status`. Orthogonal concerns (`task_runs.status`, `tasks.blocked_reason`, `review_records.verdict`, and `acceptance_records`) are separated into distinct schema fields.
5. **Empirical Compatibility Spike:** Execution engine selection remains open. An offline experiment (`TSK-SPIKE-HARNESS-PARITY`) is scheduled before worker harness implementation to empirically evaluate CLI vs. in-process execution without making live provider requests.

---

## 2. Document Reading Order

Review the planning package in the following sequence:

```
┌────────────────────────────────────────────────────────┐
│ 1. docs/orchestrator/README.md (This File)            │
│    Roadmap, deliverable index, and revision summary    │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 2. docs/orchestrator/repository-assessment.md          │
│    Code audit: current gateways, accurate routing     │
│    analysis, reusable assets, gaps, and evidence       │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 3. docs/orchestrator/prd.md                            │
│    Confirmed product requirements, user journeys,      │
│    stable IDs (REQ-*), and proposed numerical metrics  │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 4. docs/orchestrator/architecture-proposal.md          │
│    Harness integration trade-offs, worktree isolation, │
│    execution security, state machine, and data models  │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 5. docs/orchestrator/architecture-review.md            │
│    Formal architecture review, severity findings,      │
│    trade-offs, and implementation-readiness verdict    │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 6. docs/orchestrator/delivery-plan.md                  │
│    5-milestone roadmap and detailed tasks for M1       │
│    (Worktree isolation, DAG runner, verification, UI)  │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 7. docs/orchestrator/decisions-and-open-questions.md   │
│    Confirmed decisions vs. technical recommendations,   │
│    and blocking decisions requiring owner sign-off     │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 8. docs/orchestrator/revision-02-report.md             │
│    Finding-by-finding traceability report (DOC-REV-02) │
└────────────────────────────────────────────────────────┘
```

---

## 3. Deliverable Map

| Document | Focus & Revision Highlights |
| :--- | :--- |
| [`README.md`](README.md) | Package roadmap, reading order, executive summary of architectural revisions. |
| [`repository-assessment.md`](repository-assessment.md) | Grounded codebase assessment with file:line citations; clarifies tool-continuation route pinning vs. lack of task/session routing policy; audits provider adapters, database schema, security boundaries, and telemetry. |
| [`prd.md`](prd.md) | Product requirements with stable IDs (`REQ-F-*`, `REQ-NF-*`); separates confirmed product requirements from technical recommendations; mandates Milestone 1 git worktree isolation; defines exact candidate review artifact contracts and decoupled accept/commit/merge operations; marks all numerical limits as proposals (`[PROPOSAL: ...]`). |
| [`architecture-proposal.md`](architecture-proposal.md) | Technical architecture proposal: detailed trade-off comparison of CLI vs. SDK vs. custom tool loop; separates Git worktree isolation from process/execution security; defines 9-state task machine, configurable role-to-model engine, token governance (observed vs. estimated), versioned migrations, and non-destructive crash recovery. |
| [`architecture-review.md`](architecture-review.md) | Formal architecture review covering the 5 key focus areas, severity-ranked findings, exact document corrections, and the bounded compatibility spike specification. |
| [`delivery-plan.md`](delivery-plan.md) | Phased implementation plan across 5 milestones; details 10 dependency-ordered engineering tasks for Milestone 1 (`TSK-M1-01` to `TSK-M1-10`), incorporating worktree provisioning, execution containment, compatibility spike, and verification pipelines. |
| [`decisions-and-open-questions.md`](decisions-and-open-questions.md) | Catalog of confirmed decisions (`DEC-01` to `DEC-11`), assumptions, and recommendations awaiting review; highlights the specific blocking decisions requiring owner sign-off prior to coding. |
| [`revision-02-report.md`](revision-02-report.md) | Detailed traceability report for DOC-REV-02: Finding → File/Section → Resolution mapping, remaining blockers, and checks actually performed. |

---

## 4. First Vertical Slice Scope Summary (Milestone 1)

Milestone 1 delivers a complete, secure vertical slice executed sequentially:

1. **Import:** Owner imports a clean local repository.
2. **Discuss:** Owner discusses a single feature with the **Configured Planner/Architect** model in the browser UI.
3. **Approve Baseline:** System generates a structured specification (PRD + acceptance criteria); owner approves baseline `v1.0.0`.
4. **Decompose:** Orchestrator generates a bounded task DAG (`blockedBy: [...]`).
5. **Worktree Provisioning:** System creates a dedicated feature branch (`zen/<feature-slug>`) and provisions an isolated task git worktree (`.zen-worktrees/<task-id>`), protecting the owner's active working tree.
6. **Implement:** **Configured Worker** implements code and tests within the worktree.
7. **Candidate Snapshot:** Candidate commit `candidate_commit_sha` is staged and committed to `zen/task/<task-id>`.
8. **Automate Checks:** Verifier harness independently executes deterministic test and lint suites in the worktree (`exit 0`). Failing checks trigger a bounded repair loop (max `[PROPOSAL: 3]` attempts).
9. **Specialist Review:** **Configured Specialist Reviewer** (Configured Strong Model) performs an adversarial review against the exact candidate commit diff and verification digest. If the specialist model is unavailable, the review remains pending without bypass.
10. **Accept & Fast-Forward Integration:** Owner inspects diff in UI and clicks **Accept**. The orchestrator fast-forward merges `candidate_commit_sha` into `zen/<feature-slug>` and removes the worktree.
11. **Downstream Unblocking:** Downstream tasks transition to `Ready`.
12. **Feature Merge:** Explicit owner action in UI merges `zen/<feature-slug>` into `main`.

---

## 5. Scope & Working Rules Compliance

During this planning phase:
- **No application code was modified.** All existing gateways (`zen-proxy.mjs`, `codex-gateway.mjs`, `antigravity-gateway.mjs`), libraries, shell scripts, and configuration files remain completely unchanged.
- **Zero network requests, provider logins, or credential reads were performed.**
- **All documentation is concrete, internally consistent, and free of secrets.**
