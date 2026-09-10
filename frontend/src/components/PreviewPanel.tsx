import React, { useState, useEffect, useRef } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import type { Task } from '../types'
import { api } from '../lib/api'

interface PreviewPanelProps {
  task: Task | null
}

type ViewportMode = 'desktop' | 'tablet' | 'mobile'

export function PreviewPanel({ task }: PreviewPanelProps) {
  const [viewport, setViewport] = useState<ViewportMode>('desktop')
  const [previewStatus, setPreviewStatus] = useState<string>('STOPPED')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [logs, setLogs] = useState<{ stdout: string; stderr: string }>({ stdout: '', stderr: '' })
  const [loading, setLoading] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (task) {
      checkStatus()
    } else {
      setPreviewStatus('STOPPED')
      setPreviewUrl(null)
    }
  }, [task?.id])

  const checkStatus = async () => {
    if (!task) return
    try {
      const data = await api.getPreview(task.id)
      if (data.session) {
        setPreviewStatus(data.session.status)
        setPreviewUrl(data.session.url)
        setLogs(data.session.logs || { stdout: '', stderr: '' })
      } else {
        setPreviewStatus('STOPPED')
        setPreviewUrl(null)
      }
    } catch {
      setPreviewStatus('STOPPED')
      setPreviewUrl(null)
    }
  }

  const handleStart = async () => {
    if (!task) return
    setLoading(true)
    try {
      const data = await api.startPreview(task.id)
      if (data.session) {
        setPreviewStatus(data.session.status)
        setPreviewUrl(data.session.url)
      }
    } catch (err: any) {
      alert(`Could not start preview: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleStop = async () => {
    if (!task) return
    setLoading(true)
    try {
      await api.stopPreview(task.id)
      setPreviewStatus('STOPPED')
      setPreviewUrl(null)
    } catch (err: any) {
      alert(`Could not stop preview: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleReload = () => {
    if (iframeRef.current && previewUrl) {
      iframeRef.current.src = previewUrl
    }
  }

  if (!task) {
    return (
      <Card className="h-full flex items-center justify-center text-center p-8">
        <p className="text-xs text-muted">Select a task on the board to launch a live local web preview.</p>
      </Card>
    )
  }

  const viewportWidths = {
    desktop: 'w-full',
    tablet: 'w-[768px]',
    mobile: 'w-[375px]',
  }

  return (
    <div className="flex flex-col h-full gap-3 overflow-hidden">
      {/* Control Toolbar */}
      <Card className="p-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          {/* Left: Server Status & Task Info */}
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-bold truncate max-w-[200px]">{task.title}</span>
            <Badge
              variant={
                previewStatus === 'RUNNING'
                  ? 'done'
                  : previewStatus === 'STARTING'
                  ? 'progress'
                  : 'default'
              }
            >
              {previewStatus === 'RUNNING' ? '● Live Server' : previewStatus}
            </Badge>
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono text-accent hover:underline flex items-center gap-1"
              >
                {previewUrl} ↗
              </a>
            )}
          </div>

          {/* Middle: Viewport Switcher */}
          <div className="flex items-center gap-1 bg-black/40 p-1 rounded border border-border">
            <button
              onClick={() => setViewport('desktop')}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                viewport === 'desktop' ? 'bg-accent/20 text-accent font-bold' : 'text-muted hover:text-foreground'
              }`}
            >
              Desktop
            </button>
            <button
              onClick={() => setViewport('tablet')}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                viewport === 'tablet' ? 'bg-accent/20 text-accent font-bold' : 'text-muted hover:text-foreground'
              }`}
            >
              Tablet (768px)
            </button>
            <button
              onClick={() => setViewport('mobile')}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                viewport === 'mobile' ? 'bg-accent/20 text-accent font-bold' : 'text-muted hover:text-foreground'
              }`}
            >
              Mobile (375px)
            </button>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2">
            {previewStatus === 'RUNNING' && (
              <Button variant="ghost" size="sm" onClick={handleReload} title="Reload Iframe">
                ↻
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowLogs(!showLogs)}
            >
              {showLogs ? 'Hide Logs' : 'Logs'}
            </Button>

            {previewStatus === 'RUNNING' ? (
              <Button variant="danger" size="sm" onClick={handleStop} disabled={loading}>
                Stop Preview
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleStart} disabled={loading}>
                {loading ? 'Starting...' : 'Start Preview Server'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Main Preview Area */}
      <div className="flex-1 flex flex-col items-center justify-center bg-[#070a0f] border border-border rounded-lg p-2 overflow-hidden relative">
        {previewUrl && previewStatus === 'RUNNING' ? (
          <div className={`h-full transition-all duration-300 shadow-2xl bg-white rounded overflow-hidden flex flex-col ${viewportWidths[viewport]}`}>
            <iframe
              ref={iframeRef}
              src={previewUrl}
              title={`Preview ${task.id}`}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        ) : (
          <div className="text-center p-8 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-card flex items-center justify-center text-xl border border-border">
              👁️
            </div>
            <div>
              <h4 className="text-sm font-semibold mb-1">Preview Dev Server Inactive</h4>
              <p className="text-xs text-muted max-w-sm">
                Click "Start Preview Server" to spawn an isolated local dev server inside the task worktree.
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={handleStart} disabled={loading}>
              {loading ? 'Starting Server...' : 'Launch Live Preview'}
            </Button>
          </div>
        )}

        {/* Slide-out Terminal Logs Drawer */}
        {showLogs && (
          <div className="absolute bottom-0 inset-x-0 h-48 bg-[#090d13]/95 border-t border-border p-3 backdrop-blur flex flex-col z-20">
            <div className="flex items-center justify-between pb-1 mb-1 border-b border-border/50 text-[10px] font-mono text-muted">
              <span>Dev Server Output (STDOUT / STDERR)</span>
              <button onClick={() => setShowLogs(false)} className="hover:text-foreground">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[11px] text-muted whitespace-pre-wrap">
              {logs.stdout || logs.stderr ? (
                <>
                  {logs.stdout && <span className="text-foreground/90">{logs.stdout}</span>}
                  {logs.stderr && <span className="text-danger">{logs.stderr}</span>}
                </>
              ) : (
                'No dev server logs captured yet.'
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
