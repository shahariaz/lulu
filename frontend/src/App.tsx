import React, { useState, useEffect, useCallback } from 'react'
import { PipelineVisualizer } from './components/PipelineVisualizer'
import { KanbanBoard } from './components/KanbanBoard'
import { DiffReviewInspector } from './components/DiffReviewInspector'
import { PreviewPanel } from './components/PreviewPanel'
import { ConversationalScoper } from './components/ConversationalScoper'
import { ProjectExplorer } from './components/ProjectExplorer'
import { EpicPlannerView } from './components/EpicPlannerView'
import { SpecDiffViewer } from './components/SpecDiffViewer'
import { SwarmVisualizer } from './components/SwarmVisualizer'
import { IdeaStudioView } from './components/IdeaStudioView'
import { ActionBar } from './components/ActionBar'
import { Button } from './components/ui/Button'
import {
  Activity, FolderGit2, GitCompareArrows, LayoutDashboard, MessageSquareText,
  MonitorPlay, Mountain, Plus, Radio, RefreshCw, ScanSearch, Sparkles, Workflow,
} from 'lucide-react'
import { api } from './lib/api'
import { useOrchestratorEvents } from './hooks/useOrchestratorEvents'
import type {
  Project,
  Inspection,
  RequirementsBaseline,
  Milestone,
  Task,
  TaskStatus,
  VerificationResult,
  ReviewRecord,
} from './types'

type TabType = 'board' | 'studio' | 'scoper' | 'projects' | 'diff' | 'preview' | 'epics' | 'specdiff' | 'swarm'

const NAV_ITEMS = [
  { id: 'board', label: 'Delivery', icon: LayoutDashboard },
  { id: 'studio', label: 'Idea studio', icon: Sparkles },
  { id: 'scoper', label: 'Scoper', icon: MessageSquareText },
  { id: 'diff', label: 'Code review', icon: ScanSearch },
  { id: 'preview', label: 'Live preview', icon: MonitorPlay },
  { id: 'epics', label: 'Roadmap', icon: Mountain },
  { id: 'specdiff', label: 'Spec changes', icon: GitCompareArrows },
  { id: 'swarm', label: 'Agent swarm', icon: Workflow },
  { id: 'projects', label: 'Repositories', icon: FolderGit2 },
] as const

const TAB_TITLES: Record<TabType, { eyebrow: string; title: string; description: string }> = {
  board: { eyebrow: 'Delivery', title: 'Delivery overview', description: 'Tasks, verification state, review evidence, and acceptance.' },
  studio: { eyebrow: 'Discovery', title: 'Idea studio', description: 'Research, council discussion, and product blueprint.' },
  scoper: { eyebrow: 'Requirements', title: 'Scope and baseline', description: 'Define and approve the versioned source of truth.' },
  diff: { eyebrow: 'Review', title: 'Candidate review', description: 'Inspect the immutable diff and independent findings.' },
  preview: { eyebrow: 'Preview', title: 'Runtime preview', description: 'Inspect the candidate inside its isolated environment.' },
  epics: { eyebrow: 'Planning', title: 'Roadmap', description: 'Epics, features, dependencies, and sprint scope.' },
  specdiff: { eyebrow: 'Changes', title: 'Specification changes', description: 'Compare baselines and affected delivery scope.' },
  swarm: { eyebrow: 'Execution', title: 'Agent schedule', description: 'Workspace ownership and the safe execution plan.' },
  projects: { eyebrow: 'Repositories', title: 'Repository workspace', description: 'Inspect and select a local delivery workspace.' },
}

