import React, { useState } from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Badge } from './ui/Badge'
import { FolderOpen } from 'lucide-react'
import { formatSha, timeAgo } from '../lib/utils'
import { api } from '../lib/api'
import type { Project, Inspection } from '../types'

interface ProjectExplorerProps {
  projects: Project[]
  activeProject: Project | null
  inspection: Inspection | null
  onSelectProject: (project: Project) => void
  onImportProject: (repoPath: string, name?: string) => Promise<void>
}

export function ProjectExplorer({
  projects,
  activeProject,
  inspection,
  onSelectProject,
  onImportProject,
}: ProjectExplorerProps) {
  const [repoPath, setRepoPath] = useState('')
  const [projectName, setProjectName] = useState('')
  const [mode, setMode] = useState<'create' | 'connect'>('create')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handlePickFolder = async () => {
    try {
      const res = await api.pickFolder()
      if (res && res.path && !res.canceled) {
        const cleanPath = res.path
        if (mode === 'create' && projectName.trim()) {
          const finalPath = cleanPath.endsWith(projectName.trim())
            ? cleanPath
            : `${cleanPath}/${projectName.trim()}`
          setRepoPath(finalPath)
        } else {
          setRepoPath(cleanPath)
          if (!projectName.trim()) {
            setProjectName(cleanPath.split('/').pop() || '')
          }
        }
      }
    } catch (err: any) {
      console.warn('Folder picker error:', err.message)
    }
  }

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!repoPath.trim()) return
    setLoading(true)
    setError(null)
    try {
      const isNew = mode === 'create'
      const { project } = await api.createProject({
        repoPath: repoPath.trim(),
        name: projectName.trim() || undefined,
        initNew: isNew,
      })
      await onSelectProject(project)
      setRepoPath('')
      setProjectName('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 h-full divide-x divide-zinc-200 overflow-hidden bg-white">
      {/* Left: Project List */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
          <span className="font-semibold text-zinc-900 text-xs tracking-tight">Registered repositories</span>
          <span className="text-[11px] font-mono text-zinc-500">{projects.length} detected</span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5 bg-zinc-50/40">
          {projects.map((proj) => {
            const isActive = activeProject?.id === proj.id
            return (
              <div
                key={proj.id}
                onClick={() => onSelectProject(proj)}
                className={`p-3.5 rounded-lg border text-left cursor-pointer transition-colors duration-150 shadow-2xs ${
                  isActive
                    ? 'bg-zinc-900 text-white border-zinc-900 shadow-xs'
                    : 'bg-white text-zinc-900 border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold">{proj.name}</span>
                  <Badge variant={isActive ? 'ready' : 'default'}>
                    {isActive ? 'Active' : 'Standby'}
                  </Badge>
                </div>
                <p className={`text-[11px] font-mono truncate mb-2 ${isActive ? 'text-zinc-300' : 'text-zinc-500'}`}>
                  {proj.repo_path}
                </p>
                <div className={`flex items-center justify-between text-[10px] font-mono border-t pt-1.5 ${
                  isActive ? 'border-zinc-700 text-zinc-400' : 'border-zinc-100 text-zinc-500'
                }`}>
                  <span>Branch: {proj.active_branch || 'main'}</span>
                  <span>{timeAgo(proj.created_at)}</span>
                </div>
              </div>
            )
          })}

          {projects.length === 0 && (
            <div className="text-center p-8 border border-dashed border-zinc-200 rounded-lg bg-white/40">
              <p className="text-xs text-zinc-400 font-medium">No repositories imported yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Middle: Active Repository Inspection */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
          <span className="font-semibold text-zinc-900 text-xs tracking-tight">Working tree inspection</span>
          {inspection && (
            <Badge variant={inspection.isClean ? 'done' : 'blocked'}>
              {inspection.isClean ? 'Tree clean' : 'Dirty tree'}
            </Badge>
          )}
        </div>

        {inspection ? (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 text-xs">
            <div className="p-3.5 rounded-lg bg-zinc-50 border border-zinc-200 flex flex-col gap-2 font-mono">
              <div className="flex justify-between border-b border-zinc-100 pb-1">
                <span className="text-zinc-500">Repository path:</span>
                <span className="font-semibold text-zinc-900 truncate max-w-[170px]" title={inspection.repoPath}>{inspection.repoPath}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-100 pb-1">
                <span className="text-zinc-500">Active branch:</span>
                <span className="font-semibold text-[#ea3a12]">{inspection.currentBranch}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-100 pb-1">
                <span className="text-zinc-500">HEAD commit:</span>
                <span className="font-semibold text-zinc-900">{formatSha(inspection.headCommitSha)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Runtime environment:</span>
                <span className="font-bold text-emerald-700">{inspection.runtime}</span>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-white border border-zinc-200 flex flex-col gap-1.5 shadow-2xs">
              <span className="font-medium text-zinc-700 text-xs">
                Discovered test harness
              </span>
              <span className="font-mono text-zinc-800 bg-zinc-50 px-3 py-1.5 rounded-md border border-zinc-200 text-xs">
                {inspection.testCommand || 'None configured'}
              </span>
            </div>

            {inspection.uncommittedFiles.length > 0 && (
              <div className="p-3.5 rounded-lg bg-rose-50/60 border border-rose-200 border-l-4 border-l-[#ea3a12] flex flex-col gap-1.5">
                <span className="font-semibold text-rose-800 text-xs">
                  Uncommitted files in working copy ({inspection.uncommittedFiles.length})
                </span>
                <div className="font-mono text-[11px] text-rose-700 max-h-40 overflow-y-auto">
                  {inspection.uncommittedFiles.map((f, idx) => (
                    <div key={idx} className="border-b border-rose-100 py-0.5">· {f}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-center p-8 bg-zinc-50 m-4 border border-dashed border-zinc-200 rounded-lg">
            <p className="text-xs text-zinc-400 font-medium">
              Select a repository to inspect metadata
            </p>
          </div>
        )}
      </div>

      {/* Right: Import / Create New Repository Form */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
          <span className="font-semibold text-zinc-900 text-xs tracking-tight">
            {mode === 'create' ? 'Create new repository' : 'Connect repository'}
          </span>
          <span className="text-[11px] font-mono text-zinc-400">Local workspace</span>
        </div>

        <div className="p-5 flex-1 overflow-y-auto flex flex-col justify-between">
          <div className="flex flex-col gap-4">
            {/* Mode Switcher */}
            <div className="flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 gap-0.5">
              <button
                type="button"
                onClick={() => { setMode('create'); setError(null) }}
                className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  mode === 'create' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                ✨ Create fresh
              </button>
              <button
                type="button"
                onClick={() => { setMode('connect'); setError(null) }}
                className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  mode === 'connect' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                📁 Connect existing
              </button>
            </div>

            <form onSubmit={handleImport} className="flex flex-col gap-4">
              <div className="border border-zinc-200 bg-zinc-50/70 p-3.5 rounded-lg text-xs">
                <span className="font-semibold text-[#ea3a12] block mb-1">
                  {mode === 'create' ? 'Fresh repository provisioning' : 'Workspace isolation'}
                </span>
                <p className="text-zinc-600 text-[11px] leading-relaxed">
                  {mode === 'create'
                    ? 'Initializes a fresh git repository, commits an initial README.md and .gitignore on the main branch, and sets up project tracking.'
                    : 'Connect an absolute filesystem path. Claude-Zen scans git status and executes all tasks in isolated worktrees without altering your root branch.'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">
                  Repository name {mode === 'connect' && '(Optional)'}
                </label>
                <Input
                  placeholder={mode === 'create' ? 'e.g. distributed-sentinel' : 'e.g. Core API service'}
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  required={mode === 'create'}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-zinc-700">
                    Local filesystem path
                  </label>
                  <button
                    type="button"
                    onClick={handlePickFolder}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#ea3a12] hover:text-[#c82e0a] cursor-pointer"
                  >
                    <FolderOpen size={12} />
                    <span>Choose folder...</span>
                  </button>
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="/Users/username/projects/my-repo"
                    value={repoPath}
                    onChange={(e) => setRepoPath(e.target.value)}
                    className="font-mono text-xs flex-1"
                    required
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handlePickFolder}
                    className="h-9 px-3 shrink-0"
                    title="Open native folder picker"
                  >
                    <FolderOpen size={13} />
                    <span className="hidden sm:inline">Browse</span>
                  </Button>
                </div>
                <p className="text-[11px] text-zinc-400 mt-1">
                  {mode === 'create'
                    ? 'Directory will be created if it does not exist.'
                    : 'Folder must already be initialized with git.'}
                </p>
              </div>

              {error && <p className="text-xs font-medium text-[#ea3a12] bg-rose-50 border border-rose-200 p-2.5 rounded-lg">{error}</p>}

              <Button variant="primary" type="submit" disabled={loading || !repoPath.trim()} className="w-full">
                {loading
                  ? (mode === 'create' ? 'Initializing repository...' : 'Validating repository...')
                  : (mode === 'create' ? 'Create & start' : 'Connect & scan repository')}
              </Button>
            </form>
          </div>

          <div className="border-t border-zinc-100 pt-3 mt-6 text-[10px] text-zinc-400">
            Hermetic task containers require local git tracking.
          </div>
        </div>
      </div>
    </div>
  )
}
