# Decisions and Open Questions: Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 3 — Corrected Contracts & Owner Choices Pending  
**Date:** 2026-09-09  
**Target Release:** v0.1.0 (Milestone 1: Core Vertical Slice)  

---

## 1. Confirmed Architectural Decisions

The following foundational contracts are confirmed and govern the system design:

| Decision ID | Decision Summary | Context & Operational Rule |
| :--- | :--- | :--- |
| **`DEC-01`** | **Self-Hosted, Single-Owner Governance** | Self-hosted on the owner's personal machine or local server. No multi-tenant SaaS features, public billing, or team RBAC in v1. |
| **`DEC-02`** | **Git Worktree Isolation in Milestone 1** | Agent file modifications must occur in isolated git worktrees (`.zen-worktrees/<task-id>`) checked out to a task branch (`zen/task/<task-id>`). The owner's primary working copy (e.g. `main`) is never locked or dirtied. |
| **`DEC-03`** | **Execution Security Distinct from Git** | Working directory confinement (`assertPathWithinWorktree`), environment credential scrubbing, process tree timeouts (POSIX process groups via Node.js `detached: true`), and command allowlists provide a cooperative runtime boundary on the host, not an impenetrable hypervisor sandbox. An advanced containerized tier is defined as a separate proposal. |
| **`DEC-04`** | **Deterministic Code Governs State** | Agent completion claims are treated as unverified. Progression requires external verification (compiler/test exit code 0) and independent specialist diff review. |
| **`DEC-05`** | **Configurable Role-to-Model Strategy** | Zero hardcoded model selections. Planner/Architect, Worker/Implementer, and Specialist Reviewer roles are dynamically configured via SQLite/settings with sensible provider defaults and fallbacks. |
| **`DEC-06`** | **Specialist Review Availability Rule** | If the configured specialist reviewer model is unavailable or rate-limited, the task remains in `Code Review` with `waiting_reason = 'SPECIALIST_UNAVAILABLE'`. Required review is not downgraded, bypassed, or represented as a blocked task. |
| **`DEC-07`** | **Exact Candidate Review Artifact** | Code review and task acceptance anchor to an immutable candidate commit SHA, diff digest, and verification digest. Any tracked-file modification post-verification immediately invalidates prior reviews and resets the check pipeline. |
| **`DEC-08`** | **Decoupled Accept, Fast-Forward Merge, and Feature Merge** | Task acceptance (marking task accepted in UI) is separate from task integration (`git merge --ff-only zen/task/<task-id>` into `zen/<feature-slug>`), which is separate from merging the feature branch into `main` (an explicit owner action). Acceptance references the existing reviewed candidate commit without creating replacement commits. |
| **`DEC-09`** | **Non-Destructive Recovery & Cancellation** | Automatic forced worktree deletion is strictly forbidden. On crashes or cancellation, the actual workspace (tracked, untracked, and ignored files) is preserved on disk, and transient tasks transition to `Blocked` with reason `RECONCILIATION_REQUIRED`. Process identity is verified (PID, start time, cmdline) before signaling. |
| **`DEC-10`** | **Versioned DB Migrations** | Schema evolution is controlled via a `schema_migrations` table with sequential transactional SQL migration scripts. |
| **`DEC-11`** | **Reuse Existing Gateway Infrastructure** | Preserve and leverage the battle-tested OAuth token handlers, account rotation pools, thought signature caches, and SSE converters from `lib/antigravity-client.mjs`, `lib/codex-app-server.mjs`, and `zen-proxy.mjs`. |
| **`DEC-12`** | **Database Strategy: SQLite Now, Storage Abstraction for Future PostgreSQL** | The owner prefers PostgreSQL for long-term scalability. For the initial workstation release, embedded SQLite (`DatabaseSync` in WAL mode) is used to avoid external database daemon prerequisites. A strict Storage Repository abstraction layer is implemented so migrating to PostgreSQL in a future milestone requires zero state-machine or business-logic rewrites. |
| **`DEC-13`** | **Modern UI Stack: Vite + React + shadcn/ui + GSAP + PWA** | Replace the monolithic 2.8k-line `lib/ui.mjs` with a modern React + TypeScript single-page application built via Vite, styled with Tailwind CSS and Radix/shadcn/ui primitives, animated with GSAP and Framer Motion, and distributed as an installable Progressive Web App (PWA) with frameless desktop window and dock badging support. |

---

## 2. Working Assumptions

1. **Host Environment:** The host system has Node.js 22+ (verified: Node v24.19.0), Git 2.30+ (verified: Git 2.55.0), and standard build/test runtimes (`npm`, `python`, `cargo`, or `go`) installed and accessible on PATH.
2. **Local Storage:** The owner provides standard filesystem access for SQLite database storage at `~/.zen-claude/zen-orchestrator.sqlite` and local repository clones.
3. **Provider Credentials:** The owner has at least one working account configured in Claude-Zen (Google Antigravity OAuth for Gemini/Claude models, OpenAI/Codex for ChatGPT Plus, or OpenCode Zen/Qwen API keys).
4. **Network Access:** Gateway processes bind locally to `127.0.0.1` and make outbound HTTPS calls to upstream LLM APIs (Google, OpenAI, OpenCode).

