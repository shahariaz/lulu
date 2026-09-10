import React, { useState } from 'react'
import { ArrowRight, CheckCircle2, ExternalLink, FileCheck2, FileText, Lightbulb, MessageSquareText, Search, Send, Users } from 'lucide-react'
import { api } from '../lib/api'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Input } from './ui/Input'

interface IdeaStudioViewProps { onProjectInitialized: (project: any) => void }
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

  if (!sessionId) return (
    <div className="h-full overflow-y-auto pb-8">
      <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label="Idea shaping stages" tabIndex={0} className="w-full self-start overflow-x-auto rounded-lg border border-border bg-[#efefec] p-3 focus:outline-none focus:ring-2 focus:ring-accent/20 lg:sticky lg:top-0 lg:p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted lg:mb-5">From idea to plan</div>
          <ol className="flex gap-1 lg:block lg:space-y-1">
            <StudioStep n="1" label="Product brief" detail="Define the problem" active />
            <StudioStep n="2" label="Council" detail="Challenge assumptions" />
            <StudioStep n="3" label="Evidence" detail="Research the market" />
            <StudioStep n="4" label="Blueprint" detail="Review the product" />
            <StudioStep n="5" label="Delivery plan" detail="Approve and initialize" />
          </ol>
          <div className="mt-6 hidden border-t border-border pt-4 lg:block">
            <div className="text-[10px] font-semibold text-foreground">Nothing is generated yet</div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted">Your brief becomes durable only when the council session starts. Approval remains a separate owner action.</p>
          </div>
        </aside>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-border px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div><h2 className="text-base font-semibold">Product brief</h2><p className="mt-1 text-xs leading-relaxed text-muted">Give the council enough context to question the idea constructively. Keep unknowns honest.</p></div>
              <span className="shrink-0 rounded border border-border bg-[#f5f5f3] px-2 py-1 text-[10px] font-medium text-muted">{briefSignals}/4 essentials</span>
            </div>
          </div>

          <div className="space-y-6 p-6">
            <BriefSection icon={Lightbulb} title="Idea" description="Name the concept and the person it should serve.">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Working product name" hint="A clear working title is enough."><Input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="Product or feature name" /></Field>
                <Field label="Primary user" hint="Choose the person with the strongest need."><Input value={targetPersona} onChange={e => setTargetPersona(e.target.value)} placeholder="Role or user group" /></Field>
              </div>
            </BriefSection>

            <BriefSection icon={Users} title="Problem and outcome" description="Separate the current pain from the change you want to create.">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="What is broken today?" hint="Describe behavior and consequences, not a solution."><textarea className="h-28 w-full rounded-md border border-border bg-white p-3 text-sm leading-5 outline-none focus:border-accent focus:ring-2 focus:ring-accent/10" value={ideaDescription} onChange={e => setIdeaDescription(e.target.value)} placeholder="Users struggle to… because…" /></Field>
                <Field label="What should become possible?" hint="State an observable user or business outcome."><textarea className="h-28 w-full rounded-md border border-border bg-white p-3 text-sm leading-5 outline-none focus:border-accent focus:ring-2 focus:ring-accent/10" value={desiredOutcome} onChange={e => setDesiredOutcome(e.target.value)} placeholder="After this exists, users can…" /></Field>
              </div>
            </BriefSection>

            <BriefSection icon={FileCheck2} title="Boundaries" description="Tell the council where it must not guess.">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Constraints" hint="Technical, legal, budget, timing, or platform limits."><textarea className="h-24 w-full rounded-md border border-border bg-white p-3 text-sm leading-5 outline-none focus:border-accent focus:ring-2 focus:ring-accent/10" value={constraints} onChange={e => setConstraints(e.target.value)} placeholder="Must work offline; no third-party storage…" /></Field>
                <Field label="Out of scope" hint="Explicit exclusions prevent accidental product growth."><textarea className="h-24 w-full rounded-md border border-border bg-white p-3 text-sm leading-5 outline-none focus:border-accent focus:ring-2 focus:ring-accent/10" value={nonGoals} onChange={e => setNonGoals(e.target.value)} placeholder="Not building mobile apps in the first release…" /></Field>
              </div>
            </BriefSection>
          </div>

          {error && <p role="alert" className="mx-6 mb-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-xs text-danger">{error}</p>}
          <div className="flex flex-col gap-3 border-t border-border bg-[#fafaf8] px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[10px] text-muted">Required: name, primary user, problem, and desired outcome.</p>
            <Button onClick={start} disabled={!!busy || briefSignals < 4}>{busy || 'Continue to council'} <ArrowRight className="h-4 w-4" /></Button>
          </div>
        </Card>
      </div>
    </div>
  )

  const tabs: BlueprintTab[] = ['market', 'prd', 'journeys', 'architecture', 'roadmap']
  const studioStage = blueprint ? 4 : research ? 3 : 2
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto xl:overflow-hidden">
      <div role="region" className="flex shrink-0 items-center overflow-x-auto rounded-lg border border-border bg-white px-3 py-2" aria-label="Idea shaping progress">
        <JourneyItem icon={Lightbulb} label="Brief" state="done" />
        <JourneyItem icon={MessageSquareText} label="Council" state={studioStage === 2 ? 'active' : 'done'} />
        <JourneyItem icon={Search} label="Evidence" state={studioStage === 3 ? 'active' : studioStage > 3 ? 'done' : 'next'} />
        <JourneyItem icon={FileText} label="Blueprint" state={studioStage === 4 ? 'active' : 'next'} />
        <JourneyItem icon={FileCheck2} label="Delivery plan" state="next" last />
      </div>
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(320px,0.82fr)_minmax(520px,1.35fr)]">
      <Card className="flex min-h-[520px] flex-col overflow-hidden xl:min-h-0">
        <div className="flex items-center justify-between border-b border-border p-4"><div><div className="text-xs font-semibold">Council room</div><div className="mt-1 text-[10px] text-muted">{projectName}</div></div><span className="rounded border border-border bg-[#f5f5f3] px-2 py-1 text-[9px] font-medium text-muted">Transcript saved</span></div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.map((message: any) => <div key={message.id} className={`max-w-[90%] rounded-lg border p-3 text-xs leading-5 ${message.role === 'user' ? 'ml-auto border-accent/30 bg-blue-50' : 'border-border bg-[#f5f5f3]'}`}><div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted">{message.role === 'user' ? 'Owner' : message.agent?.title || 'Council'}</div><div className="whitespace-pre-wrap">{message.content}</div></div>)}
        </div>
        <div className="border-t border-border p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">{['@pm challenge market fit', '@designer map the critical journey', '@architect identify technical risks', '@pjm find the smallest viable milestone'].map(x => <button key={x} onClick={() => send(x)} className="rounded-full border border-border px-2 py-1 text-[10px] text-muted hover:border-accent/40 hover:text-foreground">{x}</button>)}</div>
          <div className="flex gap-2"><Input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Ask a specialist…" /><Button aria-label="Send question to council" size="sm" onClick={() => send()} disabled={!!busy || !prompt.trim()}><Send className="h-3.5 w-3.5" /></Button></div>
        </div>
      </Card>

      <div className="flex min-h-[520px] flex-col gap-3 xl:min-h-0">
        <div className="grid grid-cols-3 gap-2">
          <Stage n="1" title="Research" done={!!research} active={busy === 'Researching market'} onClick={researchMarket} disabled={!!busy} />
          <Stage n="2" title="Blueprint" done={!!blueprint} active={busy === 'Synthesizing blueprint'} onClick={synthesize} disabled={!!busy || !research} />
          <Stage n="3" title="Initialize" done={false} active={busy === 'Creating delivery plan'} onClick={() => {}} disabled />
        </div>
        {error && <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{error}</div>}
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {!blueprint ? <div className="flex flex-1 flex-col items-center justify-center px-8 text-center"><Search className="mb-4 h-8 w-8 text-muted" /><h2 className="text-sm font-semibold">{research ? 'Evidence is ready to review' : 'Gather evidence before defining the product'}</h2><p className="mt-2 max-w-md text-xs leading-5 text-muted">{research ? `${research.sources?.length || 0} sources and ${research.competitors?.length || 0} competitors were recorded. Synthesis will use this evidence and the persisted council transcript.` : 'Market research is sourced and fails closed when reliable evidence is unavailable.'}</p>{research ? <Button className="mt-5" onClick={synthesize} disabled={!!busy}>{busy || 'Create blueprint'}</Button> : <Button className="mt-5" onClick={researchMarket} disabled={!!busy}>{busy || 'Gather market evidence'}</Button>}</div> : <>
            <div className="flex overflow-x-auto border-b border-border px-3 pt-2">{tabs.map(item => <button key={item} onClick={() => setTab(item)} className={`border-b-2 px-3 py-2 text-xs capitalize ${tab === item ? 'border-accent text-accent' : 'border-transparent text-muted'}`}>{item}</button>)}</div>
            <div className="flex-1 overflow-y-auto p-5"><BlueprintPanel tab={tab} blueprint={blueprint} research={research} /></div>
            <div className="border-t border-border bg-black/10 p-4"><div className="grid gap-3 sm:grid-cols-[1fr_auto]"><Input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="Absolute path for the new local repository" /><Button variant="primary" onClick={initialize} disabled={!!busy || !repoPath.trim()}>Approve PRD & create plan <ArrowRight className="ml-2 h-4 w-4" /></Button></div><p className="mt-2 text-[10px] text-muted">Approval is always an owner action. Planning uses only the approved REQ-* identifiers.</p></div>
          </>}
        </Card>
      </div>
      </div>
    </div>
  )
}

