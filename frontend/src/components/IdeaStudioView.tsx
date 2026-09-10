import React, { useState } from 'react'
import { ArrowRight, CheckCircle2, ExternalLink, FileCheck2, FileText, Lightbulb, MessageSquareText, Search, Send, Users } from 'lucide-react'
import { api } from '../lib/api'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Input } from './ui/Input'

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

  const researchMarket = () => sessionId && run('Researching market', async () => {
    const data = await api.researchMarket({ sessionId, productIdea: projectName, ideaDescription: briefDescription, depth: 'standard' })
    setResearch(data.teardown)
  })

  const synthesize = () => sessionId && research && run('Synthesizing blueprint', async () => {
    const data = await api.synthesizeBlueprint({ sessionId, ideaTitle: projectName, ideaDescription: briefDescription, marketResearch: research })
    setBlueprint(data.blueprint); setTab('market')
  })

  const initialize = () => sessionId && blueprint && run('Creating delivery plan', async () => {
    const data = await api.initializeProject({ sessionId, repoPath: repoPath.trim(), projectName: projectName.trim(), blueprint, marketResearch: research })
    onProjectInitialized(data.project)
  })

  if (!sessionId) {
    return (
      <div className="h-full overflow-y-auto pb-8">
        <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside aria-label="Idea shaping stages" tabIndex={0} className="w-full self-start overflow-x-auto rounded-none border-2 border-black bg-white p-4 focus:outline-none lg:sticky lg:top-0">
            <div className="mb-3 text-[10px] font-mono font-black uppercase tracking-wider text-swiss-red lg:mb-5">
              [PROTOCOL] STAGES
            </div>
            <ol className="flex gap-1 lg:block lg:space-y-1">
              <StudioStep n="01" label="PRODUCT BRIEF" detail="Define problem & persona" active />
              <StudioStep n="02" label="COUNCIL" detail="Challenge assumptions" />
              <StudioStep n="03" label="EVIDENCE" detail="Empirical market teardown" />
              <StudioStep n="04" label="BLUEPRINT" detail="System specification" />
              <StudioStep n="05" label="DELIVERY PLAN" detail="Approve and initialize" />
            </ol>
            <div className="mt-6 hidden border-t-2 border-black pt-4 lg:block">
              <div className="text-[10px] font-mono font-black uppercase text-black">NO PERSISTED DRIFT</div>
              <p className="mt-1 text-[10px] font-medium leading-relaxed text-neutral-600">
                Brief becomes durable once council session starts. Approval requires owner signoff.
              </p>
            </div>
          </aside>

          <Card className="overflow-hidden p-0 border-2 border-black bg-white rounded-none">
            <div className="border-b-2 border-black px-6 py-5 bg-white">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-mono font-black uppercase tracking-wider text-black">[01] PRODUCT BRIEF</h2>
                  <p className="mt-1 text-xs font-medium text-neutral-600">Provide the architectural council with context to audit the product proposal.</p>
                </div>
                <span className="shrink-0 rounded-none border-2 border-black bg-swiss-gray px-2.5 py-1 text-[10px] font-mono font-black text-black">
                  {briefSignals}/4 SIGNALS
                </span>
              </div>
            </div>

            <div className="space-y-6 p-6">
              <BriefSection icon={Lightbulb} title="IDEA CONCEPT" description="Working product name and primary user role.">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="WORKING PRODUCT NAME" hint="A clear descriptive title.">
                    <Input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="e.g. EVENT STREAMING BUS" />
                  </Field>
                  <Field label="PRIMARY USER PERSONA" hint="The core operator with the strongest pain point.">
                    <Input value={targetPersona} onChange={e => setTargetPersona(e.target.value)} placeholder="e.g. PLATFORM ENGINEER" />
                  </Field>
                </div>
              </BriefSection>

              <BriefSection icon={Users} title="PROBLEM & OUTCOME" description="Separate current pain from observable future outcome.">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="WHAT IS BROKEN TODAY?" hint="Describe concrete behaviors and consequences.">
                    <textarea
                      className="h-28 w-full rounded-none border-2 border-black bg-white p-3 text-xs font-medium leading-relaxed outline-none focus:border-swiss-red resize-none"
                      value={ideaDescription}
                      onChange={e => setIdeaDescription(e.target.value)}
                      placeholder="Teams struggle to orchestrate multi-repo releases because..."
                    />
                  </Field>
                  <Field label="WHAT BECOMES POSSIBLE?" hint="State the observable user or business impact.">
                    <textarea
                      className="h-28 w-full rounded-none border-2 border-black bg-white p-3 text-xs font-medium leading-relaxed outline-none focus:border-swiss-red resize-none"
                      value={desiredOutcome}
                      onChange={e => setDesiredOutcome(e.target.value)}
                      placeholder="Developers can verify hermetic commits and deploy automatically..."
                    />
                  </Field>
                </div>
              </BriefSection>

              <BriefSection icon={FileCheck2} title="BOUNDARIES" description="Define strict project limits and non-goals.">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="CONSTRAINTS" hint="Platform, runtime, or architectural limits.">
                    <textarea
                      className="h-24 w-full rounded-none border-2 border-black bg-white p-3 text-xs font-medium leading-relaxed outline-none focus:border-swiss-red resize-none"
                      value={constraints}
                      onChange={e => setConstraints(e.target.value)}
                      placeholder="Must run on Node.js 24 without external cloud databases..."
                    />
                  </Field>
                  <Field label="OUT OF SCOPE" hint="Explicit exclusions prevent scope creep.">
                    <textarea
                      className="h-24 w-full rounded-none border-2 border-black bg-white p-3 text-xs font-medium leading-relaxed outline-none focus:border-swiss-red resize-none"
                      value={nonGoals}
                      onChange={e => setNonGoals(e.target.value)}
                      placeholder="No custom authentication service in milestone 1..."
                    />
                  </Field>
                </div>
              </BriefSection>
            </div>

            {error && <p role="alert" className="mx-6 mb-4 rounded-none border-2 border-black bg-swiss-red p-3 text-xs font-mono font-bold text-white uppercase">{error}</p>}
            <div className="flex flex-col gap-3 border-t-2 border-black bg-swiss-gray px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[10px] font-mono font-bold uppercase text-neutral-600">
                REQUIRED: NAME, PRIMARY PERSONA, PROBLEM, AND OUTCOME
              </p>
              <Button onClick={start} disabled={!!busy || briefSignals < 4}>
                {busy || 'COMMENCE COUNCIL'} <ArrowRight className="h-4 w-4 ml-1" />
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
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto xl:overflow-hidden">
      <div role="region" className="flex shrink-0 items-center overflow-x-auto rounded-none border-2 border-black bg-white px-4 py-2.5" aria-label="Idea shaping progress">
        <JourneyItem icon={Lightbulb} label="01. BRIEF" state="done" />
        <JourneyItem icon={MessageSquareText} label="02. COUNCIL" state={studioStage === 2 ? 'active' : 'done'} />
        <JourneyItem icon={Search} label="03. EVIDENCE" state={studioStage === 3 ? 'active' : studioStage > 3 ? 'done' : 'next'} />
        <JourneyItem icon={FileText} label="04. BLUEPRINT" state={studioStage === 4 ? 'active' : 'next'} />
        <JourneyItem icon={FileCheck2} label="05. DELIVERY PLAN" state="next" last />
      </div>
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(320px,0.85fr)_minmax(520px,1.35fr)]">
        <Card className="flex min-h-[520px] flex-col overflow-hidden xl:min-h-0 border-2 border-black bg-white rounded-none">
          <div className="flex items-center justify-between border-b-2 border-black p-4 bg-white">
            <div>
              <div className="text-xs font-mono font-black uppercase tracking-wider text-black">[COUNCIL ROOM]</div>
              <div className="mt-0.5 text-xs font-bold text-neutral-600 uppercase truncate">{projectName}</div>
            </div>
            <span className="rounded-none border-2 border-black bg-swiss-gray px-2 py-0.5 text-[9px] font-mono font-black uppercase text-black">
              TRANSCRIPT PERSISTED
            </span>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4 bg-swiss-gray swiss-dots">
            {messages.map((message: any) => (
              <div
                key={message.id}
                className={`max-w-[88%] rounded-none border-2 border-black p-3.5 text-xs leading-relaxed ${
                  message.role === 'user'
                    ? 'ml-auto bg-black text-white'
                    : 'bg-white text-black'
                }`}
              >
                <div className={`mb-1 text-[9px] font-mono font-black uppercase tracking-wider ${message.role === 'user' ? 'text-swiss-red' : 'text-neutral-500'}`}>
                  {message.role === 'user' ? '[OWNER]' : `[${message.agent?.title?.toUpperCase() || 'COUNCIL'}]`}
                </div>
                <div className="whitespace-pre-wrap font-sans">{message.content}</div>
              </div>
            ))}
          </div>
          <div className="border-t-2 border-black p-3 bg-white">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {['@pm challenge market fit', '@designer map critical journey', '@architect identify technical risks', '@pjm find viable MVP'].map(x => (
                <button
                  key={x}
                  onClick={() => send(x)}
                  className="rounded-none border-2 border-black bg-white px-2.5 py-1 text-[10px] font-mono font-bold uppercase hover:bg-black hover:text-white transition-colors"
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
            <Stage n="01" title="RESEARCH" done={!!research} active={busy === 'Researching market'} onClick={researchMarket} disabled={!!busy} />
            <Stage n="02" title="BLUEPRINT" done={!!blueprint} active={busy === 'Synthesizing blueprint'} onClick={synthesize} disabled={!!busy || !research} />
            <Stage n="03" title="INITIALIZE" done={false} active={busy === 'Creating delivery plan'} onClick={() => {}} disabled />
          </div>
          {error && <div className="rounded-none border-2 border-black bg-swiss-red p-3 text-xs font-mono font-bold text-white uppercase">{error}</div>}
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-2 border-black bg-white rounded-none">
            {!blueprint ? (
              <div className="flex flex-1 flex-col items-center justify-center px-8 text-center bg-swiss-gray border-dashed border-black/20 m-3 rounded-none">
                <div className="w-12 h-12 bg-black text-white flex items-center justify-center mb-3 text-sm font-mono font-black border-2 border-black">
                  [E]
                </div>
                <h2 className="text-xs font-black uppercase tracking-wider text-black font-mono">
                  {research ? 'EMPIRICAL EVIDENCE READY' : 'GATHER EVIDENCE BEFORE DEFINING BLUEPRINT'}
                </h2>
                <p className="mt-2 max-w-md text-xs font-medium text-neutral-600 leading-relaxed">
                  {research
                    ? `${research.sources?.length || 0} sources and ${research.competitors?.length || 0} competitors cataloged. Synthesis will compile this into specification REQ-* items.`
                    : 'Market research is local-first, verifiable, and fails closed when evidence is insufficient.'}
                </p>
                {research ? (
                  <Button className="mt-4" onClick={synthesize} disabled={!!busy}>
                    {busy || 'SYNTHESIZE BLUEPRINT'}
                  </Button>
                ) : (
                  <Button className="mt-4" onClick={researchMarket} disabled={!!busy}>
                    {busy || 'GATHER MARKET EVIDENCE'}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="flex overflow-x-auto border-b-2 border-black px-3 pt-2 bg-white divide-x-2 divide-black">
                  {tabs.map(item => (
                    <button
                      key={item}
                      onClick={() => setTab(item)}
                      className={`px-4 py-2 text-xs font-mono font-black uppercase tracking-wider transition-colors ${
                        tab === item ? 'bg-black text-white' : 'text-black hover:bg-swiss-gray'
                      }`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto p-5 bg-white">
                  <BlueprintPanel tab={tab} blueprint={blueprint} research={research} />
                </div>
                <div className="border-t-2 border-black bg-swiss-gray p-4">
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <Input
                      value={repoPath}
                      onChange={e => setRepoPath(e.target.value)}
                      placeholder="/path/to/new/repository"
                      className="font-mono text-xs"
                    />
                    <Button variant="primary" onClick={initialize} disabled={!!busy || !repoPath.trim()}>
                      APPROVE PRD & INITIALIZE <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                  <p className="mt-2 text-[10px] font-mono font-bold uppercase text-neutral-600">
                    APPROVAL IMMUTABLY BINDS REQ-* IDENTIFIERS TO DELIVERY TASKS
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
    <li className={`flex min-w-[122px] items-center gap-2 rounded-none px-3 py-2 border-2 transition-colors lg:min-w-0 lg:gap-3 ${
      active ? 'bg-black text-white border-black' : 'bg-white text-black border-transparent hover:border-black'
    }`}>
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-none border font-mono text-[10px] font-black ${
        active ? 'border-white bg-white text-black' : done ? 'border-black bg-black text-white' : 'border-black bg-swiss-gray text-black'
      }`}>
        {done ? '✓' : n}
      </span>
      <span>
        <span className={`block text-[10px] font-black uppercase tracking-wider font-mono ${active ? 'text-white' : 'text-black'}`}>{label}</span>
        <span className={`hidden text-[9px] font-medium lg:block ${active ? 'text-neutral-300' : 'text-neutral-500'}`}>{detail}</span>
      </span>
    </li>
  )
}

function BriefSection({ icon: Icon, title, description, children }: any) {
  return (
    <section className="grid gap-4 border-b-2 border-black pb-6 last:border-0 last:pb-0 md:grid-cols-[180px_minmax(0,1fr)]">
      <div>
        <div className="flex items-center gap-2 text-xs font-black uppercase font-mono tracking-wider text-black">
          <Icon size={14} strokeWidth={2.5} className="text-swiss-red" />
          {title}
        </div>
        <p className="mt-1.5 text-[10px] font-medium leading-relaxed text-neutral-600">{description}</p>
      </div>
      <div>{children}</div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-black font-mono">{label}</span>
      {children}
      <span className="mt-1.5 block text-[9px] font-medium text-neutral-500">{hint}</span>
    </label>
  )
}

function JourneyItem({ icon: Icon, label, state, last = false }: any) {
  return (
    <>
      <div className={`flex shrink-0 items-center gap-2 rounded-none px-3 py-1.5 border-2 border-black text-[10px] font-mono font-black uppercase ${
        state === 'active' ? 'bg-black text-white' : state === 'done' ? 'bg-swiss-gray text-black' : 'bg-white text-neutral-400'
      }`}>
        <Icon size={13} />
        <span>{label}</span>
        {state === 'done' && <span aria-hidden="true" className="text-emerald-700 font-bold ml-1">✓</span>}
      </div>
      {!last && <div className="mx-1 h-[2px] w-4 shrink-0 bg-black sm:w-8" />}
    </>
  )
}

function Stage({ n, title, done, active, onClick, disabled }: any) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-none border-2 border-black p-3 text-left transition-colors duration-150 ${
        done
          ? 'bg-black text-white'
          : active
          ? 'bg-swiss-red text-white'
          : 'bg-white text-black hover:bg-swiss-gray'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-none border border-black bg-white text-black text-[10px] font-mono font-black">
          {done ? '✓' : n}
        </span>
        <span className="text-xs font-mono font-black uppercase tracking-wider">{active ? `${title}…` : title}</span>
      </div>
    </button>
  )
}

function BlueprintPanel({ tab, blueprint, research }: any) {
  if (tab === 'market') return (
    <div className="space-y-4">
      <Section title="VALUE PROPOSITION">
        <p className="font-medium text-neutral-800">{blueprint.market.coreValueProp}</p>
        <p className="mt-2 text-xs font-mono text-swiss-red uppercase font-bold">TARGET: {blueprint.market.targetAudience}</p>
      </Section>
      <div className="grid gap-3 md:grid-cols-2">
        {blueprint.market.competitors.map((x: any) => (
          <Section key={x.name} title={x.name.toUpperCase()}>
            <p className="text-neutral-700">{x.positioning}</p>
            {x.url && (
              <a className="mt-2 inline-flex items-center gap-1 font-mono font-bold text-swiss-red text-[11px] hover:underline uppercase" href={x.url} target="_blank" rel="noreferrer">
                EVIDENCE SOURCE <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </Section>
        ))}
      </div>
      <Section title="EVIDENCE SOURCES">
        <div className="space-y-2 font-mono text-xs">
          {research?.sources?.map((x: any) => (
            <a key={x.url} href={x.url} target="_blank" rel="noreferrer" className="block text-black hover:text-swiss-red font-bold underline truncate">
              · {x.title}
            </a>
          ))}
        </div>
      </Section>
    </div>
  )

  if (tab === 'prd') return (
    <div className="space-y-3">
      <Section title="EXECUTIVE SUMMARY">
        <p className="font-medium text-neutral-800 leading-relaxed">{blueprint.prd.executiveSummary}</p>
      </Section>
      {blueprint.prd.requirements.map((x: any) => (
        <Section key={x.id} title={`[${x.id}] ${x.title.toUpperCase()}`}>
          <p className="text-neutral-700 leading-relaxed">{x.description}</p>
          <div className="mt-3 space-y-1.5 border-t border-black/15 pt-2">
            <span className="text-[10px] font-mono font-black uppercase text-neutral-500">ACCEPTANCE CRITERIA</span>
            {x.acceptanceCriteria.map((c: string) => (
              <div key={c} className="flex gap-2 text-neutral-800 font-medium">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" />
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
        <Section key={`${x.persona}-${x.goal}`} title={`${x.persona.toUpperCase()} → ${x.goal.toUpperCase()}`}>
          <ol className="space-y-2">
            {x.steps.map((s: string, i: number) => (
              <li key={s} className="flex items-start gap-2">
                <span className="font-mono font-bold text-swiss-red text-[11px] shrink-0">{i + 1}.</span>
                <span className="text-neutral-800 font-medium">{s}</span>
              </li>
            ))}
          </ol>
        </Section>
      ))}
    </div>
  )

  if (tab === 'architecture') return (
    <div className="space-y-3">
      <Section title="SYSTEM ARCHITECTURE & RUNTIME">
        <p className="font-mono text-xs font-bold text-black">{blueprint.architecture.techStack}</p>
      </Section>
      {blueprint.architecture.apiContracts.map((x: any) => (
        <Section key={`${x.method}-${x.path}`} title={`${x.method.toUpperCase()} ${x.path}`}>
          <p className="text-neutral-700 font-medium">{x.purpose}</p>
        </Section>
      ))}
    </div>
  )

  return (
    <div className="space-y-3">
      {blueprint.roadmap.milestones.map((x: any) => (
        <Section key={x.title} title={x.title.toUpperCase()}>
          {x.tasks.map((t: any) => (
            <div key={t.title} className="mb-2 rounded-none border-2 border-black bg-white p-3">
              <strong className="font-black uppercase text-black block">{t.title}</strong>
              <p className="mt-1 text-neutral-600 font-medium">{t.description}</p>
            </div>
          ))}
        </Section>
      ))}
    </div>
  )
}

function Section({ title, children }: any) {
  return (
    <section className="rounded-none border-2 border-black bg-swiss-gray p-4 text-xs leading-relaxed">
      <h3 className="mb-2 font-mono font-black uppercase tracking-wider text-black border-b border-black/15 pb-1">
        {title}
      </h3>
      {children}
    </section>
  )
}
