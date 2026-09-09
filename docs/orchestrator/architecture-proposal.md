# Technical Architecture Proposal: Claude-Zen Self-Hosted AI Software Delivery Platform

**Document Status:** Revision 2 — Resolved Architectural Contracts  
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
6. **Decoupled Governance & Fast-Forward Integration:** Task acceptance in the orchestrator is strictly decoupled from fast-forward feature integration (`git merge --ff-only`), which is in turn decoupled from base-branch merging (`main`).

---

## 2. Harness Integration Architecture: Empirical Spike & Trade-Off Analysis

A core technical decision is how the orchestrator drives agent execution. Rather than prematurely declaring one approach as universally superior, the architecture evaluates three distinct integration models and specifies an empirical compatibility spike (`TSK-SPIKE-HARNESS-PARITY`) to decide between them based on observed facts.

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

- **Mechanism:** The orchestrator spawns `claude` (installed binary `2.1.231`) as a child process:
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
- **Trade-Offs & Unknowns:**
  - Process spawn overhead (~0.5s–1.5s cold spawn).
  - Requires maintaining an NDJSON stream parser with buffer draining and exit signal handling (`SIGTERM`).
  - *[UNVERIFIED: Gateway Parity]*: Claude Code CLI expects Anthropic API protocol parity. Pointing `ANTHROPIC_BASE_URL` to local proxies (`http://127.0.0.1:8787-8789`) requires the gateways to correctly forward or gracefully handle Anthropic beta headers (e.g. `prompt-caching-2024-07-31`, `structured-outputs-2025-11-13`) and Claude Code's dynamic tool schemas without throwing HTTP 400 errors.

### 2.2 Approach B: Claude Agent SDK / Anthropic SDK Tool Runner

- **Mechanism:**
  - **B1 (Claude Agent SDK):** Uses `@anthropic-ai/claude-agent-sdk` (`query({ prompt, options: { mcpServers, permissionMode: 'dontAsk', canUseTool } })`). Packages custom tools in in-process MCP servers (`createSdkMcpServer`).
  - **B2 (Anthropic SDK Tool Runner):** Uses `@anthropic-ai/sdk` (`client.beta.messages.toolRunner({ model, tools, messages })`) pointing `baseURL` to the local gateway ports (`:8787`, `:8788`, `:8789`).
- **Strengths:**
  - **Type-Safe In-Process Integration:** Native async iteration (`for await (const chunk of runner)`) eliminates subprocess stdin/stdout pipe serialization.
  - **Granular Execution Hooks:** Direct per-turn interception via `generateToolResponse()` or `canUseTool`.
  - **Warm Initialization:** B1 provides `startup()` to pre-warm the engine.
- **Trade-Offs & Unknowns:**
  - B1 bundles a native binary behind the scenes; B2 has **zero built-in coding tools** (requires building `Read`, `Edit`, `Write`, `Bash` from scratch).
  - *[UNVERIFIED: Gateway Parity]*: Local gateways must maintain complete compatibility with Anthropic SDK message structures and tool streaming deltas.

### 2.3 Approach C: Pure Custom Node.js Agentic Loop

- **Mechanism:** The orchestrator implements a lightweight, native agent loop:
  1. Sends user/task prompt to `http://127.0.0.1:878[7-9]/v1/messages`.
  2. Receives Anthropic SSE stream (`text/event-stream`), emitting tokens to the UI.
  3. When `tool_use` is encountered, executes local sandboxed JavaScript functions (`readFile`, `editFile`, `runCommand`).
  4. Appends `tool_result` to history and repeats until `stop_reason === 'end_turn'`.
- **Strengths:**
  - **Direct Protocol Control:** 100% control over headers and payload shapes. Bypasses client SDK assumptions and can adapt dynamically to Google, OpenAI, or Zen proxy idiosyncrasies.
  - **Zero Startup Latency:** In-process, near-zero startup time (<5ms) and tiny memory footprint.
  - **Effortless Multi-Port Routing:** Trivial to route planning turns to port 8789 (Codex) and worker turns to port 8788 (Antigravity) within the same conversation loop.
- **Trade-Offs & Unknowns:**
  - Requires writing and maintaining custom file-patching, line-number tracking, diff generation, and context truncation logic.
  - *[UNVERIFIED: Custom Patch Robustness]*: Custom file editing tools may be more brittle on large files than Claude Code's mature internal file-patching engine.

