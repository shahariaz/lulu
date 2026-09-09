# Technical Architecture Proposal: Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 1 — Comprehensive Architectural Design & Contracts  
**Date:** 2026-09-09  
**Target Release:** v0.1.0 (Milestone 1: Core Vertical Slice)  

---

## 1. System Overview & Core Principles

The Claude-Zen Orchestrator evolves the existing repository from a collection of local HTTP proxy gateways into an autonomous, self-hosted AI software delivery platform.

The system is engineered around six fundamental architectural tenets:

1. **Ordinary Code Governs the Control Plane:** LLM models generate reasoning, text, code edits, and review commentary, but **deterministic code** (state machines, database transactions, dependency schedulers, process runners) strictly controls task state transitions, git operations, budgets, and error recovery.
2. **Untrusted Model Claims:** An agent model's declaration that work is complete is treated as unverified. Progression requires external, verifiable proof: compiler/test runner exit code 0, clean git diff digests, and independent specialist code review.
3. **Git Worktree Isolation vs. Execution Security Separated:**
   - **Git Working-Copy Isolation:** Agent modifications occur inside isolated git worktrees (`.zen-worktrees/<task-id>`), guaranteeing that the owner's active checkout on their primary branch is never locked or modified during agent operations.
   - **Execution Security:** Confinement of child processes (Node.js/Bash) to the worktree path, environment variable scrubbing (removing API keys and credentials), command allowlisting/denylisting, process resource timeouts, and network boundary restrictions.
4. **Fully Configurable Role Specialization:** Models are assigned to distinct operational roles (Planner, Worker, Reviewer) through dynamic configuration with zero hardcoded model lock-in. Specialist reviews remain strictly pending if their allowed models are unavailable.
5. **Exact Review Artifact Contracts:** Review and acceptance anchor to an immutable triple: base commit SHA, candidate commit SHA / diff digest, and automated verification digest. Any subsequent file alteration automatically invalidates verification.
6. **Decoupled Governance:** Task acceptance in the orchestrator is strictly decoupled from git committing (which selectively stages task-scoped files, preserving owner working edits) and feature merging (which remains an explicit owner action).

---

## 2. Harness Integration Architecture: Trade-Off Analysis

A core technical decision is how the orchestrator drives agent execution. We evaluate three distinct architectural approaches:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Harness Integration Architecture Options                         │
├────────────────────────────┬─────────────────────────────┬─────────────────────────────┤
│ Approach A: Headless CLI   │ Approach B: SDK Harness     │ Approach C: Custom Loop     │
│ claude -p --output-format   │ @anthropic-ai/claude-agent- │ Native Node.js agent loop   │
│ stream-json --bare         │ sdk OR Anthropic toolRunner │ over local gateway APIs     │
└────────────────────────────┴─────────────────────────────┴─────────────────────────────┘
```

### 2.1 Approach A: Spawning Headless Claude Code CLI

- **Mechanism:** The orchestrator spawns `claude` as an external child process:
  ```bash
  claude -p "<prompt>" \
    --bare \
    --output-format stream-json \
    --include-partial-messages \
    --tools "Read,Edit,Write,Bash,Glob,Grep" \
    --permission-mode dontAsk \
    --permission-prompts none \
    --settings '{"permissions":{"allow":["Read","Edit","Write","Bash(npm test)"],"deny":["Bash(rm -rf *)"]}}'
  ```
- **Stream Protocol:** Communicates via newline-delimited JSON (NDJSON) events on stdout (`system/init`, `stream_event`, `assistant`, `result`), allowing real-time token streaming and tool event capture without scraping console ANSI text.
- **Strengths:**
  - **Turnkey Coding Engine:** Mature, production-tested implementations for file patching, fuzzy search, subagent delegation, and token context compaction out of the box.
  - **Process Isolation:** Memory leaks, infinite loops, or child crashes do not crash the parent orchestrator.
  - **Declarative Permissions:** Native support for `dontAsk`, `acceptEdits`, allow/deny pattern rules, and `PreToolUse` hooks.
- **Trade-Offs & Limitations:**
  - High process spawn overhead (~0.5s–1.5s cold spawn).
  - Requires maintaining a robust NDJSON stream parser with buffer draining and exit signal handling (`SIGTERM`).
  - *[UNVERIFIED: Gateway Parity]*: Claude Code CLI expects Anthropic API protocol parity. Pointing `ANTHROPIC_BASE_URL` to local proxies (`http://127.0.0.1:8787-8789`) requires the gateways to correctly forward or gracefully handle Anthropic beta headers (e.g. `prompt-caching-2024-07-31`, `structured-outputs-2025-11-13`) and Claude Code's extensive dynamic tool schemas without throwing HTTP 400 errors.

