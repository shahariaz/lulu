# Decisions and Open Questions: Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 1 — Grounded Contracts & Blocking Decisions  
**Date:** 2026-09-09  
**Target Release:** v0.1.0 (Milestone 1)  

---

## 1. Confirmed Architectural Decisions

The following foundational contracts are confirmed and govern the system design:

| Decision ID | Decision Summary | Context & Operational Rule |
| :--- | :--- | :--- |
| **`DEC-01`** | **Self-Hosted, Single-Owner Governance** | Self-hosted on the owner's personal machine or local server. No multi-tenant SaaS features, public billing, or team RBAC in v1. |
| **`DEC-02`** | **Git Worktree Isolation in Milestone 1** | Agent file modifications must occur in isolated git worktrees (`.zen-worktrees/<task-id>`) checked out to a task branch (`zen/task/<task-id>`). The owner's primary working copy (e.g. `main`) is never locked or dirtied. |
| **`DEC-03`** | **Execution Security Separated from Git** | Process execution security is enforced distinctly from git: realpath working-directory confinement, environment variable credential scrubbing, command allowlisting, and loopback network boundaries. |
| **`DEC-04`** | **Deterministic Code Governs State** | Agent completion claims are treated as unverified. Progression requires external verification (compiler/test exit code 0) and independent specialist diff review. |
| **`DEC-05`** | **Configurable Role-to-Model Strategy** | Zero hardcoded model selections. Planner/Architect, Worker/Implementer, and Specialist Reviewer roles are dynamically configured via SQLite/settings with sensible provider defaults and fallbacks. |
| **`DEC-06`** | **Specialist Review Availability Rule** | If the configured specialist reviewer model is unavailable or rate-limited, the task remains pending in `Code Review (Pending Specialist)`. Review must never be downgraded to a worker tier or bypassed without explicit owner override. |
| **`DEC-07`** | **Exact Review Artifact Contract** | Code review and task acceptance anchor to an immutable triple: `base_commit_sha`, `candidate_commit_sha` / `diff_digest`, and `verification_digest`. Any file change after verification immediately invalidates prior reviews and resets the check pipeline. |
| **`DEC-08`** | **Decoupled Accept, Commit, and Merge** | Task acceptance (marking task accepted) is separate from selective committing (staging only task `scope_paths`, preserving unrelated owner edits), which is separate from merging the feature branch into `main` (an explicit owner action). |
| **`DEC-09`** | **Versioned DB Migrations & Recovery** | Schema evolution is controlled via a `schema_migrations` table with sequential transactional migration scripts. Startup crash recovery sweeps detect stale task leases (> `[PROPOSAL: 5 minutes]`) and prune orphaned worktrees. |
| **`DEC-10`** | **Reuse Existing Gateway Infrastructure** | Preserve and leverage the battle-tested OAuth token handlers, account rotation pools, thought signature caches, and SSE converters from `lib/antigravity-client.mjs`, `lib/codex-app-server.mjs`, and `zen-proxy.mjs`. |

---

## 2. Working Assumptions

1. **Host Environment:** The host system has Node.js 22+, Git 2.30+, and standard build/test runtimes (`npm`, `python`, `cargo`, or `go`) installed and accessible on PATH.
2. **Local Storage:** The owner provides standard filesystem access for SQLite database storage at `~/.zen-claude/zen-orchestrator.sqlite` and local repository clones.
3. **Provider Credentials:** The owner has at least one working account configured in Claude-Zen (Google Antigravity OAuth for Gemini/Claude models, OpenAI/Codex for ChatGPT Plus, or OpenCode Zen/Qwen API keys).
4. **Network Access:** Gateway processes bind locally to `127.0.0.1` and make outbound HTTPS calls to upstream LLM APIs (Google, OpenAI, OpenCode).

---

## 3. Technical Recommendations Awaiting Owner Review

1. **Frontend Architecture (`lib/ui.mjs` Evolution):**
   *Recommendation:* Scaffold a lightweight, modern single-page application (e.g. Vite with Preact or React) served as static compiled assets by the Node.js API server on port 8789.
   *Rationale:* `lib/ui.mjs` currently embeds 2,822 lines of concatenated HTML, CSS, and vanilla JS. Adding interactive syntax-highlighted diff viewers, markdown specification editors, and live SSE task boards into that string template will create severe technical debt and maintenance friction.