### 2.4 Empirical Compatibility Spike Specification (`TSK-SPIKE-HARNESS-PARITY`)

Rather than deciding based on assumptions, Milestone 1 schedules a preliminary offline experiment (`TSK-SPIKE-HARNESS-PARITY`):

1. **Step 1: CLI Version & Invocability Audit:**
   Run read-only verification on the installed host binary:
   - `claude --version` (verified: `2.1.231`).
   - Validate that flags `--print`, `--output-format stream-json`, `--bare`, `--permission-mode dontAsk`, `--permission-prompts none` are supported.
2. **Step 2: Mock Gateway Smoke Test (Zero Live Calls):**
   - Spin up an offline mock HTTP server on `127.0.0.1:9876` replaying Anthropic SSE fixtures (from `test/anthropic-sse.test.mjs`).
   - Spawn `claude -p "smoke test" --bare --output-format stream-json --permission-mode dontAsk` pointing `ANTHROPIC_BASE_URL="http://127.0.0.1:9876"`.
   - Verify that `claude` connects, parses SSE, emits valid NDJSON (`system/init`, `stream_event`, `result`), and exits `0`.
3. **Step 3: Gateway Integration Test with Mock Upstream:**
   - Spin up local gateway (`codex-gateway.mjs` or `antigravity-gateway.mjs`) with mocked upstream HTTP responses.
   - Execute a complete `tool_use` -> `tool execution` -> `tool_result` -> `final turn` cycle.
   - Verify structured streaming, permission denial handling, cancellation (`SIGINT` / `SIGTERM`), timeouts, and route pinning.
4. **Pass/Fail Decision Criteria:**
   - **PASS Criteria:** Claude Code completes the full mock tool cycle with NDJSON streaming and clean exit `0`. -> *Select Approach A for Worker Harness.*
   - **FAIL Criteria:** Claude Code crashes on headers, hangs on stdin/stdout, or refuses non-standard base URLs. -> *Select Approach C (Custom Loop) for Worker Harness.*
5. **Limitations of Mocked Spike:**
   - Mocked tests verify CLI flag compatibility, stream parsing, and gateway handshake.
   - Mocked tests **cannot** establish live-provider nuances (e.g. Gemini 3.8 thinking block handling, real upstream quota resets, or live token refresh under network latency).

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
│       - Git Worktree Manager                - Execution Boundary Controller            │
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

## 4. Git Worktree Isolation vs. Concrete Execution Boundaries

Claude-Zen strictly distinguishes **Git working-copy isolation** from **execution security**:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Git Working-Copy Isolation (Repository State Protection)                                │
│  - Dedicated feature branch: git branch zen/<feature-slug>                              │
│  - Isolated task worktree: git worktree add .zen-worktrees/<task-id> zen/<feature-slug> │
│  - Benefit: User's active branch checkout (e.g. main) is NEVER touched or dirtied.      │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Concrete Execution Security & Sandboxing Boundary (Host Process Protection)             │
│  - Proposal A (Advanced): Container / OS Isolation (Docker / rootless podman / sandbox) │
│  - Proposal B (Milestone 1 Default): Cooperative Trusted-Local Mode with explicit limits│
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Git Worktree Isolation Lifecycle (Milestone 1)
1. **Branch Provisioning:** When a feature baseline is approved, the orchestrator creates `zen/<feature-slug>` from the base commit SHA.
2. **Task Worktree Creation:** When a task enters `In Progress`, the orchestrator runs:
   ```bash
   git worktree add -b zen/task/<task-id> .zen-worktrees/<task-id> zen/<feature-slug>
   ```
3. **Execution Confinement:** The worker agent's tools are pointed exclusively to `.zen-worktrees/<task-id>` as their root.
4. **Gitdir Pointer Protection:** In Git worktrees, `.git` is a file pointing to the main repo's `.git/worktrees/<task-id>`. The orchestrator prevents agent tools from reading or writing `.git` directly.
5. **Preservation on Interruption:** If a task is interrupted, cancelled, or fails, the worktree is **never force-deleted**. It remains preserved on disk until explicitly reconciled or discarded by the owner.
6. **Teardown & Cleanup:** When the task is successfully integrated via fast-forward merge into the feature branch:
   ```bash
   git worktree remove --force .zen-worktrees/<task-id>
   git worktree prune
   ```