export function App() {
  const [currentTab, setCurrentTab] = useState<TabType>('board')
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [activeBaseline, setActiveBaseline] = useState<RequirementsBaseline | null>(null)
  const [milestones, setMilestones] = useState<Milestone[]>([])
  const [activeMilestone, setActiveMilestone] = useState<Milestone | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeTask, setActiveTask] = useState<Task | null>(null)

  // Review & Verification Data for Active Task
  const [candidateSha, setCandidateSha] = useState<string | null>(null)
  const [diffPatch, setDiffPatch] = useState<string | null>(null)
  const [verifResult, setVerifResult] = useState<VerificationResult | null>(null)
  const [reviewRecord, setReviewRecord] = useState<ReviewRecord | null>(null)
  const [eventRevision, setEventRevision] = useState(0)
  const [connectionState, setConnectionState] = useState<'connecting' | 'live'>('connecting')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clearTaskDetails = () => {
    setCandidateSha(null); setDiffPatch(null); setVerifResult(null); setReviewRecord(null)
  }

  const loadTaskDetails = useCallback(async (taskId: string) => {
    const details = await api.getTask(taskId)
    setActiveTask(details.task)
    setCandidateSha(details.candidateCommitSha)
    setDiffPatch(details.diffPatch)
    setVerifResult(details.verificationResult)
    setReviewRecord(details.reviewRecord)
  }, [])

  const selectProject = useCallback(async (project: Project) => {
    setError(null)
    try {
      const data = await api.getProject(project.id)
      setActiveProject(data.project)
      setInspection(data.inspection)
      setActiveBaseline(data.activeBaseline)
      const nextMilestones = Array.isArray(data.milestones) ? data.milestones : []
      const nextTasks = Array.isArray(data.tasks) ? data.tasks : []
      setMilestones(nextMilestones)
      setActiveMilestone((current) => nextMilestones.find((item) => item.id === current?.id) || nextMilestones[0] || null)
      setTasks(nextTasks)
      setActiveTask((current) => nextTasks.find((item) => item.id === current?.id) || null)
      if (activeTask && nextTasks.some((item) => item.id === activeTask.id)) await loadTaskDetails(activeTask.id)
      else clearTaskDetails()
    } catch (err: any) { setError(err.message) }
  }, [activeTask?.id, loadTaskDetails])

  useEffect(() => { loadProjects() }, [])

  const loadProjects = async () => {
    setLoading(true)
    try {
      const { projects } = await api.listProjects()
      setProjects(projects)
      if (projects.length > 0 && !activeProject) {
        selectProject(projects[0])
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleImportProject = async (repoPath: string, name?: string) => {
    const { project, inspection } = await api.importProject(repoPath, name)
    setProjects((prev) => [project, ...prev])
    setActiveProject(project)
    setInspection(inspection)
    setCurrentTab('scoper')
  }

  const handleBaselineApproved = async (baseline: RequirementsBaseline) => {
    setActiveBaseline(baseline)
    setCurrentTab('board')
  }

  const handleSelectTask = (task: Task) => { void loadTaskDetails(task.id).catch((err) => setError(err.message)) }

  useOrchestratorEvents(useCallback((type: string, payload: any) => {
    if (type === 'connected') { setConnectionState('live'); return }
    setEventRevision((value) => value + 1)
    if (activeProject && (!payload?.projectId || payload.projectId === activeProject.id)) void selectProject(activeProject)
    if (activeTask && payload?.taskId === activeTask.id) void loadTaskDetails(activeTask.id)
  }, [activeProject, activeTask?.id, selectProject, loadTaskDetails]))

  const handleAutonomyChange = async (mode: Project['autonomy_mode']) => {
    if (!activeProject) return
    try {
      const { project } = await api.updateAutonomy(activeProject.id, mode)
      setActiveProject(project)
    } catch (err: any) { setError(err.message) }
  }

  const handleAcceptTask = async () => {
    if (!activeTask || !activeProject) return
    try {
      await api.acceptTask(activeTask.id, {
        repoPath: activeProject.repo_path,
        candidateCommitSha: candidateSha || '',
        featureBranch: '',
      })
      // Reload tasks
      if (activeMilestone) {
        const { tasks } = await api.listTasks(activeMilestone.id)
        setTasks(tasks)
        setActiveTask(tasks.find((t) => t.id === activeTask.id) || null)
      }
    } catch (err: any) {
      alert(`Accept failed: ${err.message}`)
    }
  }

  const handleRequestChanges = async (notes: string) => {
    if (!activeTask) return
    try {
      const { task } = await api.requestChanges(activeTask.id, notes)
      setActiveTask(task)
      if (activeMilestone) {
        const { tasks } = await api.listTasks(activeMilestone.id)
        setTasks(tasks)
      }
    } catch (err: any) {
      alert(`Request changes failed: ${err.message}`)
    }
  }

  const handleMergeFeature = async () => {
    if (!activeProject) return
    try {
      const result = await api.mergeFeature(activeProject.id, 'zen/feature-active', activeProject.active_branch)
      alert(`Feature successfully merged into ${result.baseBranch}! Commit: ${result.mergedCommitSha.slice(0, 7)}`)
    } catch (err: any) {
      alert(`Merge failed: ${err.message}`)
    }
  }

  const allTasksDone = tasks.length > 0 && tasks.every((t) => t.status === 'Done')
  const currentPipelineStage: TaskStatus = activeTask ? activeTask.status : 'Ready'
  const completedTasks = tasks.filter((task) => task.status === 'Done').length
  const attentionTasks = tasks.filter((task) => task.status === 'Blocked' || task.waiting_reason === 'SPECIALIST_UNAVAILABLE').length
  const tabMeta = TAB_TITLES[currentTab]

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      <aside aria-label="Workspace navigation" className="relative hidden w-[232px] shrink-0 flex-col overflow-hidden border-r border-[#dededb] bg-[#efefec] text-foreground lg:flex">
        <div className="relative flex h-20 items-center gap-3 px-5">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-[#20201f] text-xs font-bold text-white">Z</div>
          <div><div className="text-sm font-bold tracking-[0.08em]">ZEN</div><div className="text-[10px] font-medium text-muted">Delivery workspace</div></div>
        </div>
        <div className="mx-3 rounded-lg border border-[#d5d5d1] bg-white p-3">
          <div className="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.14em] text-muted"><FolderGit2 size={12} /> Active workspace</div>
          <div className="truncate text-xs font-semibold">{activeProject?.name || 'No project selected'}</div>
          <div className="mt-2 flex items-center justify-between text-[9px] text-muted"><span className="truncate font-mono">{activeProject?.repo_path || 'Import a repository'}</span><span className="ml-2 border-l border-border pl-2 font-mono">{activeProject?.active_branch || '—'}</span></div>
        </div>
        <nav aria-label="Primary navigation" className="relative mt-5 flex flex-1 flex-col gap-1 px-3">
          <div className="mb-1 px-3 text-[9px] font-bold uppercase tracking-[0.16em] text-muted">Workspace</div>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setCurrentTab(id)} className={`group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors ${currentTab === id ? 'bg-[#20201f] text-white' : 'text-[#5f5f5b] hover:bg-[#e4e4e0] hover:text-foreground'}`}><Icon size={15} strokeWidth={1.8} />{label}{id === 'board' && attentionTasks > 0 && <span className="ml-auto grid h-4 min-w-4 place-items-center rounded bg-warning px-1 text-[8px] font-bold text-white">{attentionTasks}</span>}</button>)}
        </nav>
        <div className="mx-3 mb-3 border-t border-border px-2 pt-3"><div className="flex items-center gap-2 text-[10px] font-medium text-foreground"><Activity size={13} /> Safety boundary active</div><p className="mt-1 text-[9px] leading-relaxed text-muted">Container execution · approved specs · immutable evidence</p></div>
        <div className="flex items-center justify-between border-t border-border px-5 py-3 text-[10px] text-muted"><span>Sequential writer</span><span className={`flex items-center gap-1.5 font-medium ${connectionState === 'live' ? 'text-success' : 'text-warning'}`}><Radio size={11} /> {connectionState === 'live' ? 'Live' : 'Connecting'}</span></div>
      </aside>

      {/* Main Content Area */}
      <main className="min-w-0 flex-1 flex flex-col overflow-hidden">
        <header className="flex min-h-16 items-center justify-between border-b border-border/80 bg-white/80 px-4 backdrop-blur-xl sm:px-7">
          <div className="flex min-w-0 items-center gap-3"><div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[#20201f] text-xs font-bold text-white lg:hidden">Z</div><div className="min-w-0"><div className="text-[9px] font-bold uppercase tracking-[0.16em] text-accent">{tabMeta.eyebrow}</div><div className="truncate text-sm font-semibold text-foreground">{activeProject?.name || 'Claude-Zen workspace'}</div></div></div>
          <div className="flex items-center gap-2">
            {activeProject && <select aria-label="Autonomy mode" value={activeProject.autonomy_mode || 'GUIDED'} onChange={(event) => handleAutonomyChange(event.target.value as Project['autonomy_mode'])} className="max-w-[180px] rounded-md border border-border bg-white px-3 py-2 text-[10px] font-semibold text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/10"><option value="GUIDED">Guided control</option><option value="SUPERVISED">Supervised flow</option><option value="AUTONOMOUS">Autonomous flow</option></select>}
            <button aria-label="Refresh workspace" onClick={loadProjects} className="grid h-9 w-9 place-items-center rounded-md border border-border bg-white text-muted transition hover:text-accent"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
            <Button aria-label="Add repository" className="h-9 rounded-md shadow-none" size="sm" onClick={() => setCurrentTab('projects')}><Plus size={14} /><span className="hidden sm:inline">Repository</span></Button>
          </div>
        </header>

        <nav aria-label="Mobile navigation" className="flex gap-1 overflow-x-auto border-b border-border bg-white px-3 py-2 lg:hidden">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setCurrentTab(id)} className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-[10px] font-semibold ${currentTab === id ? 'bg-[#20201f] text-white' : 'text-muted'}`}><Icon size={13} />{label}</button>)}
        </nav>

        <section className="flex items-end justify-between gap-6 px-4 pb-4 pt-5 sm:px-7">
          <div className="min-w-0"><p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{tabMeta.eyebrow}</p><h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{tabMeta.title}</h1><p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">{tabMeta.description}</p></div>
          {currentTab === 'board' && <div className="hidden shrink-0 divide-x divide-border rounded-md border border-border bg-white md:flex"><div className="px-4 py-2"><div className="text-[9px] font-medium uppercase tracking-wider text-muted">Tasks</div><div className="mt-0.5 text-base font-semibold">{tasks.length}</div></div><div className="px-4 py-2"><div className="text-[9px] font-medium uppercase tracking-wider text-muted">Complete</div><div className="mt-0.5 text-base font-semibold">{completedTasks}</div></div><div className="px-4 py-2"><div className="text-[9px] font-medium uppercase tracking-wider text-muted">Attention</div><div className="mt-0.5 text-base font-semibold">{attentionTasks}</div></div></div>}
        </section>

        {error && <div role="alert" className="mx-4 mb-3 flex items-center justify-between rounded-xl border border-danger/20 bg-danger/5 px-4 py-2.5 text-xs font-medium text-danger sm:mx-7"><span>{error}</span><button className="font-bold" onClick={() => setError(null)}>Dismiss</button></div>}

        {(['board', 'diff', 'preview'] as TabType[]).includes(currentTab) && <div className="px-4 sm:px-7"><PipelineVisualizer currentStage={currentPipelineStage} /></div>}

        {/* Dynamic Tab Body */}
        <div className="flex-1 overflow-hidden px-4 pb-3 sm:px-7">
          {currentTab === 'board' && (
            <div className={`${activeTask ? 'grid-cols-1 xl:grid-cols-3' : 'grid-cols-1'} grid min-w-0 gap-4 h-full overflow-hidden`}>
              <div className={`${activeTask ? 'xl:col-span-2' : ''} min-w-0 h-full flex flex-col overflow-hidden`}>
                <KanbanBoard
                  tasks={tasks}
                  activeTaskId={activeTask?.id || null}
                  onSelectTask={handleSelectTask}
                />
              </div>
              {activeTask && <div className="hidden xl:block h-full overflow-hidden">
                <DiffReviewInspector
                  task={activeTask}
                  candidateCommitSha={candidateSha}
                  diffPatch={diffPatch}
                  verificationResult={verifResult}
                  reviewRecord={reviewRecord}
                />
              </div>}
            </div>
          )}

          {currentTab === 'studio' && (
            <IdeaStudioView
              onProjectInitialized={(project) => {
                selectProject(project)
                setCurrentTab('board')
              }}
            />
          )}

          {currentTab === 'scoper' && (
            <ConversationalScoper
              project={activeProject}
              activeBaseline={activeBaseline}
              onBaselineApproved={handleBaselineApproved}
            />
          )}

          {currentTab === 'diff' && (
            <DiffReviewInspector
              task={activeTask}
              candidateCommitSha={candidateSha}
              diffPatch={diffPatch}
              verificationResult={verifResult}
              reviewRecord={reviewRecord}
            />
          )}

          {currentTab === 'preview' && (
            <PreviewPanel task={activeTask} />
          )}

          {currentTab === 'epics' && (
            <EpicPlannerView project={activeProject} tasks={tasks} />
          )}

          {currentTab === 'specdiff' && (
            <SpecDiffViewer project={activeProject} />
          )}

          {currentTab === 'swarm' && (
            <SwarmVisualizer project={activeProject} tasks={tasks} refreshToken={eventRevision} />
          )}

          {currentTab === 'projects' && (
            <ProjectExplorer
              projects={projects}
              activeProject={activeProject}
              inspection={inspection}
              onSelectProject={selectProject}
              onImportProject={handleImportProject}
            />
          )}
        </div>

        {/* Bottom Governance Action Bar */}
        {(activeTask || currentTab === 'board') && <ActionBar
          task={activeTask}
          project={activeProject}
          candidateCommitSha={candidateSha}
          allTasksDone={allTasksDone}
          onAcceptTask={handleAcceptTask}
          onRequestChanges={handleRequestChanges}
          onMergeFeature={handleMergeFeature}
        />}
      </main>
    </div>
  )
}
