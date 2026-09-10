import React, { useState, useEffect, useRef } from 'react'
import { Card } from './ui/Card'
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
      <Card className="h-full flex items-center justify-center text-center p-8 bg-zinc-50 border border-zinc-200 rounded-xl">
        <div>
          <p className="text-xs font-medium text-zinc-500">
            Select a task on the board to launch an isolated runtime preview
          </p>
        </div>
      </Card>
    )
  }

  const viewportWidths = {
    desktop: 'w-full',
    tablet: 'w-[768px]',
    mobile: 'w-[375px]',
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white">
      {/* Control Toolbar */}
      <div className="border-b border-zinc-200 bg-white px-5 py-3 shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Left: Server Status & Task Info */}
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-semibold text-zinc-900 truncate max-w-[240px]">
              {task.title}
            </span>
            <Badge
              variant={
                previewStatus === 'RUNNING'
                  ? 'done'
                  : previewStatus === 'STARTING'
                  ? 'progress'
                  : 'default'
              }
            >
              {previewStatus === 'RUNNING' ? '● Live' : previewStatus}
            </Badge>
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono font-medium text-[#ea3a12] hover:underline flex items-center gap-1"
              >
                {previewUrl} ↗
              </a>
            )}
          </div>

          {/* Middle: Viewport Switcher */}
          <div className="flex items-center rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 gap-0.5 shadow-2xs">
            <button
              onClick={() => setViewport('desktop')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                viewport === 'desktop' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              Desktop
            </button>
            <button
              onClick={() => setViewport('tablet')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                viewport === 'tablet' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              Tablet
            </button>
            <button
              onClick={() => setViewport('mobile')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                viewport === 'mobile' ? 'bg-white text-zinc-900 shadow-2xs' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              Mobile
            </button>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2">
            {previewStatus === 'RUNNING' && (
              <Button variant="outline" size="sm" onClick={handleReload} title="Reload Iframe">
                ↻
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowLogs(!showLogs)}
            >
              {showLogs ? 'Hide logs' : 'Logs'}
            </Button>

            {previewStatus === 'RUNNING' ? (
              <Button variant="danger" size="sm" onClick={handleStop} disabled={loading}>
                Stop preview
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleStart} disabled={loading}>
                {loading ? 'Starting...' : 'Start preview'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Main Preview Area */}
      <div className="flex-1 flex flex-col items-center justify-center bg-zinc-50 p-4 overflow-hidden relative">
        {previewUrl && previewStatus === 'RUNNING' ? (
          <div className={`h-full transition-all duration-150 border border-zinc-200/90 bg-white rounded-xl overflow-hidden flex flex-col shadow-sm ${viewportWidths[viewport]}`}>
            <iframe
              ref={iframeRef}
              src={previewUrl}
              title={`Preview ${task.id}`}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        ) : (
          <div className="text-center p-8 flex flex-col items-center gap-3 border border-zinc-200 bg-white rounded-xl shadow-xs max-w-sm">
            <div className="w-12 h-12 rounded-xl bg-zinc-100 text-zinc-700 flex items-center justify-center text-sm font-bold border border-zinc-200">
              👁
            </div>
            <div>
              <h4 className="text-sm font-semibold text-zinc-900 mb-1">Preview server inactive</h4>
              <p className="text-xs text-zinc-500 leading-relaxed">
                Click below to spin up an isolated local dev server inside the container sandbox.
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={handleStart} disabled={loading}>
              {loading ? 'Initializing...' : 'Launch live preview'}
            </Button>
          </div>
        )}

        {/* Slide-out Terminal Logs Drawer */}
        {showLogs && (
          <div className="absolute bottom-0 inset-x-0 h-48 bg-zinc-900 text-zinc-200 border-t border-zinc-800 p-3 flex flex-col z-20 shadow-xl">
            <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-zinc-800 text-[11px] font-mono text-zinc-400">
              <span>Dev server stream (stdout / stderr)</span>
              <button onClick={() => setShowLogs(false)} className="hover:text-white font-medium">✕ Close</button>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-xs text-zinc-300 whitespace-pre-wrap selection:bg-zinc-700">
              {logs.stdout || logs.stderr ? (
                <>
                  {logs.stdout && <span>{logs.stdout}</span>}
                  {logs.stderr && <span className="text-rose-400 font-medium">{logs.stderr}</span>}
                </>
              ) : (
                'No runtime logs recorded.'
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

