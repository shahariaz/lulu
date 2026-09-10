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
      <Card className="h-full flex items-center justify-center text-center p-8 bg-swiss-gray border-2 border-black rounded-none">
        <div>
          <div className="text-xs font-mono font-black uppercase tracking-widest text-neutral-400 mb-1">[EMPTY STATE]</div>
          <p className="text-xs font-bold uppercase tracking-wider text-black">
            SELECT A TASK TO LAUNCH AN ISOLATED RUNTIME PREVIEW
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
      <div className="border-b-2 border-black bg-white px-5 py-3 shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Left: Server Status & Task Info */}
          <div className="flex items-center gap-2.5">
            <span className="text-[10px] font-mono font-black text-[#ff3000] uppercase">[TARGET]</span>
            <span className="text-xs font-black uppercase tracking-tight text-black truncate max-w-[240px]">
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
              {previewStatus === 'RUNNING' ? '● LIVE' : previewStatus}
            </Badge>
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono font-bold text-[#ff3000] hover:underline flex items-center gap-1 uppercase"
              >
                {previewUrl} ↗
              </a>
            )}
          </div>

          {/* Middle: Viewport Switcher */}
          <div className="flex items-center border-2 border-black bg-white divide-x-2 divide-black">
            <button
              onClick={() => setViewport('desktop')}
              className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors ${
                viewport === 'desktop' ? 'bg-black text-white' : 'text-black hover:bg-neutral-100'
              }`}
            >
              DESKTOP
            </button>
            <button
              onClick={() => setViewport('tablet')}
              className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors ${
                viewport === 'tablet' ? 'bg-black text-white' : 'text-black hover:bg-neutral-100'
              }`}
            >
              TABLET [768]
            </button>
            <button
              onClick={() => setViewport('mobile')}
              className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors ${
                viewport === 'mobile' ? 'bg-black text-white' : 'text-black hover:bg-neutral-100'
              }`}
            >
              MOBILE [375]
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
              {showLogs ? 'HIDE LOGS' : 'LOGS'}
            </Button>

            {previewStatus === 'RUNNING' ? (
              <Button variant="danger" size="sm" onClick={handleStop} disabled={loading}>
                STOP PREVIEW
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleStart} disabled={loading}>
                {loading ? 'STARTING...' : 'START PREVIEW'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Main Preview Area */}
      <div className="flex-1 flex flex-col items-center justify-center bg-neutral-100 swiss-grid-pattern p-4 overflow-hidden relative">
        {previewUrl && previewStatus === 'RUNNING' ? (
          <div className={`h-full transition-all duration-150 border-2 border-black bg-white rounded-none overflow-hidden flex flex-col ${viewportWidths[viewport]}`}>
            <iframe
              ref={iframeRef}
              src={previewUrl}
              title={`Preview ${task.id}`}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        ) : (
          <div className="text-center p-8 flex flex-col items-center gap-3 border-2 border-black bg-white max-w-sm">
            <div className="w-12 h-12 bg-black text-white flex items-center justify-center text-sm font-mono font-black border-2 border-black">
              [P]
            </div>
            <div>
              <h4 className="text-xs font-black uppercase tracking-wider mb-1">PREVIEW ENVIRONMENT INACTIVE</h4>
              <p className="text-xs font-medium text-neutral-600 leading-relaxed">
                Click below to spin up an isolated local dev server inside the container sandbox.
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={handleStart} disabled={loading}>
              {loading ? 'INITIALIZING...' : 'LAUNCH LIVE PREVIEW'}
            </Button>
          </div>
        )}

        {/* Slide-out Terminal Logs Drawer */}
        {showLogs && (
          <div className="absolute bottom-0 inset-x-0 h-48 bg-black text-white border-t-2 border-black p-3 flex flex-col z-20">
            <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-white/20 text-[10px] font-mono font-black uppercase tracking-wider text-neutral-400">
              <span>DEV SERVER STREAM [STDOUT / STDERR]</span>
              <button onClick={() => setShowLogs(false)} className="hover:text-swiss-red font-bold">✕ CLOSE</button>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[11px] text-neutral-200 whitespace-pre-wrap selection:bg-swiss-red selection:text-white">
              {logs.stdout || logs.stderr ? (
                <>
                  {logs.stdout && <span>{logs.stdout}</span>}
                  {logs.stderr && <span className="text-swiss-red font-bold">{logs.stderr}</span>}
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