### 2.2 Approach B: Claude Agent SDK / Anthropic SDK Tool Runner

- **Mechanism:**
  - **B1 (Claude Agent SDK):** Uses `@anthropic-ai/claude-agent-sdk` (`query({ prompt, options: { mcpServers, permissionMode: 'dontAsk', canUseTool } })`). Packages custom tools in in-process MCP servers (`createSdkMcpServer`).
  - **B2 (Anthropic SDK Tool Runner):** Uses `@anthropic-ai/sdk` (`client.beta.messages.toolRunner({ model, tools, messages })`) pointing `baseURL` to the local gateway ports (`:8787`, `:8788`, `:8789`).
- **Strengths:**
  - **Type-Safe In-Process Integration:** Native async iteration (`for await (const chunk of runner)`) eliminates subprocess stdin/stdout pipe serialization.
  - **Granular Execution Hooks:** Direct per-turn interception via `generateToolResponse()` or `canUseTool`.
  - **Warm Initialization:** B1 provides `startup()` to pre-warm the engine.
- **Trade-Offs & Limitations:**
  - B1 bundles a native binary behind the scenes; B2 has **zero built-in coding tools** (you must code `Read`, `Edit`, `Write`, `Bash` from scratch).
  - *[UNVERIFIED: Gateway Parity]*: Local gateways must maintain complete compatibility with Anthropic SDK message structures and tool streaming deltas.

### 2.3 Approach C: Pure Custom Node.js Agentic Loop

- **Mechanism:** The orchestrator implements a lightweight, native agent loop:
  1. Sends user/task prompt to `http://127.0.0.1:878[7-9]/v1/messages`.
  2. Receives Anthropic SSE stream (`text/event-stream`), emitting tokens to the UI.
  3. When `tool_use` is encountered, executes local sandboxed JavaScript functions (`readFile`, `editFile`, `runCommand`).
  4. Appends `tool_result` to history and repeats until `stop_reason === 'end_turn'`.
- **Strengths:**
  - **Maximum Gateway Resilience:** 100% control over headers and payload shapes. Bypasses client SDK assumptions and can adapt dynamically to Google, OpenAI, or Zen proxy idiosyncrasies.
  - **Zero Startup Latency:** In-process, near-zero startup time (<5ms) and tiny memory footprint.
  - **Effortless Multi-Port Routing:** Trivial to route planning turns to port 8789 (Codex) and worker turns to port 8788 (Antigravity) within the same conversation loop.
- **Trade-Offs & Limitations:**
  - Requires maintaining the agentic loop, tool schema definitions, file patching algorithms, and context window truncation manually.

### 2.4 Integration Recommendation

| Use Case / Role | Recommended Approach | Rationale |
| :--- | :--- | :--- |
| **Planner / Architect** | **Approach C (Custom Loop)** | Planning requires simple structured conversation and markdown generation; no complex file-patching tools are needed. Direct gateway calls provide instant streaming and zero overhead. |
| **Worker / Implementer** | **Approach A (Headless CLI) or C (Custom Loop)** | *Pending owner decision (Decision 2):* If gateway parity is verified, Approach A provides battle-tested coding tools; if parity is fragile, Approach C provides guaranteed stability. |
| **Specialist Reviewer** | **Approach C (Custom Loop)** | Reviewing is purely read-only over an exact diff patch; custom loop with diff injection is simple, robust, and fast. |