### 4.2 Concrete Execution Security Boundaries

Command allowlists, `cwd`, and environment variables alone **do not** confine arbitrary child-process code (e.g. `npm test` can execute arbitrary binary code, read host files, or spawn subprocesses). We define two clear, distinct proposals:

#### Proposal A: Containerized / OS-Isolated Execution (Advanced Tier)
- **Mechanism:** Worker and test commands execute inside an isolated container (Docker, rootless Podman, or Linux namespaces via `bubblewrap`). On macOS, executes under an explicit `sandbox-exec` profile.
- **Filesystem:** Host filesystem is mounted read-only, except for `.zen-worktrees/<task-id>` which is mounted read-write. Main `.git` directory is completely unmounted; git metadata is accessed via a read-only gitdir stub.
- **Credentials:** Zero host credentials mounted into container.
- **Network:** Gateway connectivity to `127.0.0.1:8787-8789` permitted via host networking; external WAN egress blocked (`--network none` or packet filter), requiring dependencies to be pre-installed or mirrored.

#### Proposal B: Cooperative Trusted-Local Execution (Milestone 1 Default)
- **Context & Premise:** Recommended for Milestone 1 on single-user workstations where Docker setup overhead is avoided. The owner explicitly trusts local project scripts, but requires strong defense-in-depth against accidental damage.
- **Concrete Protections:**
  1. **Node.js Tool Path Confinement:** `assertPathWithinWorktree` resolves realpaths and blocks file tool traversal outside `.zen-worktrees/<task-id>`.
  2. **Credential Stripping:** `process.env` passed to spawned child processes is sanitized, stripping all API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), cloud tokens, and parent session secrets.
  3. **Process Groups & Resource Limits:** Child processes are spawned in new process groups (`setpgid: true`). Every command has a hard timeout (`[PROPOSAL: 120s]`). On expiration, the entire process tree is terminated (`SIGTERM` -> 5s -> `SIGKILL`).
  4. **Command Allowlist:** Only standard build/test runners (`npm`, `pytest`, `cargo`, `go`) and git status tools are permitted. Shell interpreters (`sh -c`, `eval`, `sudo`) are blocked.
  5. **Network Policy:** Test runners are encouraged to run offline (`npm test --offline`) where supported. Gateways listen on `127.0.0.1:8787-8789` and are reached directly by the orchestrator, not child test scripts.
  6. **Explicit Limitations:** On host execution, malicious or rogue test scripts could theoretically read host files readable by the user. Users requiring untrusted code execution must run Claude-Zen in a VM or dedicate a non-root user.

---

## 5. Normalized State Model & Lifecycle Transitions

To eliminate state conflation, the orchestrator architecture decouples four distinct domains:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                Normalized State Domains                                │
├─────────────────────────┬───────────────────────────────┬──────────────────────────────┤
│ Domain                  │ Database Location             │ Allowed Values / Types       │
├─────────────────────────┼───────────────────────────────┼──────────────────────────────┤
│ 1. Task Status          │ tasks.status                  │ Backlog, Ready, In Progress, │
│    (Product Stages)     │                               │ Automated Checks,            │
│                         │                               │ Code Review, QA, Done,       │
│                         │                               │ Blocked, Cancelled           │
├─────────────────────────┼───────────────────────────────┼──────────────────────────────┤
│ 2. Run Status           │ task_runs.status              │ PENDING, RUNNING, VERIFYING, │
│    (Execution Attempt)  │                               │ REVIEWING, COMPLETED,        │
│                         │                               │ FAILED, ABORTED              │
├─────────────────────────┼───────────────────────────────┼──────────────────────────────┤
│ 3. Blocker Reason       │ tasks.blocked_reason          │ NULL, DEPENDENCIES_UNMET,    │
│    (Waiting Cause)      │                               │ REPAIR_LIMIT_EXCEEDED,       │
│                         │                               │ SPECIALIST_UNAVAILABLE,      │
│                         │                               │ BUDGET_EXCEEDED,             │
│                         │                               │ RECONCILIATION_REQUIRED,     │
│                         │                               │ INTEGRATION_CONFLICT,        │
│                         │                               │ OWNER_CHANGES_REQUESTED      │
├─────────────────────────┼───────────────────────────────┼──────────────────────────────┤
│ 4. Review Verdict       │ review_records.verdict        │ APPROVE, CHANGES_REQUESTED   │
├─────────────────────────┼───────────────────────────────┼──────────────────────────────┤
│ 5. Acceptance Record    │ acceptance_records            │ candidate_commit_sha,        │
│                         │                               │ accepted_by, accepted_at,    │
│                         │                               │ integrated_commit_sha        │
└─────────────────────────┴───────────────────────────────┴──────────────────────────────┘
```

### 5.1 Visible Product Stages State Machine

```
                  ┌──────────────┐
                  │   Backlog    │
                  └──────┬───────┘
                         │ (All blockedBy tasks status = 'Done')
                         ▼
                  ┌──────────────┐
                  │    Ready     │
                  └──────┬───────┘
                         │ (Orchestrator claims task, provisions worktree)
                         ▼
                  ┌──────────────┐
       ┌─────────▶│ In Progress  │◀─────────┐
       │          └──────┬───────┘          │
       │                 │ (Worker requests verification; candidate snapshot taken)
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
       │          │      QA      │ (Owner Acceptance)
       │          └──────┬───────┘
       │                 │ (Owner accepts in UI -> Fast-Forward Merge)
       │                 ▼
       │          ┌──────────────┐
       │          │     Done     │
       │          └──────────────┘
       │
       │ (Exceeds repair limit / Unreconciled crash / Integration conflict)
       ▼