2. **Worker Harness Integration Strategy:**
   *Recommendation:* For Milestone 1, begin by testing Approach A (spawning headless `claude -p --output-format stream-json --permission-mode dontAsk --bare --allowedTools ...`) against local gateway endpoints to verify Anthropic API protocol parity. If local gateways reject headers or dynamic tool schemas, fall back immediately to Approach C (native in-process Node.js tool loop over `/v1/messages`).
   *Rationale:* Approach A provides battle-tested coding tools, subagents, and compaction if gateway parity holds. Approach C provides guaranteed stability and zero external dependency risk if gateway parity is incomplete.
3. **Dedicated Orchestrator Database:**
   *Recommendation:* Create `zen-orchestrator.sqlite` alongside the existing `zen-metrics.sqlite`.
   *Rationale:* Isolates the delivery platform's core relational schema (projects, baselines, tasks) from high-volume raw proxy turn logs and rate-limit incident tables, preventing schema coupling.

---

## 4. Blocking Decisions Requiring Owner Sign-Off (Milestone 1)

The following four decisions must be confirmed by the owner before Milestone 1 implementation begins:

### Question 1: Frontend Architecture Strategy
- **Issue:** Should we continue maintaining and extending the monolithic vanilla template in `lib/ui.mjs`, or introduce a modern lightweight SPA build (e.g., Vite + Preact/React) compiled into a static distribution directory?
- **Options:**
  - **Option A (Recommended):** Introduce a lightweight Vite + Preact/React SPA built into `dist/` and served by the existing HTTP server. Provides modular components for diff rendering, chat streaming, and task boards.
  - **Option B:** Keep everything in a single vanilla JS/HTML file (`lib/ui.mjs`) to avoid any frontend build tooling or dependencies.
- **Impact on Milestone 1:** Directly affects task `TSK-M1-08` implementation approach and dependency set.

### Question 2: Autonomous Worker Harness Integration Choice
- **Issue:** Which harness integration approach should be implemented for the Worker Agent in `TSK-M1-05`?
- **Options:**
  - **Option A:** Headless Claude Code CLI (`claude -p --output-format stream-json --permission-mode dontAsk --bare --allowedTools ...`) pointing `ANTHROPIC_BASE_URL` to local proxies. *(Pending gateway parity verification: `[UNVERIFIED: Gateway Parity]`)*.
  - **Option B (Recommended for guaranteed stability):** Native In-Process Node.js Tool Runner calling local gateway `/v1/messages` directly with custom worktree-confined tools (`readFile`, `editFile`, `runCommand`).
  - **Option C:** Dual-mode: Attempt Approach A; if gateway parity fails on handshake, gracefully fall back to Approach B.
- **Impact on Milestone 1:** Directly determines the implementation of task `TSK-M1-05`.

### Question 3: Selective Git Committing Policy on Task Acceptance
- **Issue:** When the owner clicks **Accept** on a completed task diff, what git commit structure should be enforced?
- **Options:**
  - **Option A (Recommended):** Stage **only** files specified in the task's `scope_paths`, commit to the feature branch (`zen/<feature-slug>`), and leave unrelated owner modifications in the primary working copy intact.
  - **Option B:** Stage and commit all changes present in the worktree, assuming the worktree was isolated and only contains task edits.
- **Impact on Milestone 1:** Directly affects tasks `TSK-M1-02`, `TSK-M1-06`, and `TSK-M1-08`.

### Question 4: Calibration of Proposed Token & Repair Limits
- **Issue:** Are the proposed numerical guardrails acceptable for Milestone 1?
- **Proposed Defaults:**
  - Per-feature token ceiling: **500,000 tokens** (combining planning, worker implementation, and specialist review).
  - Per-task token ceiling: **150,000 tokens**.
  - Dedicated specialist reviewer budget: **80,000 tokens**.
  - Maximum automated repair loop attempts for failing tests: **3 attempts**.
  - Inactive lease timeout for crash recovery: **5 minutes**.
- **Impact on Milestone 1:** Enforced by `TSK-M1-01`, `TSK-M1-04`, and `TSK-M1-06`.

---

## 5. Non-Blocking Open Questions (Deferred to Milestones 2–4)

1. **Remote Repository Synchronization (M2):** How will GitHub / GitLab SSH keys, Personal Access Tokens, and remote webhooks be managed when remote syncing is introduced?
2. **Safe Local Previews (M2):** Should preview servers run directly on the host using dynamic port allocation, or inside lightweight container sandboxes?
3. **Parallel Worktree Three-Way Merges (M4):** What automated rebase and merge conflict strategies should be employed when multiple agents work simultaneously in parallel worktrees?
