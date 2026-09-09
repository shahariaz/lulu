import React, { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card'
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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full overflow-hidden">
      {/* Left: Project List */}
      <Card className="flex flex-col h-full p-4">
        <CardHeader className="p-0 pb-3 mb-3">
          <CardTitle className="text-xs flex items-center justify-between">
            <span>Configured Projects</span>
            <span className="text-[11px] font-mono text-muted">{projects.length} registered</span>
          </CardTitle>
        </CardHeader>

        <div className="flex-1 overflow-y-auto flex flex-col gap-2">
          {projects.map((proj) => {
            const isActive = activeProject?.id === proj.id
            return (
              <div
                key={proj.id}
                onClick={() => onSelectProject(proj)}
                className={`p-3 rounded-md border text-left cursor-pointer transition-all ${
                  isActive
                    ? 'border-accent bg-accent/10 shadow-sm'
                    : 'border-border bg-card hover:bg-white/[0.03]'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold">{proj.name}</span>
                  <Badge variant={isActive ? 'ready' : 'default'}>
                    {isActive ? 'Active' : 'Standby'}
                  </Badge>
                </div>
                <p className="text-[11px] font-mono text-muted truncate mb-1.5">{proj.repo_path}</p>
                <div className="flex items-center justify-between text-[10px] text-muted">
                  <span>Branch: {proj.active_branch || 'main'}</span>
                  <span>{timeAgo(proj.created_at)}</span>
                </div>
              </div>
            )
          })}

          {projects.length === 0 && (
            <div className="text-center p-8 border border-dashed border-border/40 rounded">
              <p className="text-xs text-muted">No projects imported yet.</p>
            </div>
          )}
        </div>
      </Card>

      {/* Middle: Active Repository Inspection */}
      <Card className="flex flex-col h-full p-4">
        <CardHeader className="p-0 pb-3 mb-3">
          <CardTitle className="text-xs flex items-center justify-between">
            <span>Repository Working Tree Inspection</span>
            {inspection && (
              <Badge variant={inspection.isClean ? 'done' : 'blocked'}>
                {inspection.isClean ? 'Clean Tree' : 'Dirty Tree'}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>

        {inspection ? (
          <div className="flex flex-col gap-3 overflow-y-auto text-xs">
            <div className="p-2.5 rounded bg-black/30 border border-border flex flex-col gap-1.5">
              <div className="flex justify-between">
                <span className="text-muted">Repository Path:</span>
                <span className="font-mono">{inspection.repoPath}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Active Branch:</span>
                <span className="font-mono text-accent">{inspection.currentBranch}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">HEAD Commit:</span>
                <span className="font-mono text-foreground">{formatSha(inspection.headCommitSha)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Language Runtime:</span>
                <span className="font-mono uppercase font-bold text-success">{inspection.runtime}</span>
              </div>
            </div>

            <div className="p-2.5 rounded bg-black/30 border border-border flex flex-col gap-1.5">
              <span className="font-semibold text-foreground">Discovered Test Command:</span>
              <span className="font-mono text-accent bg-accent/10 px-2 py-1 rounded border border-accent/20">
                {inspection.testCommand || 'None detected'}
              </span>
            </div>

            {inspection.uncommittedFiles.length > 0 && (
              <div className="p-2.5 rounded bg-danger/10 border border-danger/30 flex flex-col gap-1.5">
                <span className="font-semibold text-danger">Uncommitted Files in Host Working Copy:</span>
                <div className="font-mono text-[10px] text-danger max-h-32 overflow-y-auto">
                  {inspection.uncommittedFiles.map((f, idx) => (
                    <div key={idx}>{f}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-center p-8">
            <p className="text-xs text-muted">Select a project to inspect git and runtime metadata.</p>
          </div>
        )}
      </Card>

      {/* Right: Import New Repository Form */}
      <Card className="flex flex-col h-full p-4">
        <CardHeader className="p-0 pb-3 mb-3">
          <CardTitle className="text-xs">Import Local Repository</CardTitle>
        </CardHeader>

        <form onSubmit={handleImport} className="flex flex-col gap-3 my-auto">
          <div>
            <label className="block text-xs font-semibold text-muted mb-1">Local Filesystem Path</label>
            <Input
              placeholder="/Users/username/projects/my-repo"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted mb-1">Project Name (Optional)</label>
            <Input
              placeholder="e.g. Core API Service"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button variant="primary" type="submit" disabled={loading || !repoPath.trim()}>
            {loading ? 'Validating Repository...' : 'Connect & Scan Repository'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