┌──────────────┐                     ┌──────────────┐
│   Blocked    │                     │  Cancelled   │
│(Owner assist)│                     │(Owner cancel)│
└──────────────┘                     └──────────────┘
```

### 5.2 Transition Authority & Evidence Rules

| Current Stage | Target Stage | Authority | Required Verifiable Evidence |
| :--- | :--- | :--- | :--- |
| **`Backlog`** | **`Ready`** | DAG Scheduler | Every task ID in `blockedBy` has `tasks.status = 'Done'`. |
| **`Ready`** | **`In Progress`** | Task Dispatcher | Single active writer rule holds. Task worktree `.zen-worktrees/<task-id>` successfully provisioned. `task_runs` record created with status `RUNNING`. |
| **`In Progress`** | **`Automated Checks`** | Worker Agent | Worker calls `request_verification`. Orchestrator stages `scope_paths` and commits `candidate_commit_sha`. |
| **`Automated Checks`** | **`In Progress` (Repair)** | Verifier Engine | Tests exit != 0 AND `repair_attempts < max_repairs`. Failure logs injected into worker. `tasks.blocked_reason = 'REPAIR_ATTEMPT'`. |
| **`Automated Checks`** | **`Blocked`** | Verifier Engine | Tests exit != 0 AND `repair_attempts >= max_repairs`. `tasks.blocked_reason = 'REPAIR_LIMIT_EXCEEDED'`. |
| **`Automated Checks`** | **`Code Review`** | Verifier Engine | Tests exit 0 AND zero tracked files modified during test execution. `verification_digest` recorded. |
| **`Code Review`** | **`In Progress`** | Specialist Reviewer | Specialist outputs verdict `CHANGES_REQUESTED`. Findings attached to task run. |
| **`Code Review`** | **`QA`** | Specialist Reviewer | Specialist outputs verdict `APPROVE`. `review_records` created. |
| **`Code Review`** | **`Blocked`** | Orchestrator | Specialist reviewer model unavailable across all configured accounts. `tasks.blocked_reason = 'SPECIALIST_UNAVAILABLE'`. (Never bypassed). |
| **`QA`** | **`Done`** | Human Owner + Git | Owner clicks **Accept** in UI. Orchestrator runs `git merge --ff-only zen/task/<task-id>` into `zen/<feature-slug>`. On success: task status -> `Done`, worktree pruned. |
| **`QA`** | **`Blocked`** | Git Integration | Fast-forward merge fails (feature branch shifted). `tasks.blocked_reason = 'INTEGRATION_CONFLICT'`. Worktree preserved. |
| **`QA`** | **`In Progress`** | Human Owner | Owner clicks **Request Changes** with correction notes. |
| **Any Stage** | **`Cancelled`** | Human Owner | Owner clicks **Cancel**. Process tree terminated; worktree preserved for owner inspection. |

---

## 6. One Git, Verification, and Acceptance Lifecycle

The lifecycle follows one consistent, watertight sequence:
`Task base → candidate snapshot → automated verification → specialist review → owner acceptance → fast-forward integration into feature branch → Done`.

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

### 6.1 Cleanliness & Artifact Integrity Rules
1. **Candidate Commits are Immutable:** Acceptance references the existing `candidate_commit_sha`. The system **never** re-stages files or creates replacement commits upon acceptance.
2. **Tracked File Dirtiness Fails Verification:** If automated tests modify any tracked git file (outside `.gitignore`), verification immediately fails with `E_VERIFICATION_DIRTIED_WORKING_TREE`. Tests must write caches to gitignored paths.
3. **Unexpected Untracked Files:** Untracked files generated outside `scope_paths` and not matching `.gitignore` are flagged. The worker must clean them or add them to `.gitignore` before candidate creation.
4. **Rebase Requires Fresh Verification:** If integration cannot fast-forward and requires a rebase, the new commit SHA must undergo full automated verification and specialist review.

---

## 7. Non-Destructive Recovery & Cancellation Engine

The orchestrator guarantees that **unfinished work is never automatically destroyed**.

### 7.1 Process Ownership & Identity
Before signaling any OS process, the orchestrator verifies process identity:
- Records: `process_pid`, `process_start_time` (from `/proc/<pid>/stat` or OS ps), and `process_cmdline`.
- When signaling (timeout, cancellation, restart):
  1. Inspects whether the PID exists (`kill(pid, 0)`).
  2. Verifies that the PID's start time matches the recorded start time (preventing accidental signals to recycled OS PIDs).
  3. Sends `SIGTERM` to the process group (`-pid`). Waits 5 seconds; if still running, sends `SIGKILL`.

### 7.2 Why Heartbeat Expiry Does Not Prove Process Death
A worker agent or test suite may miss heartbeat updates due to:
- Long test suite execution (e.g. end-to-end integration test taking 4 minutes).
- Heavy CPU compilation or memory swapping.
- Extended LLM thinking turn latency on complex reasoning models.
Therefore, **heartbeat expiry alone NEVER triggers worktree deletion or task reset**. It triggers a status inquiry: probe whether the process group is actively consuming CPU/running. If running, the lease is extended; if verified dead, reconciliation begins.

### 7.3 Boot-Time Reconciliation Protocol
Upon orchestrator boot after a crash or power failure:
1. **Probe Active Runs:** Query `task_runs` where status IN (`RUNNING`, `VERIFYING`, `REVIEWING`).
2. **Process Liveness:** Check recorded PIDs. If any process survived the restart, terminate it gracefully.
3. **Reconcile Git Locks:** Inspect worktree directories for `index.lock` or worktree locks. Clear locks only after verifying that no process holds the file handle.
4. **Preserve Workspace:** Inspect git status (`git status --porcelain`) in `.zen-worktrees/<task-id>`.
   - If dirty: **DO NOT DELETE**. Stash changes or create a checkpoint commit on `refs/zen/recovery/<task-id>-<timestamp>`.
   - Transition task to `Blocked` with reason `RECONCILIATION_REQUIRED`.
   - Display a notification in the UI allowing the owner to view the preserved diff and decide whether to resume, rebase, or discard.
5. **Clean Worktree Pruning:** Pruning (`git worktree remove`) is executed **only** on worktrees whose tasks have `status = 'Done'` and whose commits are verified merged into the feature branch.

---

## 8. Configurable Model Strategy & Quota Failover

All model allocations are dynamic and configurable in SQLite / settings:

| Role | Default Config | Supported Options | Fallback / Exhaustion Policy |
| :--- | :--- | :--- | :--- |
| **Planner / Architect** | Strong Model (Claude 3.7 Sonnet Thinking via Antigravity OR GPT-5.6-sol via Codex) | Any provider model supporting multi-turn chat | Attempt configured fallback strong model in pool. If exhausted: task pauses with `BLOCKED` (`SPECIALIST_UNAVAILABLE`). |
| **Worker / Implementer** | Fast Bounded Worker (Gemini 3.8 Flash via Antigravity) | Configured Worker Model (Codex, Antigravity, OpenCode Zen) | Rotate across accounts in pool. Fallback to alternative fast models. |
| **Automated Verifier** | Pure Deterministic Code (No LLM) | Command string, timeout, env | N/A (runs local test runners). |
| **Specialist Reviewer** | Strong Model (Claude 3.7 Sonnet Thinking via Antigravity OR GPT-5.6-sol via Codex) | Any high-reasoning model supporting diff analysis | **STRICT RULE:** Must remain in `Code Review` with blocker reason `SPECIALIST_UNAVAILABLE`. Never downgrade review to worker tier or bypass. |

---

## 9. Token & Cost Governance Engine

All numerical limits are proposals (`[PROPOSAL: ...]`) requiring owner confirmation.

### 9.1 Observed vs. Estimated Token Usage
1. **Observed Usage:** Exact token counts reported by upstream provider APIs (Google Cloud Code `promptTokenCount`, OpenAI `usage.prompt_tokens`) are recorded as canonical.
2. **Estimated Usage:** When streaming or when an upstream proxy omits token metrics (e.g. some OpenCode routes), the orchestrator calculates heuristic token usage (`Math.ceil(characterCount / 4)`) and tags the record in SQLite with `is_estimated = 1`.
3. **Limits That Cannot Be Enforced Exactly:** Because LLM token consumption is only known after streaming completes, token ceilings act as hard turn-stop thresholds rather than instantaneous per-word cutoffs.

### 9.2 Budget Ceilings & Exhaustion
- **Proposed Ceilings:**
  - Feature Budget: `[PROPOSAL: 500,000 tokens]`
  - Single Task Budget: `[PROPOSAL: 150,000 tokens]`
  - Dedicated Specialist Reviewer Budget: `[PROPOSAL: 80,000 tokens]`
- **Exhaustion Handling:**
  - When cumulative task usage reaches `[PROPOSAL: 90%]`, a warning is emitted in the UI.
  - When usage reaches `100%`, execution halts immediately. The task transitions to `Blocked` with reason `BUDGET_EXCEEDED` and requires an explicit owner budget increase to resume.

---

## 10. Persistence Schema & Versioned Migrations

All control-plane state is persisted in `~/.zen-claude/zen-orchestrator.sqlite` using Node.js native `DatabaseSync` in WAL mode.

### 10.1 Versioned Migrations Table
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

### 10.2 Relational Data Model

```
┌──────────────┐       ┌────────────────────────┐       ┌──────────────┐
│   projects   │───1:N─▶│ requirements_baselines │───1:N─▶│  milestones  │
└──────────────┘       └────────────────────────┘       └──────┬───────┘
                                                               │
                                                              1:N
                                                               ▼