---

## 3. Technical Recommendations Awaiting Owner Review

1. **Frontend Architecture (`lib/ui.mjs` Evolution):**
   *Recommendation:* Scaffold a lightweight, modern single-page application (e.g. Vite with Preact or React) served as static compiled assets by the Node.js API server on port 8789.
   *Rationale:* `lib/ui.mjs` currently embeds 2,822 lines of concatenated HTML, CSS, and vanilla JS. Adding interactive syntax-highlighted diff viewers, markdown specification editors, and live SSE task boards into that string template creates severe technical debt and maintenance friction.
2. **Worker Harness Integration Strategy (Spike-First):**
   *Recommendation:* Do not decide between Headless Claude Code CLI (Approach A) and Custom Node.js Loop (Approach C) based on unverified assumptions. Execute the offline compatibility spike `TSK-SPIKE-HARNESS-PARITY` (`TSK-M1-05`) to empirically test CLI streaming, dynamic tools, and flag compatibility against a mock Anthropic server before implementing `TSK-M1-06`.
   *Rationale:* A passing result makes the CLI approach viable. A failure must first be classified as a test/configuration defect or a reproducible CLI/gateway incompatibility. Only then are the remaining approaches compared and a decision recorded.
3. **Execution Boundary Tiering:**
   *Recommendation:* For Milestone 1, adopt Proposal B (Cooperative Trusted-Local Execution with path checks, credential scrubbing, process tree timeouts, and command allowlists). Document Proposal A (Containerized/OS-isolated Worker using rootless Podman/Docker or macOS sandbox) as the advanced security tier for untrusted repositories.
   *Rationale:* Proposal B provides immediate, zero-dependency protection against accidental host damage on personal workstations, while acknowledging that true isolation against adversarial code requires containerization.
4. **Dedicated Orchestrator Database:**
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
- **Impact on Milestone 1:** Directly affects task `TSK-M1-09` implementation approach and dependency set.

### Question 2: Worker Harness Integration Strategy
- **Issue:** How should the orchestrator execute the Worker Agent?
- **Options:**
  - **Option A (Recommended):** Execute `TSK-SPIKE-HARNESS-PARITY` (`TSK-M1-05`), classify failures, and record an ADR selecting among the CLI, Agent SDK, and custom-loop approaches based on evidence.
  - **Option B:** Select an engine now and explicitly accept the untested compatibility and maintenance risks.
- **Impact on Milestone 1:** Directly determines the implementation of task `TSK-M1-05` and `TSK-M1-06`.

### Question 3: Execution Security Tier for Milestone 1
- **Issue:** Which execution boundary tier should be implemented for worker task execution in Milestone 1?
- **Options:**
  - **Option A (Recommended):** Proposal B (Cooperative Trusted-Local Mode: realpath worktree confinement, environment credential scrubbing, process tree timeouts, command allowlisting), with documented host user privilege limitations.
  - **Option B:** Proposal A (Containerized Execution: require Docker or rootless Podman to execute all worker tools and tests inside an isolated container).
- **Impact on Milestone 1:** Option A requires zero external container prerequisites; Option B adds Docker daemon dependencies and image build management to `TSK-M1-06` and `TSK-M1-07`.

### Question 4: Calibration of Proposed Token & Repair Limits
- **Issue:** Are the proposed numerical guardrails acceptable for Milestone 1?
- **Proposed Defaults:**
  - Per-feature token ceiling: **500,000 tokens** (combining planning, worker implementation, and specialist review).
  - Per-task token ceiling: **150,000 tokens**.
  - Dedicated specialist reviewer budget: **80,000 tokens**.
  - Maximum automated repair loop attempts for failing tests: **3 attempts**.
  - Process tree execution timeout: **120 seconds**.
  - Inactive lease inquiry threshold: **5 minutes**.
- **Impact on Milestone 1:** Enforced by `TSK-M1-01`, `TSK-M1-04`, `TSK-M1-06`, and `TSK-M1-07`.

---

## 5. Non-Blocking Open Questions (Deferred to Milestones 2–4)

1. **Remote Repository Synchronization (M2):** How will GitHub / GitLab SSH keys, Personal Access Tokens, and remote webhooks be managed when remote syncing is introduced?
2. **Safe Local Previews (M2):** Should preview servers run directly on the host using dynamic port allocation, or inside lightweight container sandboxes?
3. **Parallel Worktree Three-Way Merges (M4):** What automated rebase and merge conflict strategies should be employed when multiple agents work simultaneously in parallel worktrees?