---

## 3. Subsystem Architecture & Boundaries

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Browser User Interface                                  │
│       (Project Explorer, Chat Scoper, Baseline Approver, Task Board, Diff Viewer)       │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ HTTP REST / SSE Stream
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                Claude-Zen API Server                                    │
│       - Project & Workspace Management      - Baseline & Specification Engine          │
│       - Task State & DAG Endpoints          - Diff & Audit Log Service                 │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                             Orchestration Engine (Core)                                │
│       - Deterministic Task State Machine    - Dependency DAG Scheduler                 │
│       - Bounded Repair Loop Controller      - Token & Budget Guardrails                │
│       - Git Worktree Isolation Manager      - Execution Security Sandbox               │
└───────┬───────────────────────────────────┬────────────────────────────────────┬───────┘
        │                                   │                                    │
        ▼                                   ▼                                    ▼
┌───────────────┐                   ┌───────────────┐                    ┌───────────────┐
│ Planner Agent │                   │ Worker Agent  │                    │ Reviewer Agent│
│ Harness       │                   │ Harness       │                    │ Harness       │
│ (Read-Only)   │                   │ (In Worktree) │                    │ (Diff & Read) │
└───────┬───────┘                   └───────┬───────┘                    └───────┬───────┘
        │                                   │                                    │
        └───────────────────────────────────┼────────────────────────────────────┘
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                         Provider Gateway Layer (Reused Assets)                          │
│   - Codex Gateway (:8789)       - Antigravity Gateway (:8788)   - Zen Proxy (:8787)    │
│   - ChatGPT Plus OAuth          - Google Cloud Code PKCE        - OpenCode / Qwen      │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          Persistence & Host Git Workspace                              │
│       - SQLite DB (zen-orchestrator.sqlite)     - Local Git Worktrees & Branches       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Git Worktree Isolation vs. Execution Security

Claude-Zen strictly distinguishes **Git working-copy isolation** from **execution security**:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Git Working-Copy Isolation (Repository State)                                           │
│  - Dedicated feature branch: git branch zen/<feature-slug>                              │
│  - Isolated task worktree: git worktree add .zen-worktrees/<task-id> zen/<feature-slug> │
│  - Benefit: User's active branch checkout (e.g. main) is NEVER touched or dirtied.      │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Execution Security & Sandboxing (Host Process Security)                                 │
│  - Working Directory Confinement: assertPathWithinWorktree(targetPath, worktreeRoot)    │
│  - Credential Scrubbing: Child env stripped of ANTHROPIC_API_KEY, OAuth tokens, etc.    │
│  - Command Allowlisting: Only allowlisted build/test tools permitted (npm, go, cargo)   │
│  - Network Confinement: Block outbound WAN connections; allow only local loopback       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Git Worktree Isolation Workflow (Milestone 1)
1. **Branch Provisioning:** When a feature baseline is approved, the orchestrator creates `zen/<feature-slug>` from the base commit SHA.
2. **Task Worktree Creation:** When a task enters `In Progress`, the orchestrator runs:
   ```bash
   git worktree add -b zen/task/<task-id> .zen-worktrees/<task-id> zen/<feature-slug>
   ```
3. **Execution Confinement:** The worker agent's tools are pointed exclusively to `.zen-worktrees/<task-id>` as their root.
4. **Checkpoint Commits:** When verification passes, changes inside the worktree are committed to `zen/task/<task-id>` producing the exact `candidate_commit_sha`.
5. **Teardown & Cleanup:** When the task is accepted or cancelled:
   ```bash
   git worktree remove --force .zen-worktrees/<task-id>
   git worktree prune
   ```

### 4.2 Execution Security & Sandboxing Policies
1. **Filesystem Path Confinement:**
   Every tool operation resolves canonical paths via `fs.realpathSync`. Any path outside `.zen-worktrees/<task-id>` throws an immediate security violation (`E_PATH_TRAVERSAL`).
