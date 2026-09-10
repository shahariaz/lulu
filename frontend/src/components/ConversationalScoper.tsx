import React, { useState } from 'react'
import { Card, CardHeader, CardTitle } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Badge } from './ui/Badge'
import { api } from '../lib/api'
import type { Project, RequirementsBaseline } from '../types'

interface ConversationalScoperProps {
  project: Project | null
  activeBaseline: RequirementsBaseline | null
  onBaselineApproved: (baseline: RequirementsBaseline) => void
}

export function ConversationalScoper({
  project,
  activeBaseline,
  onBaselineApproved,
}: ConversationalScoperProps) {
  const [featureTitle, setFeatureTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [specDraft, setSpecDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStartScoping = async () => {
    if (!project || !featureTitle.trim()) return
    setLoading(true)
    setError(null)
    try {
      const { session } = await api.startScoping(project.id, featureTitle, prompt)
      setConversationId(session.id)
      setMessages(session.messages.filter((m: any) => m.role !== 'system'))
      const architectDraft = [...session.messages].reverse().find((m: any) => m.role === 'assistant')?.content || ''
      if (/REQ-[A-Z0-9_-]+/.test(architectDraft)) setSpecDraft(architectDraft)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSendMessage = async () => {
    if (!conversationId || !prompt.trim()) return
    const userMsg = prompt.trim()
    setPrompt('')
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }])
    setLoading(true)

    try {
      const { session } = await api.sendScopingMessage(conversationId, userMsg)
      setMessages(session.messages.filter((m: any) => m.role !== 'system'))
      const architectDraft = [...session.messages].reverse().find((m: any) => m.role === 'assistant')?.content || ''
      if (/REQ-[A-Z0-9_-]+/.test(architectDraft)) setSpecDraft(architectDraft)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleApproveBaseline = async () => {
    if (!project || !specDraft.trim()) return
    setLoading(true)
    setError(null)
    try {
      const { draft } = await api.draftBaseline(project.id, specDraft, 'v1.0.0')
      const { approved } = await api.approveBaseline(draft.id, 'owner')
      onBaselineApproved(approved)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!project) {
    return (
      <Card className="h-full flex items-center justify-center text-center p-8 bg-swiss-gray border-2 border-black rounded-none">
        <div>
          <div className="text-xs font-mono font-black uppercase tracking-widest text-neutral-400 mb-1">[EMPTY STATE]</div>
          <p className="text-xs font-bold uppercase tracking-wider text-black">
            SELECT OR IMPORT A REPOSITORY TO COMMENCE CONVERSATIONAL SCOPING
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 h-full divide-x divide-zinc-200 overflow-hidden bg-white">
      {/* Left: Chat Scoper */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
          <span className="font-semibold text-zinc-900 text-xs tracking-tight">Scoping architect</span>
          <Badge variant="ready">Architect model</Badge>
        </div>

        {!conversationId ? (
          <div className="flex flex-col flex-1 p-5 gap-4 overflow-y-auto">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 text-xs">
              <span className="font-semibold text-[#ea3a12] block mb-1">Requirements baseline protocol</span>
              <p className="text-zinc-600 leading-relaxed text-[11px]">
                Define the feature scope, interfaces, and test criteria. The architect agent will formulate deterministic requirement IDs (REQ-*) to bind directly into delivery tasks.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                Feature title
              </label>
              <Input
                placeholder="e.g. Distributed Lock Manager"
                value={featureTitle}
                onChange={(e) => setFeatureTitle(e.target.value)}
              />
            </div>

            <div className="flex-1 flex flex-col min-h-[220px]">
              <label className="block text-xs font-medium text-zinc-700 mb-1">
                Scope & requirements outline
              </label>
              <textarea
                className="w-full flex-1 min-h-[180px] p-3.5 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 resize-none leading-relaxed shadow-2xs"
                placeholder="Describe goals, edge cases, APIs, data structures, and verification criteria..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            {error && <p className="text-xs font-medium text-[#ea3a12]">{error}</p>}

            <div className="pt-1">
              <Button
                variant="default"
                onClick={handleStartScoping}
                disabled={loading || !featureTitle.trim()}
                className="w-full"
              >
                {loading ? 'Initializing architect...' : 'Commence scoping session'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Messages Transcript */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 bg-zinc-50/40 swiss-dots">
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  className={`p-3.5 rounded-xl border text-xs leading-relaxed max-w-[85%] shadow-2xs ${
                    m.role === 'user'
                      ? 'bg-zinc-900 text-white border-zinc-900 self-end'
                      : 'bg-white text-zinc-900 border-zinc-200/90 self-start'
                  }`}
                >
                  <span className={`block text-[10px] font-semibold mb-1 ${m.role === 'user' ? 'text-[#ea3a12]' : 'text-zinc-400'}`}>
                    {m.role === 'user' ? 'Owner' : 'Architect'}
                  </span>
                  <div className="whitespace-pre-wrap font-sans">{m.content}</div>
                </div>
              ))}
            </div>

            {/* Input Bar */}
            <div className="flex gap-2 p-3 border-t border-zinc-200 bg-white shrink-0">
              <Input
                placeholder="Refine requirements, define edge cases..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
              />
              <Button variant="default" size="sm" onClick={handleSendMessage} disabled={loading || !prompt.trim()}>
                Send
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Right: PRD Markdown Editor & Version Approver */}
      <div className="flex flex-col h-full overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 bg-white shrink-0">
          <span className="font-semibold text-zinc-900 text-xs tracking-tight">PRD specification draft</span>
          {activeBaseline && (
            <span className="text-[11px] font-medium text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
              Active: {activeBaseline.version} (Approved)
            </span>
          )}
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <textarea
            className="flex-1 w-full p-5 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 resize-none focus:outline-none bg-zinc-50/40 leading-relaxed border-0"
            placeholder="# Specification Markdown will generate here..."
            value={specDraft}
            onChange={(e) => setSpecDraft(e.target.value)}
          />

          <div className="border-t border-zinc-200 bg-white p-3.5 flex flex-col gap-2.5 shrink-0">
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const latest = [...messages].reverse().find((message) => message.role === 'assistant')
                  if (latest) setSpecDraft(latest.content)
                }}
                disabled={!messages.some((message) => message.role === 'assistant')}
              >
                Use latest architect response
              </Button>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-zinc-100">
              <span className="text-[11px] text-zinc-400">
                Immutable audit lock on approval
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={handleApproveBaseline}
                disabled={loading || !specDraft.trim()}
              >
                Approve baseline v1.0.0
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