function StudioStep({ n, label, detail, active = false, done = false }: { n: string; label: string; detail: string; active?: boolean; done?: boolean }) {
  return <li className={`flex min-w-[122px] items-center gap-2 rounded-md px-2 py-2 lg:min-w-0 lg:gap-3 lg:py-2.5 ${active ? 'bg-white' : ''}`}><span className={`grid h-6 w-6 shrink-0 place-items-center rounded border text-[10px] font-semibold ${active ? 'border-[#20201f] bg-[#20201f] text-white' : done ? 'border-success bg-success text-white' : 'border-border bg-transparent text-muted'}`}>{done ? '✓' : n}</span><span><span className={`block text-[10px] font-semibold lg:text-[11px] ${active ? 'text-foreground' : 'text-muted'}`}>{label}</span><span className="hidden text-[9px] text-muted lg:block">{detail}</span></span></li>
}

function BriefSection({ icon: Icon, title, description, children }: any) {
  return <section className="grid gap-4 border-b border-border pb-6 last:border-0 last:pb-0 md:grid-cols-[170px_minmax(0,1fr)]"><div><div className="flex items-center gap-2 text-xs font-semibold"><Icon size={14} />{title}</div><p className="mt-1.5 text-[10px] leading-relaxed text-muted">{description}</p></div><div>{children}</div></section>
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[11px] font-semibold">{label}</span>{children}<span className="mt-1.5 block text-[9px] leading-relaxed text-muted">{hint}</span></label>
}