2. **Credential Sanitization:**
   Processes spawned by the worker harness receive a sanitized `process.env`. All sensitive keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `CODEX_HOME`, SQLite paths) are stripped.
3. **Command Runner Allowlist:**
   Commands executed by the agent must match an allowlist: language toolchains (`npm`, `npx`, `pnpm`, `python`, `pytest`, `cargo`, `go`) and git queries (`git status`, `git diff`). Shell expansion (`|`, `;`, `&`, `eval`, `sudo`) is blocked.
4. **Network Boundaries:**
   Worker processes run with loopback-only environment bindings, preventing rogue scripts from exfiltrating code to external servers.

---

## 5. Task State Machine & Governance Matrix

```
                  ┌──────────────┐
                  │   Backlog    │
                  └──────┬───────┘
                         │ (Dependencies satisfied)
                         ▼
                  ┌──────────────┐
                  │    Ready     │
                  └──────┬───────┘
                         │ (Orchestrator provisions worktree)
                         ▼
                  ┌──────────────┐
       ┌─────────▶│ In Progress  │◀─────────┐
       │          └──────┬───────┘          │
       │                 │ (Worker requests verification)
       │                 ▼                  │
       │          ┌──────────────┐          │
       │ (Fail    │  Automated   │          │ (Changes requested
       │  checks) │    Checks    │          │  by reviewer or owner)
       │          └──────┬───────┘          │
       │                 │ (Checks exit 0)  │
       │                 ▼                  │
       │          ┌──────────────┐          │
       │          │ Code Review  │──────────┘
       │          └──────┬───────┘
       │                 │ (Specialist approves)
       │                 ▼
       │          ┌──────────────┐
       │          │      QA      │
       │          └──────┬───────┘
       │                 │ (Owner accepts in UI)
       │                 ▼
       │          ┌──────────────┐
       │          │     Done     │
       │          └──────────────┘
       │
       │ (Exceeds max repair attempts)
       ▼
┌──────────────┐                     ┌──────────────┐
│   Blocked    │                     │  Cancelled   │
│(Owner assist)│                     │(Owner cancel)│
└──────────────┘                     └──────────────┘
```

### 5.1 State Progression Rules

| State | Allowed Transitions | Transition Gate / Required Evidence |
| :--- | :--- | :--- |
| **`Backlog`** | `Ready`, `Cancelled` | **Automated:** All dependency task IDs in `blockedBy` have status `Done`. |
| **`Ready`** | `In Progress`, `Cancelled` | **Automated:** No other task is active in project (single active writer rule). Worktree provisioned. |
| **`In Progress`** | `Automated Checks`, `Blocked`, `Cancelled` | **Worker Agent:** Worker calls `request_verification`. Edits flushed to worktree. |
| **`Automated Checks`** | `In Progress` (Repair), `Code Review`, `Blocked` | **Verifier Engine:** Tests exit 0 -> advances to `Code Review`. Tests exit != 0 -> if `repair_attempts < max_repairs`, increments counter and returns to `In Progress`; else transitions to `Blocked`. |
| **`Code Review`** | `QA`, `In Progress`, `Code Review (Pending)` | **Specialist Reviewer:** Verdict `APPROVE` -> advances to `QA`. Verdict `CHANGES_REQUESTED` -> returns to `In Progress`. Specialist model unavailable -> enters `Code Review (Pending Specialist)`. |
| **`QA`** | `Done`, `In Progress` | **Human Owner:** Owner clicks **Accept** -> transitions to `Done`. Owner clicks **Request Changes** -> returns to `In Progress`. |
| **`Done`** | Terminal (or `In Progress` via rework) | Task changes committed to feature branch; worktree removed. |
| **`Blocked`** | `Ready`, `In Progress`, `Cancelled` | **Human Owner:** Owner resolves blockage, adjusts parameters/code, and resumes task. |

---

## 6. Exact Review Artifact Contract

