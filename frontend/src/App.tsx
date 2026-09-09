import React, { useState, useEffect } from 'react'
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
import { Badge } from './components/ui/Badge'
import { api } from './lib/api'
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

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load projects on startup
  useEffect(() => {
    loadProjects()
  }, [])

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

  const selectProject = async (project: Project) => {
    setActiveProject(project)
    try {
      const data = await api.getProject(project.id)
      setInspection(data.inspection)
      setActiveBaseline(data.activeBaseline)
      if (data.activeBaseline) {
        // Load tasks if baseline exists
        // Decomposed milestones can be fetched or listed
      }
    } catch (err: any) {
      console.error(err)
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

  const handleSelectTask = (task: Task) => {
    setActiveTask(task)
  }

  const handleAcceptTask = async () => {
    if (!activeTask || !activeProject) return
    try {
      await api.acceptTask(activeTask.id, {
        repoPath: activeProject.repo_path,
        candidateCommitSha: candidateSha || '',
        featureBranch: 'zen/feature-active',
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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-card border-r border-border flex flex-col z-10">
        <div className="h-14 border-b border-border px-4 flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center font-bold text-xs text-black">
            Z
          </div>
          <span className="font-bold text-sm tracking-wider">CLAUDE-ZEN</span>
          <Badge variant="ready" className="ml-auto text-[10px]">PWA</Badge>
        </div>

        {/* Project Selector Badge */}
        <div className="p-3 border-b border-border/80">
          <div className="text-[10px] font-mono text-muted uppercase mb-1">Target Project</div>
          <div className="flex items-center justify-between text-xs font-semibold truncate bg-black/20 p-2 rounded border border-border">
            <span className="truncate">{activeProject ? activeProject.name : 'No project'}</span>
            <span className="text-[10px] font-mono text-accent">{activeProject?.active_branch || 'main'}</span>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 p-3 flex flex-col gap-1">
          <button
            onClick={() => setCurrentTab('board')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'board'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            📋 Delivery Board & DAG
          </button>

          <button
            onClick={() => setCurrentTab('studio')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'studio'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            ✨ Product & Idea Studio
          </button>

          <button
            onClick={() => setCurrentTab('scoper')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'scoper'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            💬 Scoper & Baselines
          </button>

          <button
            onClick={() => setCurrentTab('diff')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'diff'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            🔍 Diff & Review Inspector
          </button>

          <button
            onClick={() => setCurrentTab('preview')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'preview'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            👁️ Live Web Preview
          </button>

          <button
            onClick={() => setCurrentTab('epics')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'epics'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            🏔️ Epic & Sprint Planner
          </button>

          <button
            onClick={() => setCurrentTab('specdiff')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'specdiff'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            📊 Requirements Diff
          </button>

          <button
            onClick={() => setCurrentTab('swarm')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'swarm'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            🐝 Parallel Swarms
          </button>

          <button
            onClick={() => setCurrentTab('projects')}
            className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors ${
              currentTab === 'projects'
                ? 'bg-accent/15 text-accent font-semibold'
                : 'text-foreground/80 hover:bg-white/5'
            }`}
          >
            📁 Repository Manager
          </button>
        </nav>

        {/* Footer Info */}
        <div className="p-3 border-t border-border text-[11px] text-muted flex items-center justify-between">
          <span>Sequential v1 (1 Writer)</span>
          <span className="text-success font-mono">● Online</span>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-14 border-b border-border bg-card/50 px-6 flex items-center justify-between backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-bold text-foreground">
              {currentTab === 'board' && 'Milestone Delivery Board & Task DAG'}
              {currentTab === 'studio' && 'Product Strategy Studio & Idea Council'}
              {currentTab === 'scoper' && 'Conversational Scoper & PRD Architect'}
              {currentTab === 'diff' && 'Unified Diff & Specialist Code Review'}
              {currentTab === 'preview' && 'Safe Local Web Preview & Dev Server'}
              {currentTab === 'epics' && 'Hierarchical Epics & Sprint Planning'}
              {currentTab === 'specdiff' && 'Requirements Version Diffing & Scope Impact'}
              {currentTab === 'swarm' && 'Parallel Worker Swarm & Scope Scheduler'}
              {currentTab === 'projects' && 'Repository & Workspace Management'}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadProjects}>
              Refresh
            </Button>
            <Button variant="default" size="sm" onClick={() => setCurrentTab('projects')}>
              + New Repository
            </Button>
          </div>
        </header>

        {/* Active Stage Progress Visualizer */}
        <div className="px-6 pt-4">
          <PipelineVisualizer currentStage={currentPipelineStage} />
        </div>

        {/* Dynamic Tab Body */}
        <div className="flex-1 overflow-hidden px-6 pb-2">
          {currentTab === 'board' && (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 h-full overflow-hidden">
              <div className="xl:col-span-2 h-full flex flex-col overflow-hidden">
                <KanbanBoard
                  tasks={tasks}
                  activeTaskId={activeTask?.id || null}
                  onSelectTask={handleSelectTask}
                />
              </div>
              <div className="hidden xl:block h-full overflow-hidden">
                <DiffReviewInspector
                  task={activeTask}
                  candidateCommitSha={candidateSha}
                  diffPatch={diffPatch}
                  verificationResult={verifResult}
                  reviewRecord={reviewRecord}
                />
              </div>
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
            <SwarmVisualizer project={activeProject} tasks={tasks} />
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
        <ActionBar
          task={activeTask}
          project={activeProject}
          candidateCommitSha={candidateSha}
          allTasksDone={allTasksDone}
          onAcceptTask={handleAcceptTask}
          onRequestChanges={handleRequestChanges}
          onMergeFeature={handleMergeFeature}
        />
      </div>
    </div>
  )
}
