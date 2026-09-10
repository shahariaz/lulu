import React, { useState, useCallback, useEffect } from 'react'
import {
  ArrowRight, CheckCircle2, Database, ExternalLink, FileCheck2, FileText,
  Lightbulb, MessageSquareText, Plus, RefreshCw, Search, Send, Sparkles,
  Users, PanelRightClose, PanelRightOpen, PanelRight
} from 'lucide-react'
import { api } from '../lib/api'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Input } from './ui/Input'
import { Badge } from './ui/Badge'
import { useOrchestratorEvents } from '../hooks/useOrchestratorEvents'
import type { Project } from '../types'

interface IdeaStudioViewProps {
  project?: Project | null
  onProjectInitialized: (project: any) => void
}

type CanvasView = 'brief' | 'evidence' | 'blueprint'
type BlueprintSubTab = 'prd' | 'architecture' | 'market' | 'journeys' | 'roadmap'

const SPECIALISTS = [
  { id: 'pm', roleName: 'CPO (PM)', title: 'Chief Product Officer', avatar: '💡', promptTag: '@pm' },
  { id: 'architect', roleName: 'Architect', title: 'Principal Systems Architect', avatar: '🏛️', promptTag: '@architect' },
  { id: 'designer', roleName: 'Designer', title: 'Staff UX Designer', avatar: '🎨', promptTag: '@designer' },
  { id: 'pjm', roleName: 'PjM', title: 'Director of Agile Delivery', avatar: '📅', promptTag: '@pjm' },
]

