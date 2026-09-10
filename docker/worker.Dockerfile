# Claude-Zen worker execution tier.
#
# This image is where agent-written code actually executes. Running the worker on the host
# means an unsupervised agent with Bash access can read ~/.ssh, ~/.aws and ~/.codex — see
# docs/orchestrator/architecture-review.md:58. Inside this container it can reach only the
# task's git worktree.
#
# Build:  npm run build:worker-image
# Uses:   lib/orchestrator/worker-harness.mjs when ZEN_EXECUTION_TIER=container (the default)
#
# NOTE ON CREDENTIALS: none are baked in, deliberately. The worker receives
# ANTHROPIC_BASE_URL (pointing at the host's local gateway) and a placeholder
# ANTHROPIC_API_KEY at run time. The CLI never contacts Anthropic — it speaks the Anthropic
# Messages API at our gateway, which fans out to the owner's pooled subscriptions. That
# indirection is the entire cost model; do not add a real key here.

FROM node:24-slim

# git is required: the worker commits its own candidate snapshot.
# ca-certificates so the CLI can talk to the gateway over TLS if it is ever fronted by one.
# ripgrep because Claude Code's search tooling uses it and falls back slowly without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Pin the CLI. An unpinned image means a silent CLI upgrade can change worker behaviour
# without any commit in this repo — test/harness-compat-spike.test.mjs pins the flag contract
# on the host side, and this pins it on the container side.
ARG CLAUDE_CODE_VERSION=2.1.231
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# git refuses to operate on a repository owned by a different uid. The worktree is bind-mounted
# from the host and owned by the host user, so mark all paths safe rather than chown-ing the
# owner's files. Written to the system-wide config so it applies to whatever --user we run as.
RUN git config --system --add safe.directory '*'

# Non-root by default. worker-harness.mjs overrides --user with the host uid:gid that owns the
# worktree, so commits are not created as root on Linux.
USER node

# No ENTRYPOINT: the orchestrator supplies the full command (the claude CLI invocation, or a
# verification command such as `npm test`).
CMD ["bash"]