To eliminate ambiguity and prevent race conditions, the review and acceptance process operates exclusively on an **immutable review artifact**:

```json
{
  "task_id": "TSK-01",
  "base_commit_sha": "a1b2c3d4e5f6...",
  "candidate_commit_sha": "f6e5d4c3b2a1...",
  "diff_digest": "sha256:8f4c2e...",
  "verification_digest": "sha256:1a2b3c...",
  "verification_exit_code": 0,
  "verified_at": 1773280000000
}
```

### 6.1 Invalidation on Subsequent Alteration
If any file within the worktree is modified after automated verification (e.g. by a background script or human edit), the computed `diff_digest` no longer matches the verification record. The orchestrator:
1. Immediately marks prior verification results as **Invalidated**.
2. Revokes any pending or completed specialist review verdicts.
3. Resets the task state back to `Automated Checks`.
4. Prevents the owner from accepting an unverified diff.

---

## 7. Decoupled Acceptance, Committing, and Merging Workflow

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Decoupled Governance Model                                                             │
├────────────────────────────┬─────────────────────────────┬─────────────────────────────┤
│ Stage 1: Task Acceptance   │ Stage 2: Selective Commit   │ Stage 3: Feature Merge      │
├────────────────────────────┼─────────────────────────────┼─────────────────────────────┤
│ - Owner reviews diff in UI │ - Orchestrator stages ONLY  │ - Feature complete (all M1  │
│ - Verifies test outputs    │   files in task scope_paths │   tasks in Done state)      │
│ - Clicks "Accept Task"     │ - Preserves uncommitted     │ - Explicit owner action:    │
│ - Task status -> Done      │   owner edits elsewhere     │   "Merge Feature Branch"    │
│ - Worktree pruned          │ - Clean git commit on       │ - Squash/rebase merge       │
│                            │   branch zen/<feature-slug> │   into main branch          │
└────────────────────────────┴─────────────────────────────┴─────────────────────────────┘
```

---

## 8. Configurable Model Strategy & Quota Failover

The orchestrator eliminates hardcoded models, providing dynamic role-to-model configuration:

| Operational Role | Default Provider & Model | Configurable Parameters | Fallback & Exhaustion Behavior |
| :--- | :--- | :--- | :--- |
| **Planner / Architect** | Configured Strong Model (Claude 3.7 Sonnet / Opus via Antigravity OR GPT-5.6-sol via Codex) | `provider`, `model`, `reasoning_effort` | Attempt fallback strong model in pool. If all strong models exhausted, task enters `Blocked (Planning Model Unavailable)`. |
| **Worker / Implementer** | Configured Worker Model (Gemini 3.8 Flash via Antigravity) | `provider`, `model`, `reasoning_effort` | Rotate across accounts in pool. Fallback to alternative fast models (e.g. MiMo/Qwen). |
| **Automated Verifier** | Pure Deterministic Code (No LLM) | Command string, timeout, env | N/A (runs local test runners). |
| **Specialist Reviewer** | Configured Strong Model (Claude 3.7 Sonnet Thinking via Antigravity OR GPT-5.6-sol via Codex) | `provider`, `model`, `reasoning_effort` | **STRICT RULE:** Must remain in `Code Review (Pending Specialist)` if unavailable. Never downgrade review to worker tier. |

---

## 9. Token & Cost Governance Engine

All numerical limits are proposals (`[PROPOSAL: ...]`) requiring owner confirmation.

### 9.1 Observed vs. Estimated Token Usage
1. **Observed Usage:** Upstream provider token counts (Google Cloud Code `promptTokenCount` / `candidatesTokenCount`, OpenAI `usage.prompt_tokens`) are recorded as canonical.
2. **Estimated Usage:** When streaming or when an upstream provider omits token metrics (e.g. some OpenCode routes), the orchestrator calculates heuristic token usage (`Math.ceil(characterCount / 4)`) and tags the record in SQLite with `is_estimated = 1`.
3. **Usage Aggregation:** The system exposes both `observed_tokens` and `estimated_tokens` on task dashboards.

### 9.2 Budget Ceilings & Exhaustion
- **Proposed Ceilings:**
  - Feature Budget: `[PROPOSAL: 500,000 tokens]`
  - Single Task Budget: `[PROPOSAL: 150,000 tokens]`
  - Specialist Review Budget: `[PROPOSAL: 80,000 tokens]`
- **Exhaustion Handling:**
  - When cumulative task usage reaches `[PROPOSAL: 90%]`, a warning is displayed.
  - When usage reaches `100%`, execution halts immediately. The task transitions to `Blocked (Budget Ceiling Reached)` and requires an explicit owner budget increase to resume.

---

## 10. Persistence Schema & Versioned Migrations

All control-plane state is persisted in a dedicated SQLite database (`~/.zen-claude/zen-orchestrator.sqlite`) using Node.js native `DatabaseSync` in WAL mode.

### 10.1 Versioned Migrations Engine
Schema changes are managed via a `schema_migrations` table:
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```
Migration files (`001_initial_schema.sql`, `002_add_worktrees.sql`) execute sequentially inside transactions.

