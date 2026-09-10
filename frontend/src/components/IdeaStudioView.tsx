import React, { useState, useCallback } from 'react'
import { ArrowRight, CheckCircle2, Database, ExternalLink, FileCheck2, FileText, Lightbulb, MessageSquareText, RefreshCw, Search, Send, Sparkles, Users } from 'lucide-react'
import { api } from '../lib/api'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Input } from './ui/Input'
import { useOrchestratorEvents } from '../hooks/useOrchestratorEvents'

interface IdeaStudioViewProps {
  onProjectInitialized: (project: any) => void
}

type BlueprintTab = 'market' | 'prd' | 'journeys' | 'architecture' | 'roadmap'

export function IdeaStudioView({ onProjectInitialized }: IdeaStudioViewProps) {
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
  const [tab, setTab] = useState<BlueprintTab>('market')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [studioProgress, setStudioProgress] = useState<string | null>(null)

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
    setSessionId(data.session.id); setMessages(data.session.messages); setResearch(null); setBlueprint(null)
  })

  const send = (text = prompt) => {
    if (!sessionId || !text.trim()) return
    setPrompt('')
    run('Consulting council', async () => {
      const data = await api.councilTurn(sessionId, text.trim())
      setMessages(data.session.messages)
    })
  }

  const conveneDebate = () => sessionId && run('Council debate in progress...', async () => {
    const data = await api.conveneDebate(sessionId)
    setMessages(data.session.messages)
  })

  const researchMarket = () => sessionId && run('Researching market', async () => {
    const data = await api.researchMarket({ sessionId, productIdea: projectName, ideaDescription: briefDescription, depth: 'standard' })
    setResearch(data.teardown)
  })

  const synthesize = () => sessionId && research && run('Synthesizing blueprint', async () => {
    const data = await api.synthesizeBlueprint({ sessionId, ideaTitle: projectName, ideaDescription: briefDescription, marketResearch: research })
    setBlueprint(data.blueprint); setTab('market')
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

  if (!sessionId) {
    return (
      <div className="h-full overflow-y-auto pb-8 p-4">
        <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside aria-label="Idea shaping stages" tabIndex={0} className="w-full self-start overflow-x-auto rounded-xl border border-zinc-200 bg-white p-4 focus:outline-none lg:sticky lg:top-0 shadow-2xs">
            <div className="mb-3 text-xs font-semibold text-[#ea3a12] lg:mb-4">
              Idea shaping protocol
            </div>
            <ol className="flex gap-1 lg:block lg:space-y-1">
              <StudioStep n="01" label="Product brief" detail="Define problem & persona" active />
              <StudioStep n="02" label="Council" detail="Challenge assumptions" />
              <StudioStep n="03" label="Evidence" detail="Empirical market teardown" />
              <StudioStep n="04" label="Blueprint" detail="System specification" />
              <StudioStep n="05" label="Delivery plan" detail="Approve and initialize" />
            </ol>
            <div className="mt-6 hidden border-t border-zinc-100 pt-4 lg:block">
              <div className="text-xs font-semibold text-zinc-900">No persisted drift</div>
              <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed">
                Brief becomes durable once council session starts. Approval requires owner signoff.
              </p>
            </div>
          </aside>

          <Card className="overflow-hidden p-0 border border-zinc-200 bg-white rounded-xl shadow-2xs">
            <div className="border-b border-zinc-100 px-6 py-4 bg-white">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">Product brief</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">Provide the architectural council with context to audit the product proposal.</p>
                </div>
                <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
                  {briefSignals}/4 essentials
                </span>
              </div>
            </div>

            <div className="space-y-6 p-6">
              <BriefSection icon={Lightbulb} title="Idea concept" description="Working product name and primary user role.">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Working product name" hint="A clear descriptive title.">
                    <Input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="e.g. Event Streaming Bus" />
                  </Field>
                  <Field label="Primary user persona" hint="The core operator with the strongest pain point.">
                    <Input value={targetPersona} onChange={e => setTargetPersona(e.target.value)} placeholder="e.g. Platform engineer" />
                  </Field>
                </div>
              </BriefSection>

              <BriefSection icon={Users} title="Problem & outcome" description="Separate current pain from observable future outcome.">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="What is broken today?" hint="Describe concrete behaviors and consequences.">
                    <textarea
                      className="h-28 w-full rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                      value={ideaDescription}
                      onChange={e => setIdeaDescription(e.target.value)}
                      placeholder="Teams struggle to orchestrate multi-repo releases because..."
                    />
                  </Field>
                  <Field label="What becomes possible?" hint="State the observable user or business impact.">
                    <textarea
                      className="h-28 w-full rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                      value={desiredOutcome}
                      onChange={e => setDesiredOutcome(e.target.value)}
                      placeholder="Developers can verify hermetic commits and deploy automatically..."
                    />
                  </Field>
                </div>
              </BriefSection>

              <BriefSection icon={FileCheck2} title="Boundaries" description="Define strict project limits and non-goals.">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Constraints" hint="Platform, runtime, or architectural limits.">
                    <textarea
                      className="h-24 w-full rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                      value={constraints}
                      onChange={e => setConstraints(e.target.value)}
                      placeholder="Must run on Node.js 24 without external cloud databases..."
                    />
                  </Field>
                  <Field label="Out of scope" hint="Explicit exclusions prevent scope creep.">
                    <textarea
                      className="h-24 w-full rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none shadow-2xs"
                      value={nonGoals}
                      onChange={e => setNonGoals(e.target.value)}
                      placeholder="No custom authentication service in milestone 1..."
                    />
                  </Field>
                </div>
              </BriefSection>
            </div>

            {error && <p role="alert" className="mx-6 mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-700">{error}</p>}
            <div className="flex flex-col gap-3 border-t border-zinc-100 bg-zinc-50 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-zinc-500">
                Required: name, primary persona, problem, and desired outcome.
              </p>
              <Button onClick={start} disabled={!!busy || briefSignals < 4}>
                {busy || 'Commence council'} <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  const tabs: BlueprintTab[] = ['market', 'prd', 'journeys', 'architecture', 'roadmap']
  const studioStage = blueprint ? 4 : research ? 3 : 2
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto xl:overflow-hidden p-4">
      <div role="region" className="flex shrink-0 items-center overflow-x-auto rounded-xl border border-zinc-200 bg-white px-4 py-2.5 shadow-2xs" aria-label="Idea shaping progress">
        <JourneyItem icon={Lightbulb} label="01. Brief" state="done" />
        <JourneyItem icon={MessageSquareText} label="02. Council" state={studioStage === 2 ? 'active' : 'done'} />
        <JourneyItem icon={Search} label="03. Evidence" state={studioStage === 3 ? 'active' : studioStage > 3 ? 'done' : 'next'} />
        <JourneyItem icon={FileText} label="04. Blueprint" state={studioStage === 4 ? 'active' : 'next'} />
        <JourneyItem icon={FileCheck2} label="05. Delivery plan" state="next" last />
      </div>
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(340px,0.88fr)_minmax(520px,1.35fr)]">
        <Card className="flex min-h-[520px] flex-col overflow-hidden xl:min-h-0 border border-zinc-200 bg-white rounded-xl shadow-2xs">
          <div className="flex items-center justify-between border-b border-zinc-100 p-4 bg-white">
            <div>
              <div className="text-xs font-semibold text-zinc-900">Council room</div>
              <div className="mt-0.5 text-xs text-zinc-500 truncate">{projectName}</div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={conveneDebate}
                disabled={!!busy}
                className="h-7 text-xs border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-800"
              >
                {busy === 'Council debate in progress...' ? (
                  <>
                    <RefreshCw className="h-3 w-3 animate-spin mr-1 text-[#ea3a12]" />
                    Debating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3 mr-1 text-[#ea3a12]" />
                    Convene debate
                  </>
                )}
              </Button>
              <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-[10px] font-medium text-zinc-600">
                Saved
              </span>
            </div>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4 bg-zinc-50/40 swiss-dots">
            {messages.map((message: any) => (
              <div
                key={message.id}
                className={`max-w-[88%] rounded-xl border p-3.5 text-xs leading-relaxed shadow-2xs ${
                  message.role === 'user'
                    ? 'ml-auto bg-zinc-900 text-white border-zinc-900'
                    : 'bg-white text-zinc-900 border-zinc-200/80'
                }`}
              >
                <div className={`mb-1 text-[10px] font-semibold ${message.role === 'user' ? 'text-[#ea3a12]' : 'text-zinc-400'}`}>
                  {message.role === 'user' ? 'Owner' : (message.agent?.title || 'Council')}
                </div>
                <div className="whitespace-pre-wrap font-sans">{message.content}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-zinc-100 p-3 bg-white">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {['@pm challenge market fit', '@designer map critical journey', '@architect identify technical risks', '@pjm find viable MVP'].map(x => (
                <button
                  key={x}
                  onClick={() => send(x)}
                  className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-50 transition-colors shadow-2xs"
                >
                  {x}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && send()}
                placeholder="Question the specialist council..."
              />
              <Button aria-label="Send question to council" size="sm" onClick={() => send()} disabled={!!busy || !prompt.trim()}>
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </Card>

        <div className="flex min-h-[520px] flex-col gap-3 xl:min-h-0">
          <div className="grid grid-cols-3 gap-2">
            <Stage
              n="01"
              title="Research"
              done={!!research}
              active={busy === 'Researching market'}
              onClick={researchMarket}
              disabled={!!busy}
              badge={research ? 'Cached ✓' : null}
            />
            <Stage
              n="02"
              title="Blueprint"
              done={!!blueprint}
              active={busy === 'Synthesizing blueprint'}
              onClick={synthesize}
              disabled={!!busy || !research}
            />
            <Stage
              n="03"
              title="Initialize"
              done={false}
              active={busy === 'Creating delivery plan'}
              onClick={() => {}}
              disabled
            />
          </div>
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-700">{error}</div>}
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border border-zinc-200 bg-white rounded-xl shadow-2xs">
            {!blueprint ? (
              <div className="flex flex-1 flex-col items-center justify-center px-8 text-center bg-zinc-50/50 border border-dashed border-zinc-200 m-4 rounded-xl">
                <div className="w-12 h-12 rounded-xl bg-zinc-100 text-zinc-700 flex items-center justify-center mb-3 text-sm font-semibold border border-zinc-200">
                  E
                </div>
                <h2 className="text-sm font-semibold text-zinc-900">
                  {research ? 'Empirical evidence ready to review' : 'Gather evidence before defining blueprint'}
                </h2>
                <p className="mt-1.5 max-w-md text-xs text-zinc-500 leading-relaxed">
                  {research
                    ? `${research.sources?.length || 0} sources and ${research.competitors?.length || 0} competitors cataloged. Synthesis will compile this into specification items.`
                    : 'Market research runs in the background or on-demand to source facts without hallucinations.'}
                </p>
                {research ? (
                  <Button className="mt-4" onClick={synthesize} disabled={!!busy}>
                    {busy || 'Synthesize blueprint'}
                  </Button>
                ) : (
                  <Button className="mt-4" onClick={researchMarket} disabled={!!busy}>
                    {busy || 'Gather market evidence'}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="flex overflow-x-auto border-b border-zinc-100 px-3 pt-2 bg-white gap-1">
                  {tabs.map(item => (
                    <button
                      key={item}
                      onClick={() => setTab(item)}
                      className={`px-3.5 py-1.5 text-xs font-medium capitalize rounded-lg transition-colors ${
                        tab === item ? 'bg-zinc-900 text-white shadow-xs' : 'text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto p-5 bg-white">
                  <BlueprintPanel
                    tab={tab}
                    blueprint={blueprint}
                    research={research}
                    onTogglePriority={toggleRequirementPriority}
                  />
                </div>
                <div className="border-t border-zinc-100 bg-zinc-50 p-4">
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <Input
                      value={repoPath}
                      onChange={e => setRepoPath(e.target.value)}
                      placeholder="/path/to/new/repository"
                      className="font-mono text-xs"
                      disabled={!!busy}
                    />
                    <Button variant="primary" onClick={initialize} disabled={!!busy || !repoPath.trim()}>
                      {busy === 'Creating delivery plan' ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1 text-white" />
                          Initializing plan...
                        </>
                      ) : (
                        <>
                          Approve PRD & initialize <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </div>
                  {studioProgress && (
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-700 bg-white border border-zinc-200 px-3 py-2 rounded-lg mt-3 shadow-2xs">
                      <span className="h-2 w-2 rounded-full bg-[#ea3a12] animate-ping" />
                      <span>{studioProgress}</span>
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-zinc-500">
                    Approval immutably binds requirement identifiers to delivery tasks.
                  </p>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function StudioStep({ n, label, detail, active = false, done = false }: { n: string; label: string; detail: string; active?: boolean; done?: boolean }) {
  return (
    <li className={`flex min-w-[122px] items-center gap-2.5 rounded-lg px-3 py-2 transition-colors lg:min-w-0 lg:gap-3 ${
      active ? 'bg-zinc-900 text-white shadow-xs' : 'text-zinc-700 hover:bg-zinc-100'
    }`}>
      <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold ${
        active ? 'bg-white text-zinc-900' : done ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600'
      }`}>
        {done ? '✓' : n}
      </span>
      <span>
        <span className={`block text-xs font-medium ${active ? 'text-white font-semibold' : 'text-zinc-800'}`}>{label}</span>
        <span className={`hidden text-[10px] lg:block ${active ? 'text-zinc-300' : 'text-zinc-400'}`}>{detail}</span>
      </span>
    </li>
  )
}

function BriefSection({ icon: Icon, title, description, children }: any) {
  return (
    <section className="grid gap-4 border-b border-zinc-100 pb-6 last:border-0 last:pb-0 md:grid-cols-[180px_minmax(0,1fr)]">
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-900">
          <Icon size={14} strokeWidth={2} className="text-[#ea3a12]" />
          {title}
        </div>
        <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{description}</p>
      </div>
      <div>{children}</div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700">{label}</span>
      {children}
      <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>
    </label>
  )
}

function JourneyItem({ icon: Icon, label, state, last = false }: any) {
  return (
    <>
      <div className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium ${
        state === 'active' ? 'bg-zinc-900 text-white shadow-xs' : state === 'done' ? 'bg-zinc-100 text-zinc-800' : 'bg-white text-zinc-400'
      }`}>
        <Icon size={13} />
        <span>{label}</span>
        {state === 'done' && <span aria-hidden="true" className="text-emerald-600 font-semibold ml-1">✓</span>}
      </div>
      {!last && <div className="mx-1 h-[1px] w-4 shrink-0 bg-zinc-200 sm:w-8" />}
    </>
  )
}

function Stage({ n, title, done, active, onClick, disabled, badge = null }: any) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border p-3 text-left transition-all duration-150 ${
        done
          ? 'bg-zinc-900 text-white border-zinc-900 shadow-xs'
          : active
          ? 'bg-[#ea3a12] text-white border-[#ea3a12] shadow-xs'
          : 'bg-white text-zinc-800 border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 shadow-2xs'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-800 text-[10px] font-bold font-mono">
            {done ? '✓' : n}
          </span>
          <span className="text-xs font-medium">{active ? `${title}…` : title}</span>
        </div>
        {badge && (
          <span className="text-[9px] font-medium text-emerald-400 bg-zinc-800 px-1.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}
      </div>
    </button>
  )
}

function BlueprintPanel({ tab, blueprint, research, onTogglePriority }: any) {
  if (tab === 'market') return (
    <div className="space-y-4">
      <Section title="Value proposition">
        <p className="text-zinc-800">{blueprint.market.coreValueProp}</p>
        <p className="mt-2 text-xs font-mono text-[#ea3a12]">Target: {blueprint.market.targetAudience}</p>
      </Section>
      <div className="grid gap-3 md:grid-cols-2">
        {blueprint.market.competitors.map((x: any) => (
          <Section key={x.name} title={x.name}>
            <p className="text-zinc-600">{x.positioning}</p>
            {x.url && (
              <a className="mt-2 inline-flex items-center gap-1 text-xs text-[#ea3a12] hover:underline" href={x.url} target="_blank" rel="noreferrer">
                Source <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </Section>
        ))}
      </div>
      <Section title="Evidence sources">
        <div className="space-y-2 text-xs">
          {research?.sources?.map((x: any) => (
            <a key={x.url} href={x.url} target="_blank" rel="noreferrer" className="block text-zinc-800 hover:text-[#ea3a12] underline truncate">
              · {x.title}
            </a>
          ))}
        </div>
      </Section>
    </div>
  )

  if (tab === 'prd') return (
    <div className="space-y-3">
      <Section title="Executive summary">
        <p className="text-zinc-700 leading-relaxed">{blueprint.prd.executiveSummary}</p>
      </Section>
      <div className="flex items-center justify-between text-xs text-zinc-500 pt-1">
        <span>Click priority pill (MUST / SHOULD / COULD) to toggle MoSCoW allocation</span>
        <span>{blueprint.prd.requirements.length} requirements</span>
      </div>
      {blueprint.prd.requirements.map((x: any) => (
        <Section key={x.id} title={`${x.id} · ${x.title}`}>
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => onTogglePriority && onTogglePriority(x.id)}
              title="Click to toggle priority"
              className={`px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors cursor-pointer border ${
                x.priority === 'MUST'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                  : x.priority === 'SHOULD'
                  ? 'bg-sky-50 text-sky-800 border-sky-300'
                  : 'bg-amber-50 text-amber-800 border-amber-300'
              }`}
            >
              {x.priority} ⟳
            </button>
            <span className="text-xs text-zinc-600">{x.description}</span>
          </div>
          <div className="mt-3 space-y-1.5 border-t border-zinc-100 pt-2">
            <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Acceptance criteria</span>
            {x.acceptanceCriteria.map((c: string) => (
              <div key={c} className="flex gap-2 text-zinc-700 text-xs">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                {c}
              </div>
            ))}
          </div>
        </Section>
      ))}
    </div>
  )

  if (tab === 'journeys') return (
    <div className="space-y-3">
      {blueprint.userJourneys.map((x: any) => (
        <Section key={`${x.persona}-${x.goal}`} title={`${x.persona} → ${x.goal}`}>
          <ol className="space-y-2">
            {x.steps.map((s: string, i: number) => (
              <li key={s} className="flex items-start gap-2 text-xs">
                <span className="font-mono font-medium text-[#ea3a12] shrink-0">{i + 1}.</span>
                <span className="text-zinc-700">{s}</span>
              </li>
            ))}
          </ol>
        </Section>
      ))}
    </div>
  )

  if (tab === 'architecture') return (
    <div className="space-y-4">
      <Section title="System architecture & runtime">
        <p className="font-mono text-xs text-zinc-800 font-medium">{blueprint.architecture.techStack}</p>
      </Section>

      {/* Relational Database Schema Visualizer */}
      {blueprint.architecture?.databaseSchema?.tables && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-900">
            <Database size={14} className="text-[#ea3a12]" />
            <span>Relational database schema</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {blueprint.architecture.databaseSchema.tables.map((table: any) => (
              <div key={table.name} className="rounded-xl border border-zinc-200/80 bg-white p-3.5 shadow-2xs">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-100">
                  <span className="font-mono text-xs font-bold text-zinc-900">{table.name}</span>
                  <span className="text-[10px] font-mono text-zinc-400">{table.columns?.length || 0} cols</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {table.columns?.map((col: string) => (
                    <span key={col} className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-zinc-50 border border-zinc-200/90 text-zinc-700">
                      {col}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* API Contracts Visualizer */}
      {blueprint.architecture?.apiContracts && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-xs font-semibold text-zinc-900">
            <span>API contracts</span>
            <span className="text-[10px] font-mono text-zinc-400">{blueprint.architecture.apiContracts.length} endpoints</span>
          </div>
          <div className="flex flex-col gap-2">
            {blueprint.architecture.apiContracts.map((api: any) => (
              <div key={`${api.method}-${api.path}`} className="flex items-center justify-between p-3 rounded-lg border border-zinc-200/80 bg-white text-xs shadow-2xs">
                <div className="flex items-center gap-2.5 font-mono">
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                    api.method === 'GET' ? 'bg-sky-50 text-sky-700 border border-sky-200' :
                    api.method === 'POST' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                    api.method === 'PUT' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                    'bg-rose-50 text-rose-700 border border-rose-200'
                  }`}>
                    {api.method}
                  </span>
                  <span className="font-semibold text-zinc-900">{api.path}</span>
                </div>
                <span className="text-zinc-500 text-[11px] max-w-sm truncate">{api.purpose}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-3">
      {blueprint.roadmap.milestones.map((x: any) => (
        <Section key={x.title} title={x.title}>
          {x.tasks.map((t: any) => (
            <div key={t.title} className="mb-2 rounded-lg border border-zinc-200 bg-white p-3 shadow-2xs">
              <strong className="font-semibold text-zinc-900 block text-xs">{t.title}</strong>
              <p className="mt-1 text-zinc-500 text-xs">{t.description}</p>
            </div>
          ))}
        </Section>
      ))}
    </div>
  )
}

function Section({ title, children }: any) {
  return (
    <section className="rounded-xl border border-zinc-200/80 bg-zinc-50/50 p-4 text-xs leading-relaxed shadow-2xs">
      <h3 className="mb-2 font-semibold text-zinc-900 border-b border-zinc-100 pb-1">
        {title}
      </h3>
      {children}
    </section>
  )
}
