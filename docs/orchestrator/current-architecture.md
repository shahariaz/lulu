# Current Orchestrator Architecture

## Setup

```bash
npm install          # required: the orchestrator's HTTP layer depends on Hono
npm test             # 200+ tests
node bin/zen-orchestrator
```

The **gateways** (`zen-proxy.mjs`, `codex-gateway.mjs`, `antigravity-gateway.mjs`) remain
dependency-free and run from a bare checkout — only the orchestrator needs `npm install`.


The orchestrator is a local modular monolith. It deploys as one Node process and one SQLite
database, but its HTTP transport is grouped by product capability instead of one route switch.

## Boundaries

```text
React cockpit
    │ HTTP + SSE
    ▼
Hono composition root              lib/orchestrator/api.mjs
    ├── Projects                    features/projects/routes.mjs
    ├── Product design             features/product-design/routes.mjs
    ├── Planning                    features/planning/routes.mjs
    └── Delivery                    features/delivery/routes.mjs
              │
              ▼
Framework-free engines             *-engine.mjs, dag-scheduler.mjs
              │
              ▼
Storage port / SQLite adapter       db/repository.mjs, db/index.mjs
```

Hono owns request parsing, origin policy, status codes, errors, static UI delivery, and SSE.
Feature route modules adapt HTTP data to existing application/domain functions. The engines do
not import Hono and can be called directly by tests, CLI workflows, or a future transport. The
event bus is transport-neutral; the Hono SSE endpoint is one subscriber.

## Feature ownership

- **Projects:** repository registration and inspection, workspace projection, autonomy policy,
  and owner-triggered feature integration.
- **Product design:** durable Council and Architect conversations, sourced market research,
  blueprint synthesis, PRD baselines, and requirement impact.
- **Planning:** epics, features, tasks, sprints, dependency planning, and the currently
  advisory-only swarm schedule.
- **Delivery:** task worktrees, worker execution, verification, independent review, visual QA,
  container previews, and acceptance.

## Trust rules

- Specification approval is always an owner action.
- Model, research, review, and visual-QA outages fail closed.
- Worker and verifier execution are container-first. Preview execution is also container-first;
  host previews require the explicit `ZEN_PREVIEW_TIER=host` development override.
- Guided, Supervised, and Autonomous use the same task state machine. The persisted mode changes
  only whether Ready → In Progress and QA → Done may happen automatically.
- Parallel execution remains deferred until the documented transaction and worker-pool gaps are
  closed. The UI reports scheduling decisions but does not imply that they execute.
