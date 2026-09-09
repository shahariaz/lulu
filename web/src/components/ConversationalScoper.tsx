import React, { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card'
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

      // Synthesize initial PRD draft
      const draftText = `# Feature PRD: ${featureTitle}
## Executive Summary
${prompt || 'Requirements definition in progress...'}

## Functional Requirements
- REQ-F-01: Initial functional requirement
- REQ-F-02: Automated unit tests

## Nonfunctional Requirements
- REQ-NF-01: Execution latency within targets.`
      setSpecDraft(draftText)
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
      // 1. Draft baseline in SQLite
      const { draft } = await api.draftBaseline(project.id, specDraft, 'v1.0.0')
      // 2. Formally lock and approve baseline
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
      <Card className="h-full flex items-center justify-center text-center p-8">
        <p className="text-xs text-muted">Select or import a repository to begin conversational feature scoping.</p>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full overflow-hidden">
      {/* Left: Chat Scoper */}
      <Card className="flex flex-col h-full p-4">
        <CardHeader className="p-0 pb-3 mb-3">
          <CardTitle className="text-xs flex items-center justify-between">
            <span>Conversational Feature Scoper (Architect Model)</span>
            <Badge variant="ready">Configured Strong Model</Badge>
          </CardTitle>
        </CardHeader>

        {!conversationId ? (
          <div className="flex flex-col gap-3 my-auto max-w-md mx-auto w-full">
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">Feature Title</label>
              <Input
                placeholder="e.g. Distributed Lock Manager"
                value={featureTitle}
                onChange={(e) => setFeatureTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted mb-1">Initial Scope & Requirements</label>
              <textarea
                className="w-full h-24 p-2.5 rounded-md border border-border bg-black/20 text-sm placeholder:text-muted focus:outline-none focus:border-accent"
                placeholder="Describe goals, edge cases, APIs, and verification criteria..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <Button variant="primary" onClick={handleStartScoping} disabled={loading || !featureTitle.trim()}>
              {loading ? 'Starting Architect Session...' : 'Start Scoping Session'}
            </Button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Messages Transcript */}
            <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-2.5 mb-3">
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  className={`p-3 rounded-lg text-xs leading-relaxed max-w-[85%] ${
                    m.role === 'user'
                      ? 'bg-accent/15 border border-accent/30 text-foreground self-end'
                      : 'bg-card border border-border text-foreground self-start'
                  }`}
                >
                  <span className="block text-[10px] font-bold text-muted uppercase mb-1">
                    {m.role === 'user' ? 'Owner' : 'Architect'}
                  </span>
                  {m.content}
                </div>
              ))}
            </div>

            {/* Input Bar */}
            <div className="flex gap-2 pt-2 border-t border-border">
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
      </Card>

      {/* Right: PRD Markdown Editor & Version Approver */}
      <Card className="flex flex-col h-full p-4">
        <CardHeader className="p-0 pb-3 mb-3">
          <CardTitle className="text-xs flex items-center justify-between">
            <span>PRD Specification & Baseline Approver</span>
            {activeBaseline && (
              <span className="text-[11px] font-mono text-success bg-success/10 px-2 py-0.5 rounded border border-success/30">
                Active: {activeBaseline.version} (APPROVED)
              </span>
            )}
          </CardTitle>
        </CardHeader>

        <div className="flex-1 flex flex-col overflow-hidden">
          <textarea
            className="flex-1 w-full p-3 rounded-md border border-border bg-[#05070a] font-mono text-xs text-foreground placeholder:text-muted resize-none focus:outline-none focus:border-accent"
            placeholder="# Specification Markdown will generate here..."
            value={specDraft}
            onChange={(e) => setSpecDraft(e.target.value)}
          />

          <div className="flex items-center justify-between pt-3 mt-3 border-t border-border">
            <span className="text-[11px] text-muted font-mono">
              Immutable version locks on approval.
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={handleApproveBaseline}
              disabled={loading || !specDraft.trim()}
            >
              Approve Baseline v1.0.0
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
