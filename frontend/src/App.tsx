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
import { Input } from './components/ui/Input'
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

  // Add/Create Repository Modal state
  const [showAddRepoModal, setShowAddRepoModal] = useState(false)
  const [addRepoMode, setAddRepoMode] = useState<'create' | 'connect'>('create')
  const [modalRepoPath, setModalRepoPath] = useState('')
  const [modalRepoName, setModalRepoName] = useState('')
  const [modalLoading, setModalLoading] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)

  const handleAddRepoSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!modalRepoPath.trim()) return
    setModalLoading(true)
    setModalError(null)
    try {
      const isNew = addRepoMode === 'create'
      const { project } = await api.createProject({
        repoPath: modalRepoPath.trim(),
        name: modalRepoName.trim() || undefined,
        initNew: isNew,
      })
      setProjects((prev) => [project, ...prev])
      await selectProject(project)
      setShowAddRepoModal(false)
      setModalRepoPath('')
      setModalRepoName('')
    } catch (err: any) {
      setModalError(err.message)
    } finally {
      setModalLoading(false)
    }
  }

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
    <div className="flex h-screen w-screen overflow-hidden bg-white text-zinc-900 font-sans selection:bg-[#ea3a12] selection:text-white">
      <aside aria-label="Workspace navigation" className="relative hidden w-[250px] shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-white text-zinc-900 lg:flex">
        {/* Brand Header */}
        <div className="relative flex h-14 items-center gap-3 border-b border-zinc-100 px-4 bg-white shrink-0">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-900 text-xs font-bold text-white select-none shadow-xs">
            Z
          </div>
          <div>
            <div className="text-xs font-bold tracking-tight text-zinc-900 leading-none">Claude·Zen</div>
            <div className="text-[10px] font-medium text-zinc-500 mt-0.5">Delivery workspace</div>
          </div>
        </div>

        {/* Active Workspace Box with Quick Switcher */}
        <div className="m-3 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3 shrink-0">
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#ea3a12]">
              <FolderGit2 size={12} strokeWidth={2} /> Active repository
            </div>
            <div className="flex items-center gap-1.5">
              {projects.length > 1 && (
                <span className="text-[10px] text-zinc-400 font-medium">Switch ▾</span>
              )}
              <button
                type="button"
                onClick={() => setShowAddRepoModal(true)}
                className="p-0.5 rounded text-zinc-400 hover:text-zinc-800 hover:bg-zinc-200/60 transition-colors"
                title="Create fresh repository or connect existing"
              >
                <Plus size={11} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          <div className="relative">
            <select
              aria-label="Switch active repository"
              value={activeProject?.id || ''}
              onChange={(e) => {
                const found = projects.find((p) => p.id === e.target.value)
                if (found) selectProject(found)
              }}
              className="w-full truncate text-xs font-semibold text-zinc-900 bg-transparent py-0.5 outline-none cursor-pointer hover:text-[#ea3a12] transition-colors"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
            <span className="truncate max-w-[120px] font-mono" title={activeProject?.repo_path || ''}>
              {activeProject?.repo_path?.split('/').pop() || 'No repo'}
            </span>
            <span className="font-mono text-zinc-700 border-l border-zinc-200 pl-2">
              {activeProject?.active_branch || '—'}
            </span>
          </div>
        </div>

        {/* Nav Links: Spacious, Comfortable Sidebar Navigation */}
        <nav aria-label="Primary navigation" className="relative flex-1 flex flex-col overflow-y-auto px-3 py-1 gap-1 bg-white">
          <div className="px-2 py-1 text-[10px] font-semibold text-zinc-400">
            Navigation
          </div>
          {NAV_ITEMS.map(({ id, num, label, icon: Icon }) => {
            const isActive = currentTab === id
            return (
              <button
                key={id}
                onClick={() => setCurrentTab(id)}
                className={`group flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-left text-xs transition-colors duration-150 select-none ${
                  isActive
                    ? 'bg-zinc-900 text-white font-semibold shadow-xs'
                    : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 font-medium'
                }`}
              >
                <span className={`font-mono text-[11px] ${isActive ? 'text-[#ea3a12]' : 'text-zinc-400 font-normal'}`}>
                  {num}
                </span>
                <Icon size={16} strokeWidth={isActive ? 2.2 : 1.8} className="shrink-0" />
                <span className="truncate flex-1">{label}</span>
                {id === 'board' && attentionTasks > 0 && (
                  <span className="ml-auto grid h-4 min-w-4 place-items-center rounded-full bg-[#ea3a12] px-1 text-[9px] font-bold text-white font-mono">
                    {attentionTasks}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        {/* Compact System Boundary & Status Footer */}
        <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 shrink-0">
          <div className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1.5 font-medium text-zinc-700">
              <Activity size={12} strokeWidth={2} className="text-[#ea3a12]" />
              Container isolated
            </span>
            <span className={`flex items-center gap-1.5 font-medium ${connectionState === 'live' ? 'text-emerald-700' : 'text-amber-700'}`}>
              <span className={`h-2 w-2 rounded-full ${connectionState === 'live' ? 'bg-emerald-600' : 'bg-amber-500 animate-pulse'}`} />
              {connectionState === 'live' ? 'Live' : 'Connecting'}
            </span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="min-w-0 flex-1 flex flex-col overflow-hidden bg-white">
        {/* Top Control Bar */}
        <header className="flex min-h-14 items-center justify-between border-b border-zinc-200 bg-white px-5 shrink-0">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-zinc-900 text-xs font-bold text-white lg:hidden">
              Z
            </div>
            {currentTab === 'studio' ? (
              <div className="min-w-0 flex items-center gap-2">
                <div className="text-xs font-semibold text-zinc-900 flex items-center gap-1.5">
                  <span className="text-zinc-400">Discovery</span>
                  <span className="text-zinc-300">/</span>
                  <select
                    aria-label="Switch active repository"
                    value={activeProject?.id || ''}
                    onChange={(e) => {
                      const found = projects.find((p) => p.id === e.target.value)
                      if (found) selectProject(found)
                    }}
                    className="text-xs font-bold text-zinc-900 bg-transparent hover:bg-zinc-100 rounded-md px-1.5 py-0.5 cursor-pointer outline-none transition-colors border border-transparent hover:border-zinc-200"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  Active session
                </span>
              </div>
            ) : (
              <div className="min-w-0 flex flex-col">
                <div className="text-[10px] font-semibold text-[#ea3a12] leading-none">
                  {tabMeta.eyebrow}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <select
                    aria-label="Switch active repository"
                    value={activeProject?.id || ''}
                    onChange={(e) => {
                      const found = projects.find((p) => p.id === e.target.value)
                      if (found) selectProject(found)
                    }}
                    className="text-sm font-semibold text-zinc-900 bg-transparent hover:bg-zinc-100 rounded-md px-1 py-0.5 cursor-pointer outline-none transition-colors border border-transparent hover:border-zinc-200 truncate max-w-[280px]"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {activeProject && (
              <select
                aria-label="Autonomy mode"
                value={activeProject.autonomy_mode || 'GUIDED'}
                onChange={(event) => handleAutonomyChange(event.target.value as Project['autonomy_mode'])}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 outline-none transition-colors focus:border-zinc-400 cursor-pointer shadow-2xs"
              >
                <option value="GUIDED">Guided control</option>
                <option value="SUPERVISED">Supervised flow</option>
                <option value="AUTONOMOUS">Autonomous flow</option>
              </select>
            )}
            <button
              aria-label="Refresh workspace"
              onClick={loadProjects}
              className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-700 transition-colors hover:bg-zinc-50 active:scale-95 shadow-2xs"
            >
              <RefreshCw size={13} strokeWidth={2} className={loading ? 'animate-spin' : ''} />
            </button>
            <Button
              aria-label="Add repository"
              size="sm"
              onClick={() => setShowAddRepoModal(true)}
            >
              <Plus size={13} strokeWidth={2.5} />
              <span className="hidden sm:inline">Add repo</span>
            </Button>
          </div>
        </header>

        {/* Mobile Navigation Strip */}
        <nav aria-label="Mobile navigation" className="flex gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50 p-2 lg:hidden shrink-0">
          {NAV_ITEMS.map(({ id, num, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setCurrentTab(id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                currentTab === id ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-100'
              }`}
            >
              <span className="font-mono text-[#ea3a12]">{num}</span>
              <Icon size={13} />
              {label}
            </button>
          ))}
        </nav>

        {/* Section Title & KPI Matrix: Hidden for Idea Studio to provide full vertical space */}
        {currentTab !== 'studio' && (
          <section className="flex items-center justify-between gap-6 border-b border-zinc-200 bg-white px-5 py-3.5 shrink-0">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-[#ea3a12] leading-none mb-1">
                Section {tabMeta.num} · {tabMeta.eyebrow}
              </p>
              <h1 className="text-xl font-bold tracking-tight text-zinc-900 leading-tight">
                {tabMeta.title}
              </h1>
              <p className="text-xs text-zinc-500 truncate max-w-2xl mt-0.5">
                {tabMeta.description}
              </p>
            </div>
            {currentTab === 'board' && (
              <div className="hidden shrink-0 grid-cols-3 divide-x divide-zinc-200 rounded-lg border border-zinc-200 bg-white shadow-2xs md:grid overflow-hidden">
                <div className="px-4 py-1.5 bg-white">
                  <div className="text-[10px] font-medium text-zinc-500">Tasks</div>
                  <div className="text-base font-bold font-mono leading-tight text-zinc-900">{tasks.length}</div>
                </div>
                <div className="px-4 py-1.5 bg-white">
                  <div className="text-[10px] font-medium text-zinc-500">Done</div>
                  <div className="text-base font-bold font-mono text-emerald-600 leading-tight">{completedTasks}</div>
                </div>
                <div className="px-4 py-1.5 bg-white">
                  <div className="text-[10px] font-medium text-zinc-500">Attention</div>
                  <div className={`text-base font-bold font-mono leading-tight ${attentionTasks > 0 ? 'text-[#ea3a12]' : 'text-zinc-400'}`}>
                    {attentionTasks}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {error && (
          <div role="alert" className="border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-xs font-medium text-rose-700 flex items-center justify-between shrink-0">
            <span>{error}</span>
            <button className="underline hover:text-rose-900 font-semibold" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {(['board', 'diff', 'preview'] as TabType[]).includes(currentTab) && (
          <div className="border-b border-zinc-200 bg-white px-5 py-2.5 shrink-0">
            <PipelineVisualizer currentStage={currentPipelineStage} />
          </div>
        )}

        {/* Dynamic Tab Body: Edge to Edge Grid Container */}
        <div className="flex-1 overflow-hidden flex flex-col bg-white">
          {currentTab === 'board' && (
            <div className={`${activeTask ? 'grid-cols-1 xl:grid-cols-3 divide-x divide-zinc-200' : 'grid-cols-1'} grid min-w-0 h-full overflow-hidden`}>
              <div className={`${activeTask ? 'xl:col-span-2' : ''} min-w-0 h-full flex flex-col overflow-hidden p-4`}>
                <KanbanBoard
                  tasks={tasks}
                  activeTaskId={activeTask?.id || null}
                  onSelectTask={handleSelectTask}
                />
              </div>
              {activeTask && (
                <div className="hidden xl:flex flex-col h-full overflow-hidden p-4 bg-zinc-50/50">
                  <DiffReviewInspector
                    task={activeTask}
                    candidateCommitSha={candidateSha}
                    diffPatch={diffPatch}
                    verificationResult={verifResult}
                    reviewRecord={reviewRecord}
                  />
                </div>
              )}
            </div>
          )}

          {currentTab === 'studio' && (
            <IdeaStudioView
              project={activeProject}
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

      {/* Add / Create Repository Modal Dialog */}
      {showAddRepoModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl">
            <div className="border-b border-zinc-100 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">
                  {addRepoMode === 'create' ? 'Create new repository' : 'Connect existing repository'}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {addRepoMode === 'create'
                    ? 'Initialize a fresh git project in a local directory.'
                    : 'Import and scan an existing git codebase on disk.'}
                </p>
              </div>
              <button
                onClick={() => setShowAddRepoModal(false)}
                className="text-zinc-400 hover:text-zinc-700 text-sm font-bold p-1 rounded-md"
              >
                ✕
              </button>
            </div>

            {/* Mode Switcher */}
            <div className="flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 gap-0.5">
              <button
                type="button"
                onClick={() => { setAddRepoMode('create'); setModalError(null) }}
                className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  addRepoMode === 'create' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                ✨ Create fresh
              </button>
              <button
                type="button"
                onClick={() => { setAddRepoMode('connect'); setModalError(null) }}
                className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  addRepoMode === 'connect' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                📁 Connect existing
              </button>
            </div>

            <form onSubmit={handleAddRepoSubmit} className="flex flex-col gap-3.5">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">
                  Repository name {addRepoMode === 'connect' && '(Optional)'}
                </label>
                <Input
                  placeholder={addRepoMode === 'create' ? 'e.g. distributed-sentinel' : 'e.g. My Existing Service'}
                  value={modalRepoName}
                  onChange={(e) => setModalRepoName(e.target.value)}
                  required={addRepoMode === 'create'}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">
                  Local filesystem path
                </label>
                <Input
                  placeholder="/Users/username/projects/my-repo"
                  value={modalRepoPath}
                  onChange={(e) => setModalRepoPath(e.target.value)}
                  className="font-mono text-xs"
                  required
                />
                <p className="text-[11px] text-zinc-400 mt-1">
                  {addRepoMode === 'create'
                    ? 'Directory will be created if it does not exist. A main branch, README.md, and .gitignore will be committed automatically.'
                    : 'Target folder must already have git initialized with a clean working tree.'}
                </p>
              </div>

              {modalError && (
                <p className="text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 p-2.5 rounded-lg">
                  {modalError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAddRepoModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={modalLoading || !modalRepoPath.trim()}
                >
                  {modalLoading
                    ? (addRepoMode === 'create' ? 'Initializing...' : 'Connecting...')
                    : (addRepoMode === 'create' ? 'Create & start' : 'Connect repository')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