┌────────────────────┐ ┌────────────────────────┐       ┌──────────────┐
│ acceptance_records │ │       task_runs        │◀──1:N─│    tasks     │
└────────────────────┘ └───────────┬────────────┘       └──────────────┘
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
4. **`tasks`**: `id`, `milestone_id`, `title`, `description`, `scope_paths_json`, `status` (`Backlog`, `Ready`, `In Progress`, `Automated Checks`, `Code Review`, `QA`, `Done`, `Blocked`, `Cancelled`), `blocked_by_json`, `blocked_reason`, `worktree_path`, `repair_attempts`, `max_repairs` (default 3), `created_at`, `updated_at`.
5. **`task_runs`**: `id`, `task_id`, `role`, `model`, `provider`, `account_email`, `input_tokens`, `output_tokens`, `is_estimated`, `base_commit_sha`, `candidate_commit_sha`, `diff_digest`, `started_at`, `completed_at`, `status` (`PENDING`, `RUNNING`, `VERIFYING`, `REVIEWING`, `COMPLETED`, `FAILED`, `ABORTED`).
6. **`verification_results`**: `id`, `task_run_id`, `command`, `exit_code`, `output_log`, `verification_digest`, `environment_info_json`, `passed`, `executed_at`.
7. **`review_records`**: `id`, `task_run_id`, `candidate_commit_sha`, `verdict` (`APPROVE`, `CHANGES_REQUESTED`), `summary`, `findings_json`, `reviewed_at`.
8. **`acceptance_records`**: `id`, `task_id`, `candidate_commit_sha`, `accepted_by`, `accepted_at`, `integrated_commit_sha`, `integrated_at`.
9. **`audit_logs`**: `id`, `project_id`, `event_type`, `actor`, `details_json`, `timestamp`.
