import React, { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Badge } from './ui/Badge'
import { motion, AnimatePresence } from 'framer-motion'
import { Lightbulb, Palette, Landmark, Calendar, Sparkles, Send, ShieldCheck, ArrowRight, CheckCircle2, ChevronRight } from 'lucide-react'

interface IdeaStudioViewProps {
  onProjectInitialized: (project: any) => void
}

type BlueprintTab = 'market' | 'prd' | 'journeys' | 'architecture' | 'roadmap'

export function IdeaStudioView({ onProjectInitialized }: IdeaStudioViewProps) {
  const [activeBlueprintTab, setActiveBlueprintTab] = useState<BlueprintTab>('market')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [inputPrompt, setInputPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [blueprint, setBlueprint] = useState<any>(null)
  const [teardown, setTeardown] = useState<any>(null)

  // Initialization Modal State
  const [showInitModal, setShowInitModal] = useState(false)
  const [targetRepoPath, setTargetRepoPath] = useState('/Users/sar/shahariaz/enterprise-idea')
  const [projectName, setProjectName] = useState('Next-Gen AI Platform')
  const [initLoading, setInitLoading] = useState(false)

  // Start initial council session on mount
  useEffect(() => {
    startSession()
  }, [])

  const startSession = async () => {
    try {
      const res = await fetch('/api/orchestrator/council/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: 'Next-Gen Enterprise Engine',
          ideaDescription: 'Autonomous multi-agent delivery studio for mission-critical software.',
        }),
      })
      const data = await res.json()
      setSessionId(data.session.id)
      setMessages(data.session.messages)

      // Fetch initial synthesized blueprint
      const bpRes = await fetch('/api/orchestrator/council/blueprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ideaTitle: 'Autonomous Enterprise Software Platform',
          ideaDescription: 'Local-first autonomous AI software delivery with git worktrees and deterministic state DAGs.',
        }),
      })
      const bpData = await bpRes.json()
      setBlueprint(bpData.blueprint)

      // Fetch initial competitor teardown
      const tdRes = await fetch('/api/orchestrator/council/teardown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIdea: 'Autonomous Software Engineering Studio',
        }),
      })
      const tdData = await tdRes.json()
      setTeardown(tdData.teardown)
    } catch (err) {
      console.error(err)
    }
  }

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputPrompt).trim()
    if (!text || !sessionId) return
    setInputPrompt('')
    setLoading(true)

    try {
      const res = await fetch('/api/orchestrator/council/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userMessage: text,
        }),
      })
      const data = await res.json()
      setMessages(data.session.messages)
    } catch (err: any) {
      alert(`Council message failed: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleInitProject = async () => {
    if (!targetRepoPath.trim()) return
    setInitLoading(true)
    try {
      const res = await fetch('/api/orchestrator/council/initialize-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: targetRepoPath.trim(),
          projectName: projectName.trim(),
          blueprint,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowInitModal(false)
        onProjectInitialized(data.project)
      }
    } catch (err: any) {
      alert(`Initialization failed: ${err.message}`)
    } finally {
      setInitLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full gap-4 overflow-hidden font-sans">
      {/* Top Banner: Enterprise Product Council Header */}
      <div className="bg-card/70 border border-border/80 rounded-xl p-4 flex items-center justify-between backdrop-blur-md">
        <div className="flex items-center gap-3.5">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-purple-600 flex items-center justify-center text-white shadow-lg">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-foreground tracking-tight">Product Strategy & Idea Studio</h2>
              <Badge variant="ready" className="text-[10px] uppercase tracking-wider">Enterprise Council</Badge>
            </div>
            <p className="text-xs text-muted mt-0.5">
              Collaborate with specialized PM, UX Designer, Systems Architect, and Project Manager agents to design and validate your new idea.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="primary"
            size="md"
            onClick={() => setShowInitModal(true)}
            className="shadow-md shadow-accent/20 flex items-center gap-1.5"
          >
            <span>Approve Blueprint & Launch</span>
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Main Studio Body: Council Dialogue (Left) & 5-Tab Blueprint (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 overflow-hidden">
        {/* Left Column (5 Cols): Product Council Dialogue */}
        <div className="lg:col-span-5 flex flex-col h-full bg-card/50 border border-border/70 rounded-xl overflow-hidden backdrop-blur-sm">
          {/* Council Role Chips Bar */}
          <div className="p-3 border-b border-border/60 bg-black/20 flex items-center justify-between">
            <span className="text-[11px] font-bold text-muted uppercase tracking-wider">Active Advisors</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setInputPrompt('@pm ')}
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/30 hover:bg-sky-500/20 transition-all flex items-center gap-1"
              >
                <Lightbulb className="w-3 h-3" /> @pm
              </button>
              <button
                onClick={() => setInputPrompt('@designer ')}
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-pink-500/10 text-pink-400 border border-pink-500/30 hover:bg-pink-500/20 transition-all flex items-center gap-1"
              >
                <Palette className="w-3 h-3" /> @designer
              </button>
              <button
                onClick={() => setInputPrompt('@architect ')}
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-all flex items-center gap-1"
              >
                <Landmark className="w-3 h-3" /> @architect
              </button>
              <button
                onClick={() => setInputPrompt('@pjm ')}
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/30 hover:bg-purple-500/20 transition-all flex items-center gap-1"
              >
                <Calendar className="w-3 h-3" /> @pjm
              </button>
            </div>
          </div>

          {/* Messages Stream */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {messages.map((m: any, idx: number) => {
              const isUser = m.role === 'user'
              const agent = m.agent

              return (
                <div
                  key={idx}
                  className={`p-3.5 rounded-lg text-xs leading-relaxed max-w-[90%] transition-all ${
                    isUser
                      ? 'bg-accent/15 border border-accent/30 text-foreground self-end'
                      : 'bg-card border border-border/80 text-foreground self-start shadow-sm'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5 pb-1 border-b border-border/40">
                    <span className="font-bold text-[11px]" style={{ color: agent?.color || 'var(--accent)' }}>
                      {agent?.avatar || '💬'} {agent?.title || (isUser ? 'Founder' : 'Advisor')}
                    </span>
                    {agent?.badge && (
                      <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-black/40 text-muted">
                        {agent.badge}
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              )
            })}
          </div>

          {/* Quick Suggestion Chips */}
          <div className="px-3 py-2 border-t border-border/40 bg-black/20 flex gap-2 overflow-x-auto">
            <button
              onClick={() => handleSendMessage('@pm who are our top 3 competitors and what are their biggest user complaints?')}
              className="px-2.5 py-1 rounded text-[11px] bg-white/5 hover:bg-white/10 text-muted hover:text-foreground whitespace-nowrap transition-colors border border-border/50"
            >
              💡 @pm Competitor Matrix
            </button>
            <button
              onClick={() => handleSendMessage('@designer create a 4-step onboarding flow for first-time users')}
              className="px-2.5 py-1 rounded text-[11px] bg-white/5 hover:bg-white/10 text-muted hover:text-foreground whitespace-nowrap transition-colors border border-border/50"
            >
              🎨 @designer Onboarding Flow
            </button>
            <button
              onClick={() => handleSendMessage('@architect design the PostgreSQL schema with foreign keys and indexes')}
              className="px-2.5 py-1 rounded text-[11px] bg-white/5 hover:bg-white/10 text-muted hover:text-foreground whitespace-nowrap transition-colors border border-border/50"
            >
              🏛️ @architect Postgres Schema
            </button>
            <button
              onClick={() => handleSendMessage('@pjm define the leanest MVP milestone we can build in Milestone 1')}
              className="px-2.5 py-1 rounded text-[11px] bg-white/5 hover:bg-white/10 text-muted hover:text-foreground whitespace-nowrap transition-colors border border-border/50"
            >
              📅 @pjm Lean MVP Plan
            </button>
          </div>

          {/* Prompt Input Bar */}
          <div className="p-3 border-t border-border/70 bg-card flex gap-2">
            <Input
              placeholder="Ask the council or type @pm, @designer, @architect, @pjm..."
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
              className="text-xs bg-black/30"
            />
            <Button variant="primary" size="sm" onClick={() => handleSendMessage()} disabled={loading || !inputPrompt.trim()}>
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Right Column (7 Cols): Multi-Tab Architectural Blueprint */}
        <div className="lg:col-span-7 flex flex-col h-full bg-card/50 border border-border/70 rounded-xl overflow-hidden backdrop-blur-sm">
          {/* 5 Tab Navigation Header */}
          <div className="flex border-b border-border/70 bg-black/20 px-2 pt-2 gap-1 overflow-x-auto">
            <button
              onClick={() => setActiveBlueprintTab('market')}
              className={`px-3 py-2 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-1.5 ${
                activeBlueprintTab === 'market'
                  ? 'bg-card text-sky-400 border-t-2 border-t-sky-400 border-x border-border/60'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              <Lightbulb className="w-3.5 h-3.5" /> Market & Competitors
            </button>

            <button
              onClick={() => setActiveBlueprintTab('prd')}
              className={`px-3 py-2 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-1.5 ${
                activeBlueprintTab === 'prd'
                  ? 'bg-card text-emerald-400 border-t-2 border-t-emerald-400 border-x border-border/60'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Product PRD Spec
            </button>

            <button
              onClick={() => setActiveBlueprintTab('journeys')}
              className={`px-3 py-2 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-1.5 ${
                activeBlueprintTab === 'journeys'
                  ? 'bg-card text-pink-400 border-t-2 border-t-pink-400 border-x border-border/60'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              <Palette className="w-3.5 h-3.5" /> User Journeys & UX
            </button>

            <button
              onClick={() => setActiveBlueprintTab('architecture')}
              className={`px-3 py-2 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-1.5 ${
                activeBlueprintTab === 'architecture'
                  ? 'bg-card text-accent border-t-2 border-t-accent border-x border-border/60'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              <Landmark className="w-3.5 h-3.5" /> Systems & DB ERD
            </button>

            <button
              onClick={() => setActiveBlueprintTab('roadmap')}
              className={`px-3 py-2 text-xs font-semibold rounded-t-lg transition-all flex items-center gap-1.5 ${
                activeBlueprintTab === 'roadmap'
                  ? 'bg-card text-purple-400 border-t-2 border-t-purple-400 border-x border-border/60'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" /> Roadmap & Tasks
            </button>
          </div>

          {/* Blueprint Content Area */}
          <div className="flex-1 overflow-y-auto p-4">
            {blueprint ? (
              <>
                {/* 1. Market & Competitors Tab */}
                {activeBlueprintTab === 'market' && (
                  <div className="flex flex-col gap-4">
                    <Card className="p-4 bg-sky-500/5 border-sky-500/20">
                      <h4 className="text-xs font-bold text-sky-400 mb-1">Target Customer Persona & Value Proposition</h4>
                      <p className="text-xs text-foreground/90 leading-relaxed">{blueprint.market?.coreValueProp}</p>
                      <div className="mt-2 text-[11px] text-muted">
                        <strong>Primary Persona:</strong> {blueprint.market?.targetAudience}
                      </div>
                    </Card>

                    <div>
                      <h4 className="text-xs font-bold text-foreground mb-2 flex items-center justify-between">
                        <span>Competitor Teardown Matrix</span>
                        <span className="text-[10px] text-muted font-mono">Benchmark Comparison</span>
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {blueprint.market?.competitors?.map((comp: any, i: number) => (
                          <div key={i} className="p-3 rounded-lg border border-border bg-black/20 text-xs flex flex-col gap-1.5">
                            <span className="font-bold text-foreground">{comp.name}</span>
                            <p className="text-danger text-[11px] font-medium">Competitor Gap: {comp.gap}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <h4 className="text-xs font-bold text-success mb-2">Our Unfair Differentiators</h4>
                      <div className="flex flex-col gap-1.5">
                        {blueprint.market?.uniqueDifferentiators?.map((diff: string, i: number) => (
                          <div key={i} className="p-2.5 rounded bg-success/10 border border-success/25 text-xs flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
                            <span className="text-foreground">{diff}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* 2. Product PRD Spec Tab */}
                {activeBlueprintTab === 'prd' && (
                  <div className="flex flex-col gap-4">
                    <Card className="p-4">
                      <h4 className="text-xs font-bold text-emerald-400 mb-1">Executive Summary</h4>
                      <p className="text-xs text-foreground leading-relaxed">{blueprint.prd?.executiveSummary}</p>
                    </Card>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="p-3 rounded-lg border border-success/30 bg-success/5 text-xs">
                        <span className="font-bold text-success block mb-1">In-Scope (v1 MVP)</span>
                        <ul className="list-disc list-inside text-muted flex flex-col gap-1">
                          {blueprint.prd?.inScope?.map((item: string, i: number) => (
                            <li key={i}>{item}</li>
                          ))}
                        </ul>
                      </div>

                      <div className="p-3 rounded-lg border border-border bg-black/20 text-xs">
                        <span className="font-bold text-muted block mb-1">Out-of-Scope (Deferred to v2)</span>
                        <ul className="list-disc list-inside text-muted/70 flex flex-col gap-1">
                          {blueprint.prd?.outOfScope?.map((item: string, i: number) => (
                            <li key={i}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div>
                      <h4 className="text-xs font-bold text-foreground mb-2">Requirements Matrix</h4>
                      <div className="flex flex-col gap-2">
                        {blueprint.prd?.requirements?.map((req: any) => (
                          <div key={req.id} className="p-2.5 rounded border border-border bg-card flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-accent">{req.id}</span>
                              <span className="font-medium text-foreground">{req.title}</span>
                            </div>
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white/5 border border-border text-muted">
                              {req.priority}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* 3. User Journeys Tab */}
                {activeBlueprintTab === 'journeys' && (
                  <div className="flex flex-col gap-4">
                    {blueprint.userJourneys?.map((j: any) => (
                      <Card key={j.id} className="p-4">
                        <h4 className="text-xs font-bold text-pink-400 mb-3 flex items-center gap-2">
                          <Palette className="w-4 h-4" /> {j.title}
                        </h4>
                        <div className="flex flex-col gap-2">
                          {j.steps?.map((s: any) => (
                            <div key={s.step} className="p-2.5 rounded bg-black/30 border border-border flex items-center gap-3 text-xs">
                              <div className="w-6 h-6 rounded-full bg-pink-500/20 text-pink-400 flex items-center justify-center font-bold text-[11px] border border-pink-500/30">
                                {s.step}
                              </div>
                              <div className="flex-1">
                                <span className="font-semibold text-foreground">[{s.actor}]: </span>
                                <span className="text-muted">{s.action}</span>
                              </div>
                              <div className="text-[10px] font-mono text-success bg-success/10 px-2 py-0.5 rounded border border-success/20">
                                &rarr; {s.outcome}
                              </div>
                            </div>
                          ))}
                        </div>
                      </Card>
                    ))}
                  </div>
                )}

                {/* 4. Architecture & Database ERD Tab */}
                {activeBlueprintTab === 'architecture' && (
                  <div className="flex flex-col gap-4">
                    <Card className="p-4 bg-accent/5 border-accent/20">
                      <span className="text-[10px] font-mono text-muted uppercase">Recommended Stack</span>
                      <p className="text-xs font-mono font-bold text-accent mt-0.5">{blueprint.architecture?.techStack}</p>
                    </Card>

                    <div>
                      <h4 className="text-xs font-bold text-foreground mb-2 flex items-center justify-between">
                        <span>Database Relational Schema (ERD)</span>
                        <span className="text-[10px] font-mono text-muted">{blueprint.architecture?.databaseSchema?.engine}</span>
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {blueprint.architecture?.databaseSchema?.tables?.map((table: any) => (
                          <div key={table.name} className="rounded-lg border border-border bg-card overflow-hidden text-xs">
                            <div className="p-2 bg-black/30 border-b border-border font-mono font-bold text-accent flex items-center gap-1.5">
                              <span>🗄️</span> {table.name}
                            </div>
                            <div className="p-2.5 flex flex-col gap-1 font-mono text-[11px] text-muted">
                              {table.columns?.map((col: string, idx: number) => (
                                <div key={idx} className="flex justify-between">
                                  <span>{col}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <h4 className="text-xs font-bold text-foreground mb-2">API Endpoint Contracts</h4>
                      <div className="flex flex-col gap-2">
                        {blueprint.architecture?.apiContracts?.map((api: any, idx: number) => (
                          <div key={idx} className="p-2.5 rounded border border-border bg-black/20 flex items-center justify-between text-xs font-mono">
                            <div className="flex items-center gap-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                api.method === 'GET' ? 'bg-sky-500/20 text-sky-400' : 'bg-emerald-500/20 text-emerald-400'
                              }`}>
                                {api.method}
                              </span>
                              <span className="text-foreground">{api.path}</span>
                            </div>
                            <span className="text-[11px] text-muted font-sans">{api.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* 5. Delivery Roadmap Tab */}
                {activeBlueprintTab === 'roadmap' && (
                  <div className="flex flex-col gap-4">
                    {blueprint.roadmap?.milestones?.map((ms: any) => (
                      <Card key={ms.id} className="p-4">
                        <h4 className="text-xs font-bold text-purple-400 mb-2 flex items-center gap-2">
                          <Calendar className="w-4 h-4" /> {ms.title}
                        </h4>
                        <div className="flex flex-col gap-2">
                          {ms.tasks?.map((t: any) => (
                            <div key={t.tempId} className="p-2.5 rounded bg-card border border-border/80 flex items-center justify-between text-xs">
                              <div>
                                <span className="font-semibold text-foreground block">{t.title}</span>
                                <span className="text-[10px] font-mono text-muted">
                                  Scopes: {t.scopePaths?.join(', ')}
                                </span>
                              </div>
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 border border-border text-muted">
                                {t.blockedBy?.length > 0 ? `Blocked by ${t.blockedBy.join(', ')}` : 'Ready to build'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-center p-8">
                <p className="text-xs text-muted">Loading complete product blueprint from council synthesis...</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* One-Click Project Launch Modal */}
      {showInitModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-xl p-6 max-w-lg w-full shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-md bg-accent flex items-center justify-center text-white font-bold text-xs">
                  🚀
                </div>
                <h3 className="text-sm font-bold text-foreground">Approve Blueprint & Launch Project</h3>
              </div>
              <button onClick={() => setShowInitModal(false)} className="text-muted hover:text-foreground">✕</button>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              This will initialize the local git repository, commit the initial baseline files, lock Baseline v1.0.0 with SHA256 content digests, decompose the tasks into the DAG, and switch to the Delivery Board.
            </p>

            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-muted mb-1">Project Name</label>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1">Local Filesystem Target Path</label>
                <Input
                  value={targetRepoPath}
                  onChange={(e) => setTargetRepoPath(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2.5 pt-3 border-t border-border">
              <Button variant="ghost" size="sm" onClick={() => setShowInitModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="md" onClick={handleInitProject} disabled={initLoading || !targetRepoPath.trim()}>
                {initLoading ? 'Initializing Git & Baseline...' : 'Initialize & Open Delivery Board'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
