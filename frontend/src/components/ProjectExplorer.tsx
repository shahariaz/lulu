import React, { useState } from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Badge } from './ui/Badge'
import { formatSha, timeAgo } from '../lib/utils'
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!repoPath.trim()) return
    setLoading(true)
    setError(null)
    try {
      await onImportProject(repoPath.trim(), projectName.trim() || undefined)
      setRepoPath('')
      setProjectName('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 h-full divide-x-2 divide-black overflow-hidden bg-white">
      {/* Left: Project List */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b-2 border-black px-5 py-3.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[01] REGISTERED REPOSITORIES</span>
          <span className="text-[10px] font-mono font-bold text-[#ff3000] uppercase">{projects.length} DETECTED</span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5 bg-neutral-50/50">
          {projects.map((proj) => {
            const isActive = activeProject?.id === proj.id
            return (
              <div
                key={proj.id}
                onClick={() => onSelectProject(proj)}
                className={`p-3.5 rounded-none border-2 border-black text-left cursor-pointer transition-colors duration-150 ${
                  isActive
                    ? 'bg-black text-white'
                    : 'bg-white text-black hover:bg-neutral-100'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-black uppercase tracking-tight">{proj.name}</span>
                  <Badge variant={isActive ? 'ready' : 'default'}>
                    {isActive ? 'ACTIVE' : 'STANDBY'}
                  </Badge>
                </div>
                <p className={`text-[11px] font-mono truncate mb-2 ${isActive ? 'text-neutral-300' : 'text-neutral-600'}`}>
                  {proj.repo_path}
                </p>
                <div className={`flex items-center justify-between text-[10px] font-mono font-bold uppercase border-t pt-1.5 ${
                  isActive ? 'border-white/20 text-neutral-400' : 'border-black/15 text-neutral-600'
                }`}>
                  <span>BRANCH: {proj.active_branch || 'MAIN'}</span>
                  <span>{timeAgo(proj.created_at).toUpperCase()}</span>
                </div>
              </div>
            )
          })}

          {projects.length === 0 && (
            <div className="text-center p-8 border-2 border-dashed border-black/20 rounded-none bg-swiss-gray">
              <p className="text-xs font-mono font-bold uppercase text-neutral-400">NO REPOSITORIES IMPORTED YET</p>
            </div>
          )}
        </div>
      </div>

      {/* Middle: Active Repository Inspection */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b-2 border-black px-5 py-3.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[02] WORKING TREE INSPECTION</span>
          {inspection && (
            <Badge variant={inspection.isClean ? 'done' : 'blocked'}>
              {inspection.isClean ? 'TREE CLEAN' : 'DIRTY TREE'}
            </Badge>
          )}
        </div>

        {inspection ? (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 text-xs">
            <div className="p-3.5 rounded-none bg-swiss-gray border-2 border-black flex flex-col gap-2 font-mono">
              <div className="flex justify-between border-b border-black/15 pb-1">
                <span className="font-bold text-neutral-600 uppercase">REPO PATH:</span>
                <span className="font-bold text-black truncate max-w-[170px]" title={inspection.repoPath}>{inspection.repoPath}</span>
              </div>
              <div className="flex justify-between border-b border-black/15 pb-1">
                <span className="font-bold text-neutral-600 uppercase">ACTIVE BRANCH:</span>
                <span className="font-bold text-[#ff3000]">{inspection.currentBranch}</span>
              </div>
              <div className="flex justify-between border-b border-black/15 pb-1">
                <span className="font-bold text-neutral-600 uppercase">HEAD COMMIT:</span>
                <span className="font-bold text-black">{formatSha(inspection.headCommitSha)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-bold text-neutral-600 uppercase">RUNTIME ENV:</span>
                <span className="font-black uppercase text-emerald-700">{inspection.runtime}</span>
              </div>
            </div>

            <div className="p-3.5 rounded-none bg-white border-2 border-black flex flex-col gap-1.5">
              <span className="font-black uppercase tracking-wider text-black font-mono text-[10px]">
                DISCOVERED TEST HARNESS
              </span>
              <span className="font-mono font-bold text-black bg-swiss-gray px-3 py-1.5 rounded-none border border-black text-xs">
                {inspection.testCommand || 'NONE CONFIGURED'}
              </span>
            </div>

            {inspection.uncommittedFiles.length > 0 && (
              <div className="p-3.5 rounded-none bg-red-50 border-2 border-black border-l-4 border-l-[#ff3000] flex flex-col gap-1.5">
                <span className="font-black uppercase tracking-wider text-[#ff3000] font-mono text-[10px]">
                  UNCOMMITTED FILES IN WORKING COPY ({inspection.uncommittedFiles.length})
                </span>
                <div className="font-mono text-[10px] text-black max-h-40 overflow-y-auto">
                  {inspection.uncommittedFiles.map((f, idx) => (
                    <div key={idx} className="border-b border-black/10 py-0.5">· {f}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-center p-8 bg-swiss-gray m-4 border-2 border-dashed border-black/20 rounded-none">
            <p className="text-xs font-mono font-bold uppercase text-neutral-400">
              SELECT A REPOSITORY TO INSPECT METADATA
            </p>
          </div>
        )}
      </div>

      {/* Right: Import New Repository Form */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b-2 border-black px-5 py-3.5 bg-white shrink-0">
          <span className="font-black uppercase tracking-wider text-black font-mono text-xs">[03] CONNECT REPOSITORY</span>
          <span className="text-[10px] font-mono font-bold text-neutral-500 uppercase">LOCAL WORKSPACE</span>
        </div>

        <div className="p-5 flex-1 overflow-y-auto flex flex-col justify-between">
          <form onSubmit={handleImport} className="flex flex-col gap-4">
            <div className="border border-black bg-swiss-gray p-3 text-xs font-mono">
              <span className="font-bold text-[#ff3000] uppercase block mb-1">[WORKSPACE ISOLATION]</span>
              <p className="text-neutral-700 text-[11px] leading-relaxed">
                Connect an absolute filesystem path. Claude-Zen scans git status and executes all tasks in isolated worktrees without altering your root branch.
              </p>
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-wider text-black font-mono mb-1">
                LOCAL FILESYSTEM PATH
              </label>
              <Input
                placeholder="/Users/username/projects/my-repo"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-wider text-black font-mono mb-1">
                REPOSITORY NAME (OPTIONAL)
              </label>
              <Input
                placeholder="e.g. CORE API SERVICE"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </div>
            {error && <p className="text-xs font-mono font-bold text-[#ff3000] uppercase">{error}</p>}
            <Button variant="primary" type="submit" disabled={loading || !repoPath.trim()} className="w-full">
              {loading ? 'VALIDATING REPO...' : 'CONNECT & SCAN REPOSITORY'}
            </Button>
          </form>

          <div className="border-t-2 border-black pt-3 mt-6 text-[10px] font-mono text-neutral-500 uppercase">
            Hermetic task containers require local git tracking.
          </div>
        </div>
      </div>
    </div>
  )
}
