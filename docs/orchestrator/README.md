# Claude-Zen Orchestrator: Phase 0 Planning Package

**Document Status:** Revision 1 — Updated with Architectural Review Feedback (Draft for Owner Sign-Off)  
**Date:** 2026-09-09  
**Target System:** Claude-Zen Self-Hosted AI Software Delivery Application  
**Operating Context:** Self-hosted workstation or personal server (macOS / Linux)  

---

## 1. Executive Summary

Claude-Zen is evolving from a multi-provider proxy and account-pooling gateway for the Claude Code CLI into an autonomous, self-hosted AI software delivery application with a polished browser UI.

This Phase 0 planning package establishes the product requirements, technical architecture, and implementation roadmap. Following architectural review, this package incorporates the following foundational contracts:

1. **Harness Integration Options Analyzed Rigorously:** The package evaluates three integration architectures:
   - **Headless Claude Code CLI** using structured NDJSON streaming (`-p`, `--output-format stream-json`, `--permission-mode dontAsk`, `--allowedTools`).
   - **Claude Agent SDK / Anthropic SDK Tool Runner** (`@anthropic-ai/claude-agent-sdk` / `client.beta.messages.tool_runner`).
   - **Pure Custom Node.js Agent Loop** calling local gateway `/v1/messages` endpoints directly.
   Capabilities from current official documentation are verified, with unverified gateway-level assumptions explicitly flagged as `[UNVERIFIED: ...]`.
2. **Git Working-Copy Isolation vs. Execution Security Separated:**
   - **Git Working-Copy Isolation:** Included in **Milestone 1** via isolated feature branches and dedicated task git worktrees (`.zen-worktrees/<task-id>`), guaranteeing that the owner's active checkout on their primary branch is never locked or dirtied by agent activities.
   - **Execution Security:** Managed distinctly from Git via working-directory confinement (`assertPathWithinWorktree`), process isolation, environment variable sanitization (preventing credential leakage), and network confinement.
3. **Accurate Routing Assessment:** Accurately documents that existing tool-continuation route pinning (`routeByToolCallId` in `zen-proxy.mjs`) provides in-memory turn stability during active tool loops, but does **not** provide project, task, or session-scoped routing policy.
4. **Fully Configurable Role-to-Model Assignments:** Zero hardcoded model selections. Planner/Architect, Worker/Implementer, and Specialist Reviewer roles are dynamically mapped via configuration and SQLite, with sensible defaults and fallback policies.
5. **Rigorous Token & Cost Governance:** All numerical token and cost targets are treated as **proposals** (`[PROPOSAL: ...]`). The architecture defines separate specialist budgets, handles observed versus estimated token usage, specifies missing-usage fallbacks, and caps automated repair loops.
6. **Exact Review Artifact Contract:** An accepted review requires an immutable contract: base commit SHA, candidate commit SHA / diff digest, and verification result digest. Any subsequent file modification automatically invalidates prior verification.
7. **Decoupled Task Acceptance, Committing, and Merging:** Task acceptance in the orchestrator is strictly decoupled from git committing (which selectively stages task-scoped files, preserving owner working edits) and feature merging (which remains an explicit owner action).
8. **Versioned Database Migrations & Restart Recovery:** Implements sequential versioned migrations (`schema_migrations` table) and robust crash recovery that re-hydrates task states and cleans up stale worktrees and locks.
9. **Clear Division of Requirements vs. Recommendations:** Confirmed product requirements (normative) are strictly separated from technical recommendations awaiting owner review.

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
│ 5. docs/orchestrator/delivery-plan.md                  │
│    5-milestone roadmap and detailed tasks for M1       │
│    (Worktree isolation, DAG runner, verification, UI)  │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 6. docs/orchestrator/decisions-and-open-questions.md   │
│    Confirmed decisions vs. technical recommendations,   │
│    and blocking decisions requiring owner sign-off     │
└────────────────────────────────────────────────┘
```

---

## 3. Deliverable Map

| Document | Focus & Revision Highlights |
| :--- | :--- |
| [`README.md`](README.md) | Package roadmap, reading order, executive summary of architectural revisions. |
| [`repository-assessment.md`](repository-assessment.md) | Grounded codebase assessment with file:line citations; clarifies tool-continuation route pinning vs. lack of task/session routing policy; audits provider adapters, database schema, security boundaries, and telemetry. |
| [`prd.md`](prd.md) | Product requirements with stable IDs (`REQ-F-*`, `REQ-NF-*`); separates confirmed product requirements from technical recommendations; mandates Milestone 1 git branch/worktree isolation; defines exact review artifact contracts and decoupled accept/commit/merge operations; marks all numerical limits as proposals (`[PROPOSAL: ...]`). |
| [`architecture-proposal.md`](architecture-proposal.md) | Technical architecture proposal: detailed trade-off comparison of CLI vs. SDK vs. custom tool loop; separates Git worktree isolation from process/execution security; defines 9-state task machine, configurable role-to-model engine, token governance (observed vs. estimated), versioned migrations, and crash recovery. |
| [`delivery-plan.md`](delivery-plan.md) | Phased implementation plan across 5 milestones; details 9 dependency-ordered engineering tasks for Milestone 1 (`TSK-M1-01` to `TSK-M1-09`), incorporating worktree provisioning, execution containment, and verification pipelines. |
| [`decisions-and-open-questions.md`](decisions-and-open-questions.md) | Categorizes confirmed decisions, assumptions, and recommendations awaiting review; highlights the specific blocking decisions requiring owner sign-off prior to coding. |

---

## 4. First Vertical Slice Scope Summary (Milestone 1)

Milestone 1 delivers a complete, secure vertical slice executed sequentially:

1. **Import:** Owner imports a local repository on the host machine.
2. **Discuss:** Owner discusses a single feature with the **Configured Planner/Architect** model in the browser UI.
3. **Approve Baseline:** System generates a structured specification (PRD + acceptance criteria); owner approves baseline `v1.0.0`.
4. **Decompose:** Orchestrator generates a bounded task DAG (`blockedBy: [...]`).
5. **Worktree Provisioning:** System creates a dedicated feature branch (`zen/<feature-slug>`) and provisions an isolated task git worktree (`.zen-worktrees/<task-id>`), protecting the owner's active working tree.
6. **Implement:** **Configured Worker** (e.g. Gemini 3.8 Flash via Antigravity) implements the code and unit tests inside the isolated worktree with path-confined, credential-scrubbed tools.
7. **Automate Checks:** Verifier harness independently executes deterministic test and lint suites in the worktree (`exit 0`). Failing checks trigger a bounded repair loop (max `[PROPOSAL: 3]` attempts).
8. **Specialist Review:** **Configured Specialist Reviewer** (Configured Strong Model) performs an adversarial review against the exact candidate commit diff and verification digest. If the specialist model is unavailable, the review remains pending without bypass.
9. **Accept, Commit & Merge:** Owner inspects the diff and review in the browser UI. Owner **Accepts** the task; the orchestrator selectively commits task-scoped files to the feature branch (preserving any unrelated owner changes); feature merging into `main` remains an explicit owner-directed step.

---

## 5. Scope & Working Rules Compliance

During this planning phase:
- **No application code was modified.** All existing gateways (`zen-proxy.mjs`, `codex-gateway.mjs`, `antigravity-gateway.mjs`), libraries, shell scripts, and configuration files remain completely unchanged.
- **Zero network requests, provider logins, or credential reads were performed.**
- **All documentation is concrete, internally consistent, and free of secrets.**
