import { randomUUID } from 'node:crypto'
import { computeSpecDigest } from './spec-engine.mjs'

export const COUNCIL_PERSONAS = {
  pm: {
    id: 'pm',
    title: 'Chief Product Officer (PM)',
    badge: 'Strategy & Market',
    color: '#38bdf8', // sky
    avatar: '💡',
    systemPrompt: `You are the Chief Product Officer for an enterprise software studio.
Your role is to validate product ideas, evaluate market fit, analyze competitors, uncover customer pain points, and define a clear value proposition.
When answering:
- Highlight market opportunities and competitive differentiators.
- Structure feature sets using MoSCoW prioritization (Must-Have, Should-Have, Could-Have).
- Focus on high ROI, enterprise viability, and customer adoption.`,
  },
  designer: {
    id: 'designer',
    title: 'Staff Product & UX Designer',
    badge: 'UX & Design Systems',
    color: '#ec4899', // pink
    avatar: '🎨',
    systemPrompt: `You are a Staff Product & UX Designer specializing in enterprise developer platforms and sleek, high-polish interfaces (inspired by Linear, Vercel, and Stripe).
Your role is to map user journeys, define intuitive visual hierarchy, specify design tokens, and eliminate user friction.
When answering:
- Break workflows into step-by-step user journeys (Actor, Trigger, Action, State, Outcome).
- Define component hierarchies, layout breakpoints, and micro-interactions.
- Prioritize accessibility (WCAG AAA), keyboard navigation, and minimalist elegance.`,
  },
  architect: {
    id: 'architect',
    title: 'Principal Systems Architect',
    badge: 'Architecture & Schema',
    color: '#58a6ff', // blue
    avatar: '🏛️',
    systemPrompt: `You are the Principal Systems Architect for mission-critical enterprise platforms.
Your role is to design resilient topologies, relational schemas (PostgreSQL / SQLite), performant API contracts, and security boundaries.
When answering:
- Define database ERDs with explicit tables, primary/foreign keys, column data types, and index strategies.
- Specify RESTful and SSE API contracts with request/response JSON schemas.
- Ensure strict isolation, horizontal scalability, and zero-trust security.`,
  },
  pjm: {
    id: 'pjm',
    title: 'Director of Agile Delivery (PjM)',
    badge: 'Roadmap & Phasing',
    color: '#a855f7', // purple
    avatar: '📅',
    systemPrompt: `You are the Director of Agile Delivery and Project Management.
Your role is to translate product designs and architecture into lean, phased delivery roadmaps with verifiable milestones and dependency-ordered tasks.
When answering:
- Break projects into Phase 1 (MVP Foundation), Phase 2 (Core Workflows), and Phase 3 (Enterprise Scale).
- Define atomic tasks with explicit file blast radius (scope_paths) and dependency chains (blocked_by).
- Identify project risks, technical debt risks, and velocity blockers.`,
  },
  council: {
    id: 'council',
    title: 'Product Design Council',
    badge: 'Executive Synthesis',
    color: '#10b981', // emerald
    avatar: '🌐',
    systemPrompt: `You are the Executive Product Design Council for Claude-Zen, bringing together Product Strategy, UX Design, Systems Architecture, and Delivery Management.
Collaborate to synthesize ideas into cohesive, world-class enterprise software blueprints.`,
  },
}

// In-memory active council conversation sessions
const councilSessions = new Map() // sessionId -> CouncilSession

/**
 * Parse mention tags from user input (@pm, @designer, @architect, @pjm).
 */
export function parseMentionTarget(text = '') {
  const lower = text.toLowerCase()
  if (lower.includes('@pm') || lower.includes('@product')) return 'pm'
  if (lower.includes('@designer') || lower.includes('@ux')) return 'designer'
  if (lower.includes('@architect') || lower.includes('@arch') || lower.includes('@tech')) return 'architect'
  if (lower.includes('@pjm') || lower.includes('@project') || lower.includes('@delivery')) return 'pjm'
  return 'council'
}

/**
 * Start an enterprise Product Design Council session.
 */