export function IdeaStudioView({ project, onProjectInitialized }: IdeaStudioViewProps) {
  const [projectName, setProjectName] = useState('')
  const [ideaDescription, setIdeaDescription] = useState('')
  const [targetPersona, setTargetPersona] = useState('')
  const [desiredOutcome, setDesiredOutcome] = useState('')
  const [constraints, setConstraints] = useState('')
  const [nonGoals, setNonGoals] = useState('')
  const [repoPath, setRepoPath] = useState('')

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [prompt, setPrompt] = useState('')
  const [research, setResearch] = useState<any>(null)
  const [blueprint, setBlueprint] = useState<any>(null)

  // Canvas display controls
  const [showCanvas, setShowCanvas] = useState<boolean>(false)
  const [canvasView, setCanvasView] = useState<CanvasView>('brief')
  const [bpTab, setBpTab] = useState<BlueprintSubTab>('prd')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [studioProgress, setStudioProgress] = useState<string | null>(null)

  // Restore active council session for the selected project or from localStorage
  useEffect(() => {
    if (project?.id) {
      api.getProjectCouncil(project.id).then((data) => {
        if (data.session) {
          setSessionId(data.session.id)
          setProjectName(data.session.projectName || project.name || '')
          setMessages(data.session.messages || [])
          if (data.session.marketResearch) setResearch(data.session.marketResearch)
          if (data.session.blueprint) {
            setBlueprint(data.session.blueprint)
            setCanvasView('blueprint')
            setShowCanvas(true)
          } else if (data.session.marketResearch) {
            setCanvasView('evidence')
          }
          return
        }
      }).catch(() => {})
    }

    const savedId = localStorage.getItem('zen_idea_studio_session_id')
    if (savedId && !sessionId) {
      api.getCouncil(savedId).then((data) => {
        if (data.session) {
          setSessionId(data.session.id)
          setProjectName(data.session.projectName || '')
          setMessages(data.session.messages || [])
          if (data.session.marketResearch) setResearch(data.session.marketResearch)
          if (data.session.blueprint) {
            setBlueprint(data.session.blueprint)
            setCanvasView('blueprint')
            setShowCanvas(true)
          } else if (data.session.marketResearch) {
            setCanvasView('evidence')
          }
        }
      }).catch(() => {
        localStorage.removeItem('zen_idea_studio_session_id')
      })
    }
  }, [project?.id])

  useOrchestratorEvents(useCallback((type: string, data: any) => {
    if (type === 'studio_progress' && (!data?.sessionId || data.sessionId === sessionId)) {
      setStudioProgress(data.message || null)
    }
    if (type === 'project_initialized_from_blueprint') {
      setStudioProgress(null)
    }
    if (type === 'studio_research_ready' && (!data?.sessionId || data.sessionId === sessionId)) {
      if (data.teardown) {
        setResearch(data.teardown)
      }
    }
    if (type === 'council_debate_turn' && (!data?.sessionId || data.sessionId === sessionId)) {
      if (data.reply) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === data.reply.id)) return prev
          return [...prev, data.reply]
        })
      }
    }
  }, [sessionId]))

  const briefDescription = [
    `Problem: ${ideaDescription.trim()}`,
    `Desired outcome: ${desiredOutcome.trim()}`,
    constraints.trim() && `Constraints: ${constraints.trim()}`,
    nonGoals.trim() && `Out of scope: ${nonGoals.trim()}`,
  ].filter(Boolean).join('\n\n')
  const briefSignals = [projectName, targetPersona, ideaDescription, desiredOutcome].filter(value => value.trim()).length

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError(null)
    try { await action() } catch (err: any) { setError(err.message || String(err)) } finally { setBusy(null) }
  }

  const start = () => run('Starting council', async () => {
    const data = await api.startCouncil({ projectName: projectName.trim(), ideaDescription: briefDescription, targetPersona: targetPersona.trim() || 'primary users' })
    setSessionId(data.session.id)
    try { localStorage.setItem('zen_idea_studio_session_id', data.session.id) } catch {}
    setMessages(data.session.messages)
    setResearch(null)
    setBlueprint(null)
    setCanvasView('brief')
  })

  const startNewSession = () => {
    try { localStorage.removeItem('zen_idea_studio_session_id') } catch {}
    setSessionId(null)
    setMessages([])
    setResearch(null)
    setBlueprint(null)
    setProjectName('')
    setIdeaDescription('')
    setDesiredOutcome('')
    setTargetPersona('')
    setConstraints('')
    setNonGoals('')
    setCanvasView('brief')
    setShowCanvas(false)
  }

  const send = (text = prompt) => {
    if (!sessionId || !text.trim()) return
    setPrompt('')
    run('Consulting council...', async () => {
      const data = await api.councilTurn(sessionId, text.trim())
      setMessages(data.session.messages)
    })
  }

  const conveneDebate = () => sessionId && run('Council debate in progress...', async () => {
    const data = await api.conveneDebate(sessionId)
    setMessages(data.session.messages)
  })

  const researchMarket = () => sessionId && run('Researching market...', async () => {
    const data = await api.researchMarket({ sessionId, productIdea: projectName, ideaDescription: briefDescription, depth: 'standard' })
    setResearch(data.teardown)
    setCanvasView('evidence')
    setShowCanvas(true)
  })

  const synthesize = () => sessionId && research && run('Synthesizing blueprint...', async () => {
    const data = await api.synthesizeBlueprint({ sessionId, ideaTitle: projectName, ideaDescription: briefDescription, marketResearch: research })
    setBlueprint(data.blueprint)
    setCanvasView('blueprint')
    setShowCanvas(true)
  })

  const toggleRequirementPriority = (reqId: string) => {
    if (!blueprint?.prd?.requirements) return
    const priorities = ['MUST', 'SHOULD', 'COULD']
    setBlueprint({
      ...blueprint,
      prd: {
        ...blueprint.prd,
        requirements: blueprint.prd.requirements.map((r: any) => {
          if (r.id !== reqId) return r
          const nextIdx = (priorities.indexOf(r.priority) + 1) % priorities.length
          return { ...r, priority: priorities[nextIdx] }
        }),
      },
    })
  }

  const initialize = () => sessionId && blueprint && run('Creating delivery plan', async () => {
    setStudioProgress('Initializing delivery workspace...')
    try {
      const data = await api.initializeProject({ sessionId, repoPath: repoPath.trim(), projectName: projectName.trim(), blueprint, marketResearch: research })
      onProjectInitialized(data.project)
    } finally {
      setStudioProgress(null)
    }
  })

  // 1. Initial Brief State before session is started
  if (!sessionId) {
    return (
      <div className="h-full overflow-y-auto p-6 bg-zinc-50/50">
        <div className="max-w-2xl mx-auto flex flex-col gap-5 py-4">
          <Card className="p-6 border border-zinc-200 bg-white rounded-xl shadow-xs">
            <div className="border-b border-zinc-100 pb-4 mb-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-zinc-900 tracking-tight">Product Concept Brief</h2>
                  <p className="text-xs text-zinc-500 mt-0.5">Define your core product idea to convene the Executive Council.</p>
                </div>
                <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
                  {briefSignals}/4 essentials
                </span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Product or concept name</label>
                  <Input
                    placeholder="e.g. Distributed Cache Sentinel"
                    value={projectName}
                    onChange={e => setProjectName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Primary user role</label>
                  <Input
                    placeholder="e.g. Site Reliability Engineers"
                    value={targetPersona}
                    onChange={e => setTargetPersona(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">What is broken today? (The problem)</label>
                <textarea
                  className="w-full h-24 p-3 rounded-lg border border-zinc-200 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                  value={ideaDescription}
                  onChange={e => setIdeaDescription(e.target.value)}
                  placeholder="Describe the operational friction, downtime consequences, or manual toil..."
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">What should become possible? (Desired outcome)</label>
                <textarea
                  className="w-full h-24 p-3 rounded-lg border border-zinc-200 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                  value={desiredOutcome}
                  onChange={e => setDesiredOutcome(e.target.value)}
                  placeholder="After this exists, users can..."
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Constraints (Optional)</label>
                  <textarea
                    className="w-full h-20 p-3 rounded-lg border border-zinc-200 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                    value={constraints}
                    onChange={e => setConstraints(e.target.value)}
                    placeholder="Zero external cloud database dependencies; Node 24..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">Out of scope (Optional)</label>
                  <textarea
                    className="w-full h-20 p-3 rounded-lg border border-zinc-200 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                    value={nonGoals}
                    onChange={e => setNonGoals(e.target.value)}
                    placeholder="No custom storage engines in version 1..."
                  />
                </div>
              </div>

              {error && <p role="alert" className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-xs text-rose-700 font-medium">{error}</p>}

              <div className="flex justify-end pt-2">
                <Button variant="primary" onClick={start} disabled={!!busy || briefSignals < 4}>
                  {busy || 'Commence Council →'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  // 2. Active Session Workspace (Council Chat + Collapsible Canvas)
  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      {/* Streamlined Top Action Control Bar */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-2.5 bg-white shrink-0">
        {/* Left: Quick Specialist Routing Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <span className="text-[11px] font-medium text-zinc-400 mr-1 hidden sm:inline">Ask:</span>
          {SPECIALISTS.map(spec => (
            <button
              key={spec.id}
              onClick={() => setPrompt(`${spec.promptTag} `)}
              title={`Direct question to ${spec.title}`}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-xs font-medium text-zinc-700 transition-colors cursor-pointer shadow-2xs"
            >
              <span>{spec.avatar}</span>
              <span>{spec.roleName}</span>
            </button>
          ))}
        </div>

        {/* Right: Actions and Canvas Toggle */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={startNewSession}
            disabled={!!busy}
            className="text-xs text-zinc-600 hover:text-zinc-900 h-8"
          >
            + New concept
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={conveneDebate}
            disabled={!!busy}
            className="text-xs text-zinc-800 h-8"
          >
            {busy === 'Council debate in progress...' ? (
              <>
                <RefreshCw className="h-3 w-3 animate-spin mr-1 text-[#ea3a12]" />
                Debating...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5 mr-1 text-[#ea3a12]" />
                Convene debate
              </>
            )}
          </Button>

          {/* Accumod-style Canvas Toggle Button */}
          <button
            onClick={() => setShowCanvas(!showCanvas)}
            title={showCanvas ? 'Hide canvas (full-screen chat)' : 'Open canvas'}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors shadow-2xs ${
              showCanvas
                ? 'bg-zinc-900 text-white border-zinc-900 shadow-xs'
                : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'
            }`}
          >
            {showCanvas ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            <span>Canvas</span>
            {(blueprint || research) && !showCanvas && (
              <span className="h-1.5 w-1.5 rounded-full bg-[#ea3a12]" />
            )}
          </button>
        </div>
      </div>

      {/* Main Workspace: Full-Screen Chat or Side-by-Side Canvas */}
      <div className={`flex-1 min-h-0 overflow-hidden bg-white ${showCanvas ? 'grid grid-cols-1 lg:grid-cols-12 divide-x divide-zinc-200' : 'flex flex-col'}`}>
        {/* COUNCIL CHAT STREAM: Expands to 100% full screen when showCanvas is false */}
        <div className={`${showCanvas ? 'lg:col-span-5' : 'w-full'} flex flex-col h-full overflow-hidden bg-white`}>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 bg-zinc-50/40">
            <div className={`${showCanvas ? 'w-full' : 'max-w-3xl mx-auto w-full'} flex flex-col gap-4`}>
              {messages.map((message: any) => {
                const isUser = message.role === 'user'
                const persona = message.agent || (message.targetRole && SPECIALISTS.find(s => s.id === message.targetRole))

                return (
                  <div
                    key={message.id || message.timestamp}
                    className={`max-w-[92%] flex flex-col gap-1.5 ${isUser ? 'ml-auto items-end' : 'mr-auto items-start'}`}
                  >
                    {!isUser && (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-700">
                        <span>{persona?.avatar || '🌐'}</span>
                        <span className="font-semibold text-zinc-900">{persona?.title || 'Product Council'}</span>
                      </div>
                    )}
                    <div
                      className={`p-4 rounded-2xl text-xs leading-relaxed shadow-2xs ${
                        isUser
                          ? 'bg-zinc-900 text-white rounded-br-xs'
                          : 'bg-white text-zinc-800 border border-zinc-200/90 rounded-bl-xs'
                      }`}
                    >
                      {isUser ? (
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      ) : (
                        <FormattedCouncilMessage content={message.content} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Centered Prompt Dock */}
          <div className="p-3.5 border-t border-zinc-200 bg-white shrink-0">
            <div className={`${showCanvas ? 'w-full' : 'max-w-3xl mx-auto'} flex gap-2`}>
              <Input
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
                placeholder="Ask @pm, @architect, @designer, @pjm..."
                disabled={!!busy}
                className="h-10 text-xs"
              />
              <Button size="md" onClick={() => send()} disabled={!!busy || !prompt.trim()} className="h-10 px-4">
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        {/* THE LIVING CANVAS: Accumod-Style Browser Tabs */}
        {showCanvas && (
          <div className="lg:col-span-7 flex flex-col h-full overflow-hidden bg-white">
            {/* Accumod-Style Browser Document Tabs */}
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 bg-zinc-50/60 shrink-0">
              <div className="flex items-center gap-1 pt-1.5 overflow-x-auto">
                {/* Tab 1: Brief */}
                <button
                  onClick={() => setCanvasView('brief')}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-t-lg text-xs font-medium transition-colors border-t border-x ${
                    canvasView === 'brief'
                      ? 'bg-white text-zinc-900 border-zinc-200/90 border-b-transparent font-semibold shadow-2xs'
                      : 'text-zinc-500 hover:text-zinc-800 border-transparent hover:bg-zinc-100/60'
                  }`}
                >
                  <Lightbulb size={13} />
                  <span>Product brief</span>
                </button>

                {/* Tab 2: Evidence */}
                <button
                  onClick={() => setCanvasView('evidence')}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-t-lg text-xs font-medium transition-colors border-t border-x ${
                    canvasView === 'evidence'
                      ? 'bg-white text-zinc-900 border-zinc-200/90 border-b-transparent font-semibold shadow-2xs'
                      : 'text-zinc-500 hover:text-zinc-800 border-transparent hover:bg-zinc-100/60'
                  }`}
                >
                  <Search size={13} />
                  <span>Market evidence</span>
                  {research && (
                    <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.2 rounded-full font-medium ml-0.5">
                      {research.sources?.length || 0}
                    </span>
                  )}
                </button>

                {/* Tab 3: Blueprint */}
                <button
                  onClick={() => setCanvasView('blueprint')}
                  disabled={!blueprint && !research}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-t-lg text-xs font-medium transition-colors border-t border-x ${
                    canvasView === 'blueprint'
                      ? 'bg-white text-zinc-900 border-zinc-200/90 border-b-transparent font-semibold shadow-2xs'
                      : 'text-zinc-500 hover:text-zinc-800 border-transparent hover:bg-zinc-100/60 disabled:opacity-40'
                  }`}
                >
                  <FileText size={13} />
                  <span>Blueprint</span>
                  {blueprint && (
                    <span className="text-[10px] bg-zinc-800 text-white px-1.5 py-0.2 rounded-full font-mono ml-0.5">
                      v1.0.0
                    </span>
                  )}
                </button>
              </div>

              {/* Close Button on Tab Bar */}
              <button
                onClick={() => setShowCanvas(false)}
                className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/80 transition-colors"
                title="Collapse canvas"
              >
                <PanelRightClose size={15} />
              </button>
            </div>

            {/* Canvas Body */}
            <div className="flex-1 overflow-y-auto p-5 bg-white">
              {/* TAB 1: Product Concept Sheet */}
              {canvasView === 'brief' && (
                <div className="max-w-2xl mx-auto flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
                    <div>
                      <h3 className="text-base font-bold text-zinc-900">{projectName}</h3>
                      <p className="text-xs text-zinc-500 font-medium">Target persona: {targetPersona || 'Primary users'}</p>
                    </div>
                    <Badge variant="ready">Defined Brief</Badge>
                  </div>

                  <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200/80 flex flex-col gap-3 text-xs">
                    <div>
                      <span className="font-semibold text-zinc-900 block mb-1">Problem & pain points:</span>
                      <p className="text-zinc-700 leading-relaxed">{ideaDescription || 'Not specified'}</p>
                    </div>
                    {desiredOutcome && (
                      <div>
                        <span className="font-semibold text-zinc-900 block mb-1">Desired outcome:</span>
                        <p className="text-zinc-700 leading-relaxed">{desiredOutcome}</p>
                      </div>
                    )}
                    {constraints && (
                      <div>
                        <span className="font-semibold text-zinc-900 block mb-1">Constraints:</span>
                        <p className="text-zinc-600 leading-relaxed">{constraints}</p>
                      </div>
                    )}
                    {nonGoals && (
                      <div>
                        <span className="font-semibold text-zinc-900 block mb-1">Out of scope:</span>
                        <p className="text-zinc-600 leading-relaxed">{nonGoals}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: Market Evidence */}
              {canvasView === 'evidence' && (
                <div className="max-w-3xl mx-auto flex flex-col gap-5">
                  {!research ? (
                    <div className="flex flex-col items-center justify-center p-12 text-center bg-zinc-50 border border-dashed border-zinc-200 rounded-xl my-6">
                      <div className="w-12 h-12 rounded-xl bg-zinc-100 text-zinc-700 flex items-center justify-center mb-3">
                        <Search size={20} />
                      </div>
                      <h3 className="text-sm font-semibold text-zinc-900">Empirical Research Not Run Yet</h3>
                      <p className="text-xs text-zinc-500 max-w-sm mt-1 mb-4 leading-relaxed">
                        Run market research to scrape and analyze actual competitor tools and reference literature via Wigolo.
                      </p>
                      <Button variant="primary" onClick={researchMarket} disabled={!!busy}>
                        {busy === 'Researching market...' ? 'Running research...' : 'Run Market Research'}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-5">
                      <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
                        <div>
                          <h3 className="text-sm font-bold text-zinc-900">Competitor teardown & evidence</h3>
                          <p className="text-xs text-zinc-500">{research.sources?.length || 0} sourced references cataloged</p>
                        </div>
                        <Button variant="primary" size="sm" onClick={synthesize} disabled={!!busy}>
                          {busy === 'Synthesizing blueprint...' ? 'Synthesizing...' : 'Synthesize blueprint →'}
                        </Button>
                      </div>

                      {/* Competitors Grid */}
                      <div className="grid gap-3 md:grid-cols-2">
                        {research.competitors?.map((comp: any) => (
                          <div key={comp.name} className="p-4 rounded-xl border border-zinc-200 bg-white shadow-2xs flex flex-col justify-between gap-3">
                            <div>
                              <div className="flex items-center justify-between gap-2 mb-1.5">
                                <span className="font-semibold text-xs text-zinc-900">{comp.name}</span>
                                {comp.url && (
                                  <a href={comp.url} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-900">
                                    <ExternalLink size={12} />
                                  </a>
                                )}
                              </div>
                              <p className="text-xs text-zinc-600 leading-relaxed">{comp.positioning}</p>
                            </div>

                            {comp.strengths && comp.strengths.length > 0 && (
                              <div className="flex flex-wrap gap-1 border-t border-zinc-100 pt-2">
                                {comp.strengths.map((s: string, i: number) => (
                                  <span key={i} className="text-[10px] bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-md">
                                    ✓ {s}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Differentiators & Risks */}
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200/80">
                          <span className="text-xs font-semibold text-zinc-900 block mb-2">Unique differentiators</span>
                          <ul className="space-y-1.5 text-xs text-zinc-700">
                            {research.differentiators?.map((d: string, i: number) => (
                              <li key={i} className="flex items-start gap-2">
                                <span className="text-[#ea3a12] font-bold">•</span>
                                <span>{d}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200/80">
                          <span className="text-xs font-semibold text-zinc-900 block mb-2">Identified market risks</span>
                          <ul className="space-y-1.5 text-xs text-zinc-700">
                            {research.risks?.map((r: string, i: number) => (
                              <li key={i} className="flex items-start gap-2">
                                <span className="text-amber-600 font-bold">•</span>
                                <span>{r}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {/* Sourced URLs */}
                      <div className="border-t border-zinc-100 pt-3">
                        <span className="text-xs font-semibold text-zinc-700 block mb-2">Primary research sources</span>
                        <div className="flex flex-wrap gap-1.5">
                          {research.sources?.map((s: any) => (
                            <a
                              key={s.url}
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-mono text-zinc-600 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200/80 transition-colors"
                            >
                              <span className="truncate max-w-[200px]">{s.title || s.url}</span>
                              <ExternalLink size={10} />
                            </a>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: Blueprint Canvas */}
              {canvasView === 'blueprint' && blueprint && (
                <div className="max-w-3xl mx-auto flex flex-col gap-5 pb-16">
                  {/* Blueprint Sub-Tabs */}
                  <div className="flex items-center gap-1 border-b border-zinc-200 pb-2">
                    {(['prd', 'architecture', 'market', 'journeys', 'roadmap'] as BlueprintSubTab[]).map(t => (
                      <button
                        key={t}
                        onClick={() => setBpTab(t)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                          bpTab === t ? 'bg-zinc-900 text-white shadow-xs' : 'text-zinc-600 hover:bg-zinc-100'
                        }`}
                      >
                        {t === 'prd' ? 'PRD requirements' : t}
                      </button>
                    ))}
                  </div>

                  {/* Sub-tab: PRD & Requirements */}
                  {bpTab === 'prd' && (
                    <div className="flex flex-col gap-4">
                      <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200">
                        <span className="text-xs font-semibold text-zinc-900 block mb-1">Executive summary</span>
                        <p className="text-xs text-zinc-700 leading-relaxed">{blueprint.prd?.executiveSummary}</p>
                      </div>

                      <div className="flex items-center justify-between text-xs text-zinc-500 pt-1">
                        <span>Click priority badge (MUST / SHOULD / COULD) to toggle MoSCoW allocation</span>
                        <span>{blueprint.prd?.requirements?.length || 0} requirements</span>
                      </div>

                      <div className="space-y-3">
                        {blueprint.prd?.requirements?.map((req: any) => (
                          <div key={req.id} className="p-4 rounded-xl border border-zinc-200 bg-white shadow-2xs flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-xs font-bold text-zinc-900">{req.id} · {req.title}</span>
                              <button
                                onClick={() => toggleRequirementPriority(req.id)}
                                title="Click to cycle priority"
                                className={`px-2 py-0.5 rounded-md text-[10px] font-bold border transition-colors cursor-pointer ${
                                  req.priority === 'MUST' ? 'bg-emerald-50 text-emerald-800 border-emerald-300' :
                                  req.priority === 'SHOULD' ? 'bg-sky-50 text-sky-800 border-sky-300' :
                                  'bg-amber-50 text-amber-800 border-amber-300'
                                }`}
                              >
                                {req.priority} ⟳
                              </button>
                            </div>
                            <p className="text-xs text-zinc-600 leading-relaxed">{req.description}</p>
                            {req.acceptanceCriteria && (
                              <div className="border-t border-zinc-100 pt-2 mt-1 space-y-1">
                                {req.acceptanceCriteria.map((c: string, idx: number) => (
                                  <div key={idx} className="flex items-start gap-2 text-[11px] text-zinc-700">
                                    <CheckCircle2 size={13} className="text-emerald-600 mt-0.5 shrink-0" />
                                    <span>{c}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Sub-tab: Architecture & Schema Visualizer */}
                  {bpTab === 'architecture' && (
                    <div className="flex flex-col gap-5">
                      <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200">
                        <span className="text-xs font-semibold text-zinc-900 block mb-1">Runtime & tech stack</span>
                        <p className="font-mono text-xs text-zinc-800 leading-relaxed">{blueprint.architecture?.techStack}</p>
                      </div>

                      {/* Relational Database Schema */}
                      {blueprint.architecture?.databaseSchema?.tables && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-900">
                            <Database size={14} className="text-[#ea3a12]" />
                            <span>Relational database schema</span>
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            {blueprint.architecture.databaseSchema.tables.map((tbl: any) => (
                              <div key={tbl.name} className="p-3.5 rounded-xl border border-zinc-200 bg-white shadow-2xs">
                                <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-100">
                                  <span className="font-mono text-xs font-bold text-zinc-900">{tbl.name}</span>
                                  <span className="text-[10px] font-mono text-zinc-400">{tbl.columns?.length || 0} cols</span>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {tbl.columns?.map((c: string) => (
                                    <span key={c} className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-zinc-50 border border-zinc-200 text-zinc-700">
                                      {c}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* API Contracts */}
                      {blueprint.architecture?.apiContracts && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between text-xs font-semibold text-zinc-900">
                            <span>REST API contracts</span>
                            <span className="text-[10px] font-mono text-zinc-400">{blueprint.architecture.apiContracts.length} endpoints</span>
                          </div>
                          <div className="flex flex-col gap-2">
                            {blueprint.architecture.apiContracts.map((apiItem: any) => (
                              <div key={`${apiItem.method}-${apiItem.path}`} className="flex items-center justify-between p-3 rounded-lg border border-zinc-200 bg-white text-xs shadow-2xs">
                                <div className="flex items-center gap-2.5 font-mono">
                                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                                    apiItem.method === 'GET' ? 'bg-sky-50 text-sky-700 border border-sky-200' :
                                    apiItem.method === 'POST' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                                    apiItem.method === 'PUT' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                                    'bg-rose-50 text-rose-700 border border-rose-200'
                                  }`}>
                                    {apiItem.method}
                                  </span>
                                  <span className="font-semibold text-zinc-900">{apiItem.path}</span>
                                </div>
                                <span className="text-zinc-500 text-[11px] max-w-sm truncate">{apiItem.purpose}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Sub-tab: Market */}
                  {bpTab === 'market' && (
                    <div className="flex flex-col gap-4">
                      <div className="p-4 rounded-xl bg-zinc-50 border border-zinc-200 text-xs">
                        <span className="font-semibold text-zinc-900 block mb-1">Core value proposition</span>
                        <p className="text-zinc-700 leading-relaxed">{blueprint.market?.coreValueProp}</p>
                        <p className="mt-2 text-[#ea3a12] font-semibold">Target: {blueprint.market?.targetAudience}</p>
                      </div>
                    </div>
                  )}

                  {/* Sub-tab: User Journeys */}
                  {bpTab === 'journeys' && (
                    <div className="space-y-3">
                      {blueprint.userJourneys?.map((j: any, i: number) => (
                        <div key={i} className="p-4 rounded-xl border border-zinc-200 bg-white text-xs shadow-2xs">
                          <h4 className="font-semibold text-zinc-900 mb-2">{j.persona} → {j.goal}</h4>
                          <ol className="space-y-1.5 pl-2">
                            {j.steps?.map((step: string, sIdx: number) => (
                              <li key={sIdx} className="flex items-start gap-2">
                                <span className="font-mono text-[#ea3a12] font-semibold">{sIdx + 1}.</span>
                                <span className="text-zinc-700">{step}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Sub-tab: Roadmap */}
                  {bpTab === 'roadmap' && (
                    <div className="space-y-3">
                      {blueprint.roadmap?.milestones?.map((m: any, i: number) => (
                        <div key={i} className="p-4 rounded-xl border border-zinc-200 bg-white text-xs shadow-2xs">
                          <span className="font-semibold text-zinc-900 block mb-2">{m.title}</span>
                          <div className="space-y-2">
                            {m.tasks?.map((t: any, tIdx: number) => (
                              <div key={tIdx} className="p-2.5 rounded-lg bg-zinc-50 border border-zinc-200/80">
                                <strong className="font-medium text-zinc-900 block">{t.title}</strong>
                                <p className="text-zinc-500 text-[11px] mt-0.5">{t.description}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Sticky Delivery Dock (Only on Blueprint Canvas) */}
            {canvasView === 'blueprint' && blueprint && (
              <div className="border-t border-zinc-200 bg-zinc-50/95 backdrop-blur-md p-4 shrink-0 shadow-lg">
                <div className="max-w-3xl mx-auto flex flex-col gap-2">
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <Input
                      value={repoPath}
                      onChange={e => setRepoPath(e.target.value)}
                      placeholder="/path/to/target/repository"
                      className="font-mono text-xs bg-white"
                      disabled={!!busy}
                    />
                    <Button variant="primary" onClick={initialize} disabled={!!busy || !repoPath.trim()}>
                      {busy === 'Creating delivery plan' ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1 text-white" />
                          Initializing workspace...
                        </>
                      ) : (
                        <>
                          Approve PRD & Initialize <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </div>
                  {studioProgress && (
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-700 bg-white border border-zinc-200 px-3 py-1.5 rounded-lg shadow-2xs">
                      <span className="h-2 w-2 rounded-full bg-[#ea3a12] animate-ping" />
                      <span>{studioProgress}</span>
                    </div>
                  )}
                  <p className="text-[10px] text-zinc-500">
                    Initializes git, creates README, locks v1.0.0 baseline, provisions Sprint 1, and populates the Kanban DAG.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Formatted Council message renderer that parses code blocks,
 * subheadings, bullet lists, bold text, numbered items, and LaTeX math into clean styled React components.
 */
function FormattedCouncilMessage({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <div className="space-y-2 text-xs leading-relaxed text-zinc-800">
      {parts.map((part, idx) => {
        if (part.startsWith('```')) {
          const lines = part.slice(3, -3).trim().split('\n')
          const firstLine = lines[0].trim()
          const isLang = /^[a-zA-Z0-9_-]+$/.test(firstLine)
          const codeLines = isLang ? lines.slice(1) : lines
          return (
            <div key={idx} className="my-2.5 rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden shadow-2xs">
              {isLang && (
                <div className="px-3 py-1 bg-zinc-800/80 border-b border-zinc-700/50 text-[10px] font-mono text-zinc-400">
                  {firstLine}
                </div>
              )}
              <pre className="p-3 font-mono text-[11px] text-zinc-200 overflow-x-auto whitespace-pre leading-relaxed">
                {codeLines.join('\n')}
              </pre>
            </div>
          )
        }

        const lines = part.split('\n')
        return (
          <div key={idx} className="space-y-1.5">
            {lines.map((line, lineIdx) => {
              const trimmed = line.trim()
              if (!trimmed) return <div key={lineIdx} className="h-0.5" />

              // Horizontal dividers: --- or ***
              if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
                return <hr key={lineIdx} className="my-3 border-t border-zinc-200" />
              }

              // Standalone command flags (e.g. -f hls -hls_time 1...)
              if (/^-(?:f|hls|preset|c:v|b:v|i|filter|-)\b/.test(trimmed)) {
                return (
                  <pre key={lineIdx} className="my-1.5 px-3 py-1.5 rounded-md bg-zinc-900 text-zinc-200 font-mono text-[11px] overflow-x-auto whitespace-pre border border-zinc-800 shadow-2xs">
                    {trimmed}
                  </pre>
                )
              }

              // Headings: H1, H2, H3, H4, H5
              if (trimmed.startsWith('##### ')) {
                return (
                  <h6 key={lineIdx} className="font-semibold text-zinc-800 text-xs mt-2 mb-0.5">
                    {renderInlineFormatting(trimmed.slice(6))}
                  </h6>
                )
              }
              if (trimmed.startsWith('#### ')) {
                return (
                  <h5 key={lineIdx} className="font-bold text-zinc-900 text-xs mt-3 mb-1">
                    {renderInlineFormatting(trimmed.slice(5))}
                  </h5>
                )
              }
              if (trimmed.startsWith('### ')) {
                return (
                  <h4 key={lineIdx} className="font-bold text-zinc-900 text-xs mt-3 mb-1">
                    {renderInlineFormatting(trimmed.slice(4))}
                  </h4>
                )
              }
              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={lineIdx} className="font-bold text-zinc-900 text-sm mt-3.5 mb-1.5">
                    {renderInlineFormatting(trimmed.slice(3))}
                  </h3>
                )
              }
              if (trimmed.startsWith('# ')) {
                return (
                  <h2 key={lineIdx} className="font-bold text-zinc-900 text-base mt-4 mb-2">
                    {renderInlineFormatting(trimmed.slice(2))}
                  </h2>
                )
              }

              // Bullets: •, *, -, · (with or without space, e.g. •Initialize SQLite...)
              if (/^(\*|\-|•|·)\s*/.test(trimmed)) {
                const bulletText = trimmed.replace(/^(\*|\-|•|·)\s*/, '')
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-2 my-0.5">
                    <span className="text-[#ea3a12] text-xs font-bold leading-5">•</span>
                    <span className="flex-1">{renderInlineFormatting(bulletText)}</span>
                  </div>
                )
              }

              // Numbered items (e.g. "1. Hardware Detection:" or "1.Hardware Detection:")
              const numMatch = trimmed.match(/^(\d+)\.\s*(.*)/)
              if (numMatch) {
                const num = numMatch[1]
                const text = numMatch[2]
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-2 my-0.5">
                    <span className="text-zinc-400 font-mono text-xs leading-5 font-semibold shrink-0">{num}.</span>
                    <span className="flex-1">{renderInlineFormatting(text)}</span>
                  </div>
                )
              }

              return <p key={lineIdx}>{renderInlineFormatting(line)}</p>
            })}
          </div>
        )
      })}
    </div>
  )
}

function cleanMathNotation(text: string): string {
  return text.replace(/\$([^\$]+)\$/g, (_, inner) => {
    return inner
      .replace(/\\text\{([^}]+)\}/g, '$1')
      .replace(/\\le\b/g, '≤')
      .replace(/\\ge\b/g, '≥')
      .replace(/\\pm\b/g, '±')
      .replace(/\\times\b/g, '×')
      .replace(/\\approx\b/g, '≈')
      .replace(/\\neq\b/g, '≠')
      .replace(/\\rightarrow\b/g, '→')
      .trim()
  })
}

function renderInlineFormatting(rawText: string) {
  const text = cleanMathNotation(rawText)
  const segments = text.split(/(\*\*.*?\*\*|`.*?`)/g)
  return segments.map((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      return <strong key={i} className="font-semibold text-zinc-900">{seg.slice(2, -2)}</strong>
    }
    if (seg.startsWith('`') && seg.endsWith('`')) {
      return (
        <code key={i} className="px-1 py-0.5 rounded bg-zinc-100 font-mono text-[11px] text-zinc-800 border border-zinc-200/80">
          {seg.slice(1, -1)}
        </code>
      )
    }
    return seg
  })
}
