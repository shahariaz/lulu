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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full overflow-hidden">
      {/* Left: Chat Scoper */}
      <Card className="flex flex-col h-full p-4 border-2 border-black bg-white rounded-none">
        <CardHeader className="p-0 pb-3 mb-3 border-b-2 border-black">
          <CardTitle className="text-xs flex items-center justify-between w-full font-mono">
            <span className="font-black uppercase tracking-wider text-black">[01] SCOPING ARCHITECT</span>
            <Badge variant="ready">ARCHITECT MODEL</Badge>
          </CardTitle>
        </CardHeader>

        {!conversationId ? (
          <div className="flex flex-col gap-3 my-auto max-w-md mx-auto w-full">
            <div>
              <label className="block text-[10px] font-black uppercase tracking-wider text-black font-mono mb-1">
                FEATURE TITLE
              </label>
              <Input
                placeholder="e.g. DISTRIBUTED LOCK MANAGER"
                value={featureTitle}
                onChange={(e) => setFeatureTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-wider text-black font-mono mb-1">
                SCOPE & REQUIREMENTS OUTLINE
              </label>
              <textarea
                className="w-full h-28 p-3 rounded-none border-2 border-black bg-white text-xs font-medium text-black placeholder:text-neutral-400 focus:outline-none focus:border-swiss-red resize-none"
                placeholder="Describe goals, edge cases, APIs, and verification criteria..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            {error && <p className="text-xs font-mono font-bold text-swiss-red uppercase">{error}</p>}
            <Button variant="default" onClick={handleStartScoping} disabled={loading || !featureTitle.trim()}>
              {loading ? 'INITIALIZING ARCHITECT...' : 'COMMENCE SCOPING SESSION'}
            </Button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Messages Transcript */}
            <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-2.5 mb-3">
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  className={`p-3.5 rounded-none border-2 border-black text-xs leading-relaxed max-w-[85%] ${
                    m.role === 'user'
                      ? 'bg-black text-white self-end'
                      : 'bg-swiss-gray text-black self-start'
                  }`}
                >
                  <span className={`block text-[9px] font-black uppercase font-mono mb-1 ${m.role === 'user' ? 'text-swiss-red' : 'text-neutral-500'}`}>
                    {m.role === 'user' ? '[OWNER]' : '[ARCHITECT]'}
                  </span>
                  <div className="whitespace-pre-wrap font-sans">{m.content}</div>
                </div>
              ))}
            </div>

            {/* Input Bar */}
            <div className="flex gap-2 pt-2 border-t-2 border-black">
              <Input
                placeholder="Refine requirements, define edge cases..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
              />
              <Button variant="default" size="sm" onClick={handleSendMessage} disabled={loading || !prompt.trim()}>
                SEND
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Right: PRD Markdown Editor & Version Approver */}
      <Card className="flex flex-col h-full p-4 border-2 border-black bg-white rounded-none">
        <CardHeader className="p-0 pb-3 mb-3 border-b-2 border-black">
          <CardTitle className="text-xs flex items-center justify-between w-full font-mono">
            <span className="font-black uppercase tracking-wider text-black">[02] PRD SPECIFICATION DRAFT</span>
            {activeBaseline && (
              <span className="text-[10px] font-mono font-black text-emerald-800 bg-emerald-100 px-2 py-0.5 border border-black uppercase">
                ACTIVE: {activeBaseline.version} (APPROVED)
              </span>
            )}
          </CardTitle>
        </CardHeader>

        <div className="flex-1 flex flex-col overflow-hidden">
          <textarea
            className="flex-1 w-full p-3.5 rounded-none border-2 border-black bg-swiss-gray font-mono text-xs text-black placeholder:text-neutral-400 resize-none focus:outline-none focus:border-swiss-red leading-relaxed"
            placeholder="# Specification Markdown will generate here..."
            value={specDraft}
            onChange={(e) => setSpecDraft(e.target.value)}
          />

          <div className="mt-2 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const latest = [...messages].reverse().find((message) => message.role === 'assistant')
                if (latest) setSpecDraft(latest.content)
              }}
              disabled={!messages.some((message) => message.role === 'assistant')}
            >
              USE LATEST ARCHITECT RESPONSE
            </Button>
          </div>

          <div className="flex items-center justify-between pt-3 mt-3 border-t-2 border-black">
            <span className="text-[10px] text-neutral-500 font-mono font-bold uppercase">
              IMMUTABLE AUDIT LOCK ON APPROVAL
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={handleApproveBaseline}
              disabled={loading || !specDraft.trim()}
            >
              APPROVE BASELINE V1.0.0
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