export function startCouncilSession({
  sessionId = null,
  projectName = '',
  ideaDescription = '',
  targetPersona = 'developers',
}) {
  const id = sessionId || `council_${randomUUID().slice(0, 12)}`
  const session = {
    id,
    projectName,
    ideaDescription,
    targetPersona,
    messages: [],
    blueprint: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  // Initial welcome turn from Council
  const introMessage = {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: 'assistant',
    agent: COUNCIL_PERSONAS.council,
    content: `Welcome to the **Claude-Zen Product Design Council**. We are your dedicated executive team:

- **💡 @pm**: Market validation, competitor analysis, feature prioritization.
- **🎨 @designer**: Step-by-step user journeys, design systems, Linear-style UX.
- **🏛️ @architect**: Relational database ERD, API contracts, tech stack.
- **📅 @pjm**: Delivery roadmap, MVP scoping, dependency-ordered tasks.

Tell us about your new project idea, or @mention any specialist directly!`,
    timestamp: Date.now(),
  }
  session.messages.push(introMessage)

  councilSessions.set(id, session)
  return session
}

/**
 * Add message and execute a turn with the appropriate council agent.
 */
export async function executeCouncilTurn({
  sessionId,
  userMessage,
  forcedRole = null,
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  mockReply = null,
}) {
  const session = councilSessions.get(sessionId)
  if (!session) throw new Error(`Council session not found: ${sessionId}`)

  const targetRole = forcedRole || parseMentionTarget(userMessage)
  const persona = COUNCIL_PERSONAS[targetRole] || COUNCIL_PERSONAS.council

  const userMsgRecord = {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: 'user',
    content: userMessage,
    targetRole,
    timestamp: Date.now(),
  }
  session.messages.push(userMsgRecord)

  let replyText = ''

  if (mockReply) {
    replyText = mockReply
  } else {
    // Attempt live call to local gateway with agent persona
    try {
      const messagesPayload = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const res = await fetch(`${gatewayUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'local-antigravity',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: persona.systemPrompt,
          messages: messagesPayload,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        const textBlock = (data.content || []).find((b) => b.type === 'text')
        if (textBlock?.text) replyText = textBlock.text
      }
    } catch {}

    // Fallback response if gateway is offline
    if (!replyText) {
      if (targetRole === 'pm') {
        replyText = `**[CPO Strategy Analysis]**: Based on your requirements, the core value proposition centers on high reliability and local data sovereignty. Key competitors in this space charge monthly SaaS fees, giving us a major differentiator. Recommended MVP: Focus on the primary workflow and defer complex multi-tenant billing to v2.`
      } else if (targetRole === 'designer') {
        replyText = `**[UX Design System]**: For an enterprise-grade experience, we recommend a Linear-inspired dark theme (#090d13 background with subtle 1px glass borders). Primary User Journey: 1. Instant onboarding &rarr; 2. Workspace initialization &rarr; 3. Live dashboard with keyboard shortcuts.`
      } else if (targetRole === 'architect') {
        replyText = `**[Systems Architecture & Schema]**: Recommended topology: Node.js 24 + TypeScript with SQLite WAL (or PostgreSQL) and SSE streaming. Data model requires normalized entities with foreign keys, index optimization, and strict working directory path confinement.`
      } else if (targetRole === 'pjm') {
        replyText = `**[Agile Delivery Roadmap]**: Recommended execution phasing: Phase 1 Foundation (Database schema, basic models) &rarr; Phase 2 Core Engine (User workflows, API routes) &rarr; Phase 3 Polish (Error boundaries, automated tests).`
      } else {
        replyText = `**[Product Council Synthesis]**: The team has analyzed your concept. We have formulated the market positioning, UX journeys, relational schema, and delivery tasks. You can now inspect and approve the complete 5-part Product Blueprint.`
      }
    }
  }

  const agentMsgRecord = {
    id: `msg_${randomUUID().slice(0, 8)}`,
    role: 'assistant',
    agent: persona,
    content: replyText,
    timestamp: Date.now(),
  }
  session.messages.push(agentMsgRecord)
  session.updatedAt = Date.now()

  return {
    session,
    reply: agentMsgRecord,
    targetRole,
  }
}

/**
 * Generate a comprehensive Competitor Teardown & Market Validation report.
 */
export function generateCompetitorTeardown({
  productIdea,
  industryCategory = 'Developer Infrastructure & AI',
  knownCompetitors = [],
}) {
  const defaultCompetitors = knownCompetitors.length > 0 ? knownCompetitors : [
    {
      name: 'Cloud SaaS Alternatives',
      strengths: 'Instant signup, managed cloud infrastructure, team sharing.',
      weaknesses: 'High monthly subscription costs, cloud vendor lock-in, data leaves user premises.',
      ourDifferentiator: '100% self-hosted, private local execution, zero monthly fees, owner data sovereignty.',
    },
    {
      name: 'CLI-Only Developer Agents',
      strengths: 'Fast terminal invocation, direct tool access.',
      weaknesses: 'No visual governance, unconstrained terminal execution, destructive file overwrite risks.',
      ourDifferentiator: 'Verifiable 9-stage delivery board, git worktree isolation, live dev previews, specialist review.',
    },
  ]

  return {
    category: industryCategory,
    productIdea,
    competitors: defaultCompetitors,
    swotAnalysis: {
      strengths: ['Autonomous sequential execution', 'Exact git diff contracts', 'Local privacy'],
      weaknesses: ['Requires local workstation compute'],
      opportunities: ['Enterprise teams demanding self-hosted AI software engineering'],
      threats: ['Rapidly moving proprietary cloud coding assistants'],
    },
    recommendation: 'Position as the premium, privacy-first Autonomous Software Studio for technical owners and enterprise engineers.',
  }
}

/**
 * Synthesize a comprehensive 5-part Product Blueprint ready for implementation.
 */
export function synthesizeProductBlueprint({
  ideaTitle = 'Enterprise Platform',
  ideaDescription = '',
  techStack = 'Node.js 24 + TypeScript + React 18 + PostgreSQL/SQLite',
}) {
  return {
    title: ideaTitle,
    version: 'v1.0.0',
    createdAt: Date.now(),

    // 1. Market & Competitors
    market: {
      targetAudience: 'Technical Founders, Solo Engineers, and Enterprise Engineering Teams',
      coreValueProp: 'Autonomous AI software delivery with architectural discipline, exact git review contracts, and local privacy.',
      competitors: [
        { name: 'Generic Cloud Coding Agents', gap: 'Lack deterministic state machines, worktree isolation, and PRD baseline governance.' },
        { name: 'Monolithic Issue Trackers', gap: 'Disconnected from actual code repositories and automated agent execution.' },
      ],
      uniqueDifferentiators: [
        'Local git worktree isolation preserving developer checkout',
        'Deterministic 9-stage verification state machine',
        'Independent specialist adversarial code review',
      ],
    },

    // 2. Product PRD Specification
    prd: {
      executiveSummary: ideaDescription || 'Enterprise software platform built with autonomous delivery rigor.',
      inScope: ['Core domain models and schema', 'Interactive web interface and PWA', 'Automated unit and integration test suite'],
      outOfScope: ['Multi-tenant SaaS billing (v2)', 'Third-party webhook integrations (v2)'],
      requirements: [
        { id: 'REQ-F-01', title: 'Data Persistence & Domain Entities', priority: 'Must-Have', status: 'Planned' },
        { id: 'REQ-F-02', title: 'Interactive Web Dashboard & Views', priority: 'Must-Have', status: 'Planned' },
        { id: 'REQ-F-03', title: 'Real-Time Event Streaming & Notifications', priority: 'Should-Have', status: 'Planned' },
        { id: 'REQ-NF-01', title: 'Sub-200ms API Response Latency', priority: 'Must-Have', status: 'Planned' },
        { id: 'REQ-NF-02', title: '100% Automated Check Verification', priority: 'Must-Have', status: 'Planned' },
      ],
    },

    // 3. User Journeys & UX Flow
    userJourneys: [
      {
        id: 'journey_1',
        title: 'Project Onboarding & Setup',
        steps: [
          { step: 1, actor: 'Owner', action: 'Connects local git repository or initializes project', outcome: 'Workspace registered' },
          { step: 2, actor: 'System', action: 'Inspects runtime, clean git tree, and test runners', outcome: 'Status verified clean' },
        ],
      },
      {
        id: 'journey_2',
        title: 'Feature Execution & Verification',
        steps: [
          { step: 1, actor: 'Owner', action: 'Approves baseline specification', outcome: 'Task DAG generated' },
          { step: 2, actor: 'Worker Agent', action: 'Implements code in isolated worktree', outcome: 'Candidate commit created' },
          { step: 3, actor: 'Verifier', action: 'Runs automated tests', outcome: 'Tests pass (exit 0)' },
          { step: 4, actor: 'Owner', action: 'Reviews diff & accepts', outcome: 'Fast-forward merged into feature branch' },
        ],
      },
    ],

    // 4. Systems Architecture & Relational Database ERD
    architecture: {
      techStack,
      databaseSchema: {
        engine: 'PostgreSQL / SQLite Compatible',
        tables: [
          {
            name: 'workspaces',
            columns: ['id (UUID PK)', 'name (TEXT)', 'repo_path (TEXT)', 'created_at (TIMESTAMP)'],
          },
          {
            name: 'entities',
            columns: ['id (UUID PK)', 'workspace_id (FK)', 'title (TEXT)', 'status (TEXT)', 'metadata_json (JSONB)'],
          },
          {
            name: 'events_log',
            columns: ['id (UUID PK)', 'entity_id (FK)', 'event_type (TEXT)', 'payload (JSONB)', 'timestamp (TIMESTAMP)'],
          },
        ],
      },
      apiContracts: [
        { method: 'GET', path: '/api/v1/workspaces', description: 'List active workspaces' },
        { method: 'POST', path: '/api/v1/workspaces', description: 'Create or import workspace' },
        { method: 'GET', path: '/api/v1/entities', description: 'List domain entities' },
        { method: 'POST', path: '/api/v1/entities', description: 'Create domain entity' },
      ],
    },

    // 5. Delivery Roadmap & Task DAG
    roadmap: {
      milestones: [
        {
          id: 'ms_foundation',
          title: 'Phase 1: Architecture & Foundation (MVP)',
          tasks: [
            { tempId: 't_m1_1', title: 'Initialize Schema & Domain Models', scopePaths: ['src/db/schema.js'], blockedBy: [] },
            { tempId: 't_m1_2', title: 'Build Core API Controllers', scopePaths: ['src/api/routes.js'], blockedBy: ['t_m1_1'] },
          ],
        },
        {
          id: 'ms_ui',
          title: 'Phase 2: Interactive Interface & Views',
          tasks: [
            { tempId: 't_m2_1', title: 'Implement Dashboard Shell & Navigation', scopePaths: ['src/ui/app.js'], blockedBy: ['t_m1_2'] },
            { tempId: 't_m2_2', title: 'Add Automated Test Verification', scopePaths: ['test/app.test.js'], blockedBy: ['t_m2_1'] },
          ],
        },
      ],
    },
  }
}
