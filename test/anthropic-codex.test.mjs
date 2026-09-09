import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicToCodexInput,
  anthropicToolsToDynamic,
  buildCodexInstructions,
  codexInputCharacterCount,
  extractClaudeWorkingDirectory,
  extractToolResults,
  normalizeToolArguments,
  toolResultContentItems,
  truncateTextForCodex,
} from '../lib/anthropic-codex.mjs'

test('extracts Claude Code primary working directory from its system environment', () => {
  const system = [{
    type: 'text',
    text: '# Environment\n - Primary working directory: /private/tmp/my-project\n - Is a git repository: false',
  }]
  assert.equal(extractClaudeWorkingDirectory(system), '/private/tmp/my-project')
  assert.equal(extractClaudeWorkingDirectory('No environment metadata'), null)
})

test('passes Anthropic tool schemas to Codex as native dynamic tools', () => {
  const tools = anthropicToolsToDynamic([{
    name: 'read_file',
    description: 'Read one file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  }])

  assert.deepEqual(tools, [{
    type: 'function',
    name: 'read_file',
    description: 'Read one file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  }])
})

test('keeps Claude Code as the only execution harness', () => {
  const instructions = buildCodexInstructions({
    system: [{ type: 'text', text: 'Follow the project instructions.' }],
  })

  assert.match(instructions, /Claude Code is the only tool harness/)
  assert.match(instructions, /Use the dynamic tools supplied by the client/)
  assert.match(instructions, /sandbox mirrors Claude Code's supplied tool capabilities/)
  assert.match(instructions, /Native apply_patch is the only built-in exception/)
  assert.match(instructions, /Do not write outside that directory/)
  assert.match(instructions, /Follow the project instructions/)
})

test('honors Anthropic tool_choice none', () => {
  const body = { tool_choice: { type: 'none' } }

  assert.deepEqual(anthropicToolsToDynamic([{ name: 'read_file' }], body.tool_choice), [])
  assert.match(buildCodexInstructions(body), /Do not call a tool/)
})

test('preserves conversation and tool history without XML tool prompting', () => {
  const [input] = anthropicToCodexInput({
    messages: [
      { role: 'user', content: 'Inspect the file.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.js' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'export const a = 1' }],
      },
    ],
  })

  assert.match(input.text, /Inspect the file/)
  assert.match(input.text, /read_file \(call id call_1\)/)
  assert.match(input.text, /export const a = 1/)
  assert.doesNotMatch(input.text, /<tool_call/)
})

test('matches and converts Claude Code tool results', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_2',
        content: [{ type: 'text', text: 'done' }],
      }],
    }],
  }
  const [result] = extractToolResults(body)

  assert.equal(result.tool_use_id, 'call_2')
  assert.deepEqual(toolResultContentItems(result), [{ type: 'inputText', text: 'done' }])
  assert.deepEqual(normalizeToolArguments('{"path":"a.js"}'), { path: 'a.js' })
})

test('caps oversized transcripts while preserving their beginning and newest content', () => {
  const text = 'start-' + 'x'.repeat(1_000) + '-newest-request'
  const [input] = anthropicToCodexInput({
    messages: [{ role: 'user', content: text }],
  }, { maxTextChars: 200 })

  assert.equal(input.text.length, 200)
  assert.match(input.text, /^Continue this conversation/)
  assert.match(input.text, /content truncated by claude-zen/)
  assert.match(input.text, /newest-request$/)
  assert.equal(codexInputCharacterCount([input]), 200)
})

test('caps oversized tool results to the supplied character budget', () => {
  const [item] = toolResultContentItems({ content: 'head-' + 'x'.repeat(1_000) + '-tail' }, {
    maxTextChars: 160,
  })

  assert.equal(item.text.length, 160)
  assert.match(item.text, /^head-/)
  assert.match(item.text, /content truncated by claude-zen/)
  assert.match(item.text, /-tail$/)
  assert.equal(truncateTextForCodex('short', 10), 'short')
})
