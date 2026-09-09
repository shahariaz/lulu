import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyNativeReasoningEffort,
  activityStatus,
  anthropicActivity,
  isThinkingOnlyMaxTokens,
  lowerReasoningEffort,
  openAiActivity,
  reasoningEffortFor,
  upstreamAccount,
} from '../lib/activity.mjs'

test('extracts Anthropic reasoning, tools, tokens, and stop diagnostics', () => {
  const result = anthropicActivity({
    usage: { input_tokens: 120, output_tokens: 45 },
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: 'consider the available files' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/secret' } },
    ],
  })

  assert.equal(result.inputTokens, 120)
  assert.equal(result.outputTokens, 45)
  assert.equal(result.stopReason, 'tool_use')
  assert.ok(result.reasoningTokens > 0)
  assert.deepEqual(result.toolsCalled, [{ id: 'tool_1', name: 'Read' }])
  assert.doesNotMatch(JSON.stringify(result.toolsCalled), /secret/)
})

test('detects reasoning-only exhaustion and lowers effort once', () => {
  assert.equal(isThinkingOnlyMaxTokens({
    stop_reason: 'max_tokens',
    content: [{ type: 'thinking', thinking: 'still reasoning' }],
  }), true)
  assert.equal(isThinkingOnlyMaxTokens({
    stop_reason: 'max_tokens',
    content: [
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
    ],
  }), false)
  assert.equal(isThinkingOnlyMaxTokens('{bad json'), false)
  assert.equal(lowerReasoningEffort('high'), 'medium')
  assert.equal(lowerReasoningEffort('medium'), 'low')
  assert.equal(lowerReasoningEffort('low'), null)
})

test('extracts OpenAI diagnostics and provider status deterministically', () => {
  const result = openAiActivity({
    choices: [{
      finish_reason: 'stop',
      message: {
        reasoning_content: 'brief reasoning',
        tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"command":"private"}' } }],
      },
    }],
    usage: {
      prompt_tokens: 30,
      completion_tokens: 12,
      completion_tokens_details: { reasoning_tokens: 7 },
    },
  })

  assert.deepEqual(result, {
    inputTokens: 30,
    outputTokens: 12,
    reasoningTokens: 7,
    toolsCalled: [{ id: 'call_1', name: 'Bash' }],
    stopReason: 'stop',
  })
  assert.equal(activityStatus(429, 'quota reached'), 'rate_limited')
  assert.equal(activityStatus(503, 'offline'), 'error')
  assert.equal(activityStatus(200), 'success')
})

test('uses explicit reasoning effort and genuine upstream account headers', () => {
  const headers = new Headers({ 'x-account-email': 'account@example.com' })
  assert.equal(upstreamAccount({ headers }, 'antigravity'), 'account@example.com')
  assert.equal(upstreamAccount({ headers: new Headers() }, 'antigravity'), 'antigravity-pool')
  assert.equal(
    reasoningEffortFor({ output_config: { effort: 'high' } }, { reasoning_effort: 'low' }),
    'high',
  )
})

test('profile reasoning effort overrides Claude Code request effort for virtual routes', () => {
  const body = {
    claude_zen: { reasoning_effort: 'high' },
    output_config: { effort: 'high' },
    effort: 'high',
  }
  const effort = applyNativeReasoningEffort(body, {
    provider: 'antigravity',
    reasoning_effort: 'low',
  }, { authoritative: true })

  assert.equal(effort, 'low')
  assert.equal(body.claude_zen.reasoning_effort, undefined)
  assert.equal(body.output_config.effort, 'low')
  assert.equal(body.effort, undefined)
})