### 10.2 Relational Data Model

```
┌──────────────┐       ┌────────────────────────┐       ┌──────────────┐
│   projects   │───1:N─▶│ requirements_baselines │───1:N─▶│  milestones  │
└──────────────┘       └────────────────────────┘       └──────┬───────┘
                                                               │
                                                              1:N
                                                               ▼
┌──────────────┐       ┌────────────────────────┐       ┌──────────────┐
│  audit_logs  │       │       task_runs        │◀──1:N─│    tasks     │
└──────────────┘       └───────────┬────────────┘       └──────────────┘
                                   │
                                  1:N
                                   ▼
                       ┌────────────────────────┐
                       │  verification_results  │
                       └────────────────────────┘
```

1. **`projects`**: `id`, `name`, `repo_path`, `active_branch`, `created_at`.
2. **`requirements_baselines`**: `id`, `project_id`, `version`, `spec_markdown`, `status` (`DRAFT`, `APPROVED`, `SUPERSEDED`), `approved_at`, `approved_by`.
3. **`milestones`**: `id`, `baseline_id`, `title`, `order_index`.
4. **`tasks`**: `id`, `milestone_id`, `title`, `description`, `scope_paths_json`, `status` (9 states), `blocked_by_json`, `worktree_path`, `repair_attempts`, `max_repairs` (default 3), `created_at`, `updated_at`.
5. **`task_runs`**: `id`, `task_id`, `role`, `model`, `provider`, `account_email`, `input_tokens`, `output_tokens`, `is_estimated`, `base_commit_sha`, `candidate_commit_sha`, `diff_digest`, `started_at`, `completed_at`, `status`.
6. **`verification_results`**: `id`, `task_run_id`, `command`, `exit_code`, `output_log`, `verification_digest`, `passed`, `executed_at`.
7. **`audit_logs`**: `id`, `project_id`, `event_type`, `actor`, `details_json`, `timestamp`.

---

## 11. Crash Recovery & Resilience Architecture

1. **Startup Recovery Routine:**
   On orchestrator boot, the engine executes a recovery sweep:
   - Queries `tasks` where status IN (`In Progress`, `Automated Checks`, `Code Review`).
   - Checks the lease heartbeat timestamp in `task_runs`.
   - If heartbeat is stale (> `[PROPOSAL: 5 minutes]`), marks the run as `INTERRUPTED`, cleans up the task worktree, and resets the task to `Ready` (or `Blocked` if uncommitted changes exist).
2. **Orphaned Worktree Pruning:**
   Scans `.zen-worktrees/` for any directories not mapped to an active `In Progress` task in SQLite, running `git worktree remove --force` and `git worktree prune`.
3. **Stale Lock Cleanup:**
   Cleans up stale directory locks (`*.lock.d`) and PID files left behind by ungraceful host reboots.
