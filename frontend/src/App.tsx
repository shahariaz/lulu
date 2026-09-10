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
  { id: 'board', num: '01', label: 'Delivery', icon: LayoutDashboard },
  { id: 'studio', num: '02', label: 'Idea studio', icon: Sparkles },
  { id: 'scoper', num: '03', label: 'Scoper', icon: MessageSquareText },
  { id: 'diff', num: '04', label: 'Code review', icon: ScanSearch },
  { id: 'preview', num: '05', label: 'Live preview', icon: MonitorPlay },
  { id: 'epics', num: '06', label: 'Roadmap', icon: Mountain },
  { id: 'specdiff', num: '07', label: 'Spec changes', icon: GitCompareArrows },
  { id: 'swarm', num: '08', label: 'Agent swarm', icon: Workflow },
  { id: 'projects', num: '09', label: 'Repositories', icon: FolderGit2 },
] as const

const TAB_TITLES: Record<TabType, { num: string; eyebrow: string; title: string; description: string }> = {
  board: { num: '01', eyebrow: 'Delivery System', title: 'Delivery overview', description: 'Real-time task pipeline, hermetic verification, review records, and merge acceptance.' },
  studio: { num: '02', eyebrow: 'Discovery Phase', title: 'Idea studio', description: 'Empirical research, architectural council discourse, and implementation blueprint.' },
  scoper: { num: '03', eyebrow: 'Requirements Matrix', title: 'Scope and baseline', description: 'Deterministic specification authority and versioned contract verification.' },
  diff: { num: '04', eyebrow: 'Inspection Pass', title: 'Candidate review', description: 'Immutable patch inspection, isolated test logs, and independent review verdicts.' },
  preview: { num: '05', eyebrow: 'Runtime State', title: 'Live preview', description: 'Interactive candidate verification inside the container runtime environment.' },
  epics: { num: '06', eyebrow: 'Milestone Matrix', title: 'Roadmap and epics', description: 'Structural feature breakdown, dependency graphs, and sprint boundaries.' },
  specdiff: { num: '07', eyebrow: 'Delta Audit', title: 'Specification changes', description: 'Comparative audit between requirements baselines and current execution scope.' },
  swarm: { num: '08', eyebrow: 'Execution Topology', title: 'Agent schedule', description: 'Hermetic workspace claims, agent allocation, and execution state.' },
  projects: { num: '09', eyebrow: 'Workspace Registry', title: 'Repository workspace', description: 'Connected local repositories, inspection status, and delivery pipelines.' },
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
    <div className="flex h-screen w-screen overflow-hidden bg-white text-black font-sans selection:bg-swiss-red selection:text-white">
      <aside aria-label="Workspace navigation" className="relative hidden w-[250px] shrink-0 flex-col overflow-hidden border-r-2 border-black bg-white text-black lg:flex">
        {/* Brand Header */}
        <div className="relative flex h-20 items-center gap-3 border-b-2 border-black px-5 bg-white">
          <div className="grid h-9 w-9 place-items-center rounded-none bg-black text-sm font-black text-white select-none">
            Z
          </div>
          <div>
            <div className="text-sm font-black tracking-wider uppercase text-black">CLAUDE·ZEN</div>
            <div className="text-[9px] font-bold tracking-widest text-neutral-500 uppercase font-mono">DELIVERY SYSTEM</div>
          </div>
        </div>

        {/* Active Workspace Box */}
        <div className="m-3 border-2 border-black bg-swiss-gray p-3 rounded-none">
          <div className="mb-1.5 flex items-center gap-2 text-[9px] font-black uppercase tracking-wider text-swiss-red font-mono">
            <FolderGit2 size={12} strokeWidth={2.5} /> [00] WORKSPACE
          </div>
          <div className="truncate text-xs font-black uppercase tracking-tight text-black">
            {activeProject?.name || 'NO REPO SELECTED'}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-black/20 pt-1.5 text-[9px] font-mono text-neutral-700">
            <span className="truncate max-w-[110px]" title={activeProject?.repo_path || ''}>
              {activeProject?.repo_path?.split('/').pop() || 'NO REPO'}
            </span>
            <span className="ml-2 border-l border-black/30 pl-2 font-bold text-black">
              {activeProject?.active_branch || '—'}
            </span>
          </div>
        </div>

        {/* Nav Links */}
        <nav aria-label="Primary navigation" className="relative mt-2 flex flex-1 flex-col gap-1 px-3 overflow-y-auto">
          <div className="mb-1 px-2 text-[9px] font-black uppercase tracking-widest text-neutral-400 font-mono">
            NAVIGATION INDEX
          </div>
          {NAV_ITEMS.map(({ id, num, label, icon: Icon }) => {
            const isActive = currentTab === id
            return (
              <button
                key={id}
                onClick={() => setCurrentTab(id)}
                className={`group flex w-full items-center gap-2.5 rounded-none px-3 py-2 text-left text-xs font-bold uppercase tracking-wider transition-colors duration-150 border-2 ${
                  isActive
                    ? 'bg-black text-white border-black'
                    : 'bg-white text-black border-transparent hover:border-black hover:bg-swiss-gray'
                }`}
              >
                <span className={`font-mono text-[10px] ${isActive ? 'text-swiss-red' : 'text-neutral-500'}`}>
                  {num}
                </span>
                <Icon size={14} strokeWidth={isActive ? 2.5 : 2} className="shrink-0" />
                <span className="truncate">{label}</span>
                {id === 'board' && attentionTasks > 0 && (
                  <span className="ml-auto grid h-4 min-w-4 place-items-center rounded-none bg-swiss-red px-1 text-[8px] font-black text-white font-mono border border-black">
                    {attentionTasks}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        {/* System Boundary & Connection Status Footer */}
        <div className="border-t-2 border-black bg-swiss-gray p-3 text-[10px]">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-black">
            <Activity size={13} strokeWidth={2.5} className="text-swiss-red" />
            <span>HERMETIC BOUNDARY</span>
          </div>
          <p className="mt-1 text-[9px] font-medium leading-tight text-neutral-600">
            ISOLATED RUNTIME · VERIFIED AUDIT
          </p>
        </div>
        <div className="flex items-center justify-between border-t border-black bg-white px-4 py-2.5 text-[10px] font-mono">
          <span className="font-semibold text-neutral-600 uppercase">DISPATCHER</span>
          <span className={`flex items-center gap-1.5 font-bold uppercase ${connectionState === 'live' ? 'text-emerald-700' : 'text-amber-700'}`}>
            <span className={`h-2 w-2 rounded-none border border-black ${connectionState === 'live' ? 'bg-emerald-600' : 'bg-amber-500 animate-pulse'}`} />
            {connectionState === 'live' ? 'ONLINE' : 'SYNCING'}
          </span>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="min-w-0 flex-1 flex flex-col overflow-hidden bg-white">
        {/* Top Control Bar */}
        <header className="flex min-h-16 items-center justify-between border-b-2 border-black bg-white px-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-none bg-black text-xs font-black text-white lg:hidden">
              Z
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-black uppercase tracking-widest text-swiss-red font-mono">
                [{tabMeta.num}] {tabMeta.eyebrow}
              </div>
              <div className="truncate text-sm font-black uppercase tracking-tight text-black">
                {activeProject?.name || 'CLAUDE-ZEN WORKSPACE'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeProject && (
              <select
                aria-label="Autonomy mode"
                value={activeProject.autonomy_mode || 'GUIDED'}
                onChange={(event) => handleAutonomyChange(event.target.value as Project['autonomy_mode'])}
                className="rounded-none border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-black outline-none transition-colors focus:border-swiss-red focus:bg-swiss-gray cursor-pointer"
              >
                <option value="GUIDED">MODE: GUIDED CONTROL</option>
                <option value="SUPERVISED">MODE: SUPERVISED FLOW</option>
                <option value="AUTONOMOUS">MODE: FULL AUTONOMOUS</option>
              </select>
            )}
            <button
              aria-label="Refresh workspace"
              onClick={loadProjects}
              className="grid h-9 w-9 place-items-center rounded-none border-2 border-black bg-white text-black transition-colors hover:bg-black hover:text-white active:translate-y-[1px]"
            >
              <RefreshCw size={14} strokeWidth={2.5} className={loading ? 'animate-spin' : ''} />
            </button>
            <Button
              aria-label="Add repository"
              size="sm"
              onClick={() => setCurrentTab('projects')}
            >
              <Plus size={14} strokeWidth={3} />
              <span className="hidden sm:inline">ADD REPO</span>
            </Button>
          </div>
        </header>

        {/* Mobile Navigation Strip */}
        <nav aria-label="Mobile navigation" className="flex gap-1 overflow-x-auto border-b-2 border-black bg-swiss-gray p-2 lg:hidden">
          {NAV_ITEMS.map(({ id, num, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setCurrentTab(id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-none border-2 border-black px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${
                currentTab === id ? 'bg-black text-white' : 'bg-white text-black hover:bg-neutral-100'
              }`}
            >
              <span className="font-mono text-swiss-red">{num}</span>
              <Icon size={13} />
              {label}
            </button>
          ))}
        </nav>

        {/* Section Title & KPI Matrix */}
        <section className="flex items-end justify-between gap-6 border-b-2 border-black bg-white px-4 py-4 sm:px-7">
          <div className="min-w-0">
            <p className="mb-0.5 text-[10px] font-black uppercase tracking-ultra text-swiss-red font-mono">
              SECTION {tabMeta.num} · {tabMeta.eyebrow}
            </p>
            <h1 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-black">
              {tabMeta.title}
            </h1>
            <p className="mt-1 max-w-2xl text-xs font-medium text-neutral-600">
              {tabMeta.description}
            </p>
          </div>
          {currentTab === 'board' && (
            <div className="hidden shrink-0 grid-cols-3 divide-x-2 divide-black border-2 border-black bg-white md:grid">
              <div className="px-4 py-2 bg-white">
                <div className="text-[9px] font-black uppercase tracking-widest text-neutral-500 font-mono">TASKS</div>
                <div className="mt-0.5 text-lg font-black font-mono leading-none">{tasks.length}</div>
              </div>
              <div className="px-4 py-2 bg-white">
                <div className="text-[9px] font-black uppercase tracking-widest text-neutral-500 font-mono">DONE</div>
                <div className="mt-0.5 text-lg font-black font-mono text-emerald-700 leading-none">{completedTasks}</div>
              </div>
              <div className="px-4 py-2 bg-white">
                <div className="text-[9px] font-black uppercase tracking-widest text-neutral-500 font-mono">ATTN</div>
                <div className={`mt-0.5 text-lg font-black font-mono leading-none ${attentionTasks > 0 ? 'text-swiss-red' : 'text-neutral-400'}`}>
                  {attentionTasks}
                </div>
              </div>
            </div>
          )}
        </section>

        {error && (
          <div role="alert" className="mx-4 my-3 flex items-center justify-between border-2 border-black bg-swiss-red px-4 py-2.5 text-xs font-black uppercase tracking-wider text-white sm:mx-7">
            <span>{error}</span>
            <button className="underline hover:text-black font-black" onClick={() => setError(null)}>
              DISMISS
            </button>
          </div>
        )}

        {(['board', 'diff', 'preview'] as TabType[]).includes(currentTab) && (
          <div className="px-4 sm:px-7 pt-3">
            <PipelineVisualizer currentStage={currentPipelineStage} />
          </div>
        )}

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
