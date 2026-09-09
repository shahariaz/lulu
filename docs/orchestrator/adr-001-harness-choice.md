# Architecture Decision Record (ADR-001): Worker Harness Engine Selection

**Status:** Accepted  
**Date:** 2026-09-10  
**Context:** Milestone 1 Task `TSK-M1-05` (Offline Harness Compatibility Spike)  
**Governing Task:** `TSK-M1-06` (Sandboxed Worker Execution Engine)  

---

## 1. Context & Problem Statement

The orchestrator needs to drive the Worker Agent during implementation tasks. The Worker Agent must receive a task prompt, edit local files inside a git worktree, execute test/build commands, and report completion.

We evaluated three architectural approaches:
- **Approach A:** Spawning headless Claude Code CLI (`claude -p "<prompt>" --bare --output-format stream-json --verbose --permission-mode dontAsk --tools "Read,Edit,Write,Bash"`).
- **Approach B:** Using `@anthropic-ai/claude-agent-sdk` or `@anthropic-ai/sdk` `toolRunner`.
- **Approach C:** A custom in-process Node.js agentic loop calling local gateway `/v1/messages` directly with custom-coded tool functions.

Before committing to an implementation, we executed the offline experiment `TSK-SPIKE-HARNESS-PARITY` (`test/harness-compat-spike.test.mjs`) against a local mock server replaying Anthropic SSE fixtures to gather empirical evidence without live provider calls.

---

## 2. Empirical Spike Results

The experiment ran 3 automated test phases on host environment (Node.js v24.19.0, Claude Code 2.1.231):

1. **CLI Binary & Option Verification:**
   - Confirmed `claude` 2.1.231 is installed and executable on PATH.
   - Confirmed `--print`, `--output-format stream-json`, `--verbose`, `--bare`, `--permission-mode dontAsk`, and `--tools` are supported.
   - *Discovery:* `--permission-prompts` is not present in 2.1.231 (added in v2.1.259+); omitting it allows clean execution.
2. **Structured NDJSON Streaming:**
   - Verified that `claude` connects to custom `ANTHROPIC_BASE_URL`.
   - *Discovery:* Claude Code sends `HEAD /api/hello` on startup to verify connectivity. Endpoints must respond with 200 OK.
   - *Discovery:* `--output-format=stream-json` strictly requires `--verbose`.
   - Verified stdout emits typed NDJSON events: `system` (`subtype: init`), `stream_event`, `assistant`, and `result`.
   - Verified exit code `0` on successful completion.
3. **Multi-Turn Tool Execution Cycle:**
   - Replayed an Anthropic SSE stream containing `content_block_start` (`type: "tool_use"`, `id: "call_read_01"`, `name: "Read"`) and `content_block_delta` (`type: "input_json_delta"` with file path).
   - Claude Code executed its internal `Read` tool in `dontAsk` mode, read the target file, and sent `tool_result` back on Turn 2.
   - Mock server sent final completion text; Claude Code exited `0`.

---

## 3. Decision

1. **Worker Engine (`TSK-M1-06`):**
   - Implement **Approach A (Headless Claude Code CLI)** as the primary coding engine for the worker agent in Milestone 1.
   - **Rationale:** Claude Code provides mature, robust multi-file patching, fuzzy search, line-number tracking, and token compaction out of the box. The spike proved that in `--bare --output-format stream-json --verbose --permission-mode dontAsk` mode, it executes tools headlessly and emits structured NDJSON events without scraping console text.
   - **Gateway Compatibility Requirement:** The local gateways (`codex-gateway.mjs`, `antigravity-gateway.mjs`, `zen-proxy.mjs`) must handle `HEAD /api/hello` and return 200 OK.
   - **Resilience Fallback:** If the `claude` CLI binary is not found on PATH or encounters gateway protocol errors, the worker harness provides an in-process fallback loop calling `/v1/messages` directly with worktree-confined file tools.
2. **Planner / Architect & Specialist Reviewer:**
   - Use **In-Process Custom API Loop (Approach C)** calling local gateway `/v1/messages` directly.
   - **Rationale:** Planning and Reviewing do not require local file-patching or shell execution harnesses; they require pure structured conversation, markdown generation, and diff analysis. In-process HTTP streaming avoids subprocess spawn overhead and provides instant token streaming to the browser UI.

---

## 4. Consequences

- **Positive:** Reuses Claude Code's sophisticated code-editing algorithms; process crashes or infinite loops in worker scripts are isolated to the child process; streaming events are typed NDJSON.
- **Negative:** Requires ~200ms subprocess spawn latency per worker turn.
- **Risk Mitigation:** The orchestrator wraps child process execution with process group timeouts (`120s`), working directory isolation (`.zen-worktrees/<task-id>`), and sanitized environment variables.