function JourneyItem({ icon: Icon, label, state, last = false }: any) {
  return <><div className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 ${state === 'active' ? 'bg-[#20201f] text-white' : state === 'done' ? 'text-foreground' : 'text-muted'}`}><Icon size={13} /><span className="text-[10px] font-semibold">{label}</span>{state === 'done' && <span aria-hidden="true" className="text-success">✓</span>}</div>{!last && <div className="mx-1 h-px w-5 shrink-0 bg-border sm:w-10" />}</>
}

function Stage({ n, title, done, active, onClick, disabled }: any) {
  return <button onClick={onClick} disabled={disabled} className={`rounded-md border p-3 text-left transition ${done ? 'border-success/30 bg-success/10' : active ? 'border-accent/40 bg-blue-50' : 'border-border bg-card hover:border-accent/30'} disabled:cursor-not-allowed disabled:opacity-55`}><div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded border border-border bg-white text-[10px] font-bold">{done ? '✓' : n}</span><span className="text-xs font-semibold">{active ? `${title}…` : title}</span></div></button>
}

function BlueprintPanel({ tab, blueprint, research }: any) {
  if (tab === 'market') return <div className="space-y-4"><Section title="Value proposition"><p>{blueprint.market.coreValueProp}</p><p className="mt-2 text-muted">For {blueprint.market.targetAudience}</p></Section><div className="grid gap-3 md:grid-cols-2">{blueprint.market.competitors.map((x: any) => <Section key={x.name} title={x.name}><p>{x.positioning}</p>{x.url && <a className="mt-2 inline-flex items-center gap-1 text-accent" href={x.url} target="_blank" rel="noreferrer">Source <ExternalLink className="h-3 w-3" /></a>}</Section>)}</div><Section title="Research sources"><div className="space-y-2">{research?.sources?.map((x: any) => <a key={x.url} href={x.url} target="_blank" rel="noreferrer" className="block text-accent hover:underline">{x.title}</a>)}</div></Section></div>
  if (tab === 'prd') return <div className="space-y-3"><Section title="Executive summary"><p>{blueprint.prd.executiveSummary}</p></Section>{blueprint.prd.requirements.map((x: any) => <Section key={x.id} title={`${x.id} · ${x.title}`}><p>{x.description}</p><div className="mt-3 space-y-1">{x.acceptanceCriteria.map((c: string) => <div key={c} className="flex gap-2 text-muted"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />{c}</div>)}</div></Section>)}</div>
  if (tab === 'journeys') return <div className="space-y-3">{blueprint.userJourneys.map((x: any) => <Section key={`${x.persona}-${x.goal}`} title={`${x.persona} → ${x.goal}`}><ol className="space-y-2">{x.steps.map((s: string, i: number) => <li key={s}><span className="mr-2 text-accent">{i + 1}.</span>{s}</li>)}</ol></Section>)}</div>
  if (tab === 'architecture') return <div className="space-y-3"><Section title="Technology"><p>{blueprint.architecture.techStack}</p></Section>{blueprint.architecture.apiContracts.map((x: any) => <Section key={`${x.method}-${x.path}`} title={`${x.method} ${x.path}`}><p>{x.purpose}</p></Section>)}</div>
  return <div className="space-y-3">{blueprint.roadmap.milestones.map((x: any) => <Section key={x.title} title={x.title}>{x.tasks.map((t: any) => <div key={t.title} className="mb-2 rounded-md bg-[#f5f5f3] p-3"><strong>{t.title}</strong><p className="mt-1 text-muted">{t.description}</p></div>)}</Section>)}</div>
}

function Section({ title, children }: any) { return <section className="rounded-md border border-border bg-[#f7f7f5] p-4 text-xs leading-5"><h3 className="mb-2 font-semibold text-foreground">{title}</h3>{children}</section> }
