import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findAntigravityModel,
  getModelFamily,
  isThinkingModel,
  impliedAntigravityReasoningEffort,
  normalizeAntigravityModel,
  antigravityAnthropicModels,
} from '../lib/antigravity-models.mjs'
import {
  convertAnthropicToGoogle,
  convertGoogleToAnthropic,
  sanitizeSchema,
  normalizeThinkingLevel,
} from '../lib/anthropic-antigravity.mjs'

test('validates supported Antigravity models: Gemini 3.8 Flash, Claude Opus 4.6, Claude Sonnet 4.6', () => {
  const gemini = findAntigravityModel('gemini-3.8-flash')
  assert.ok(gemini)
  assert.equal(gemini.family, 'gemini')
  assert.equal(gemini.maxOutputTokens, 65536)

  const geminiTiered = findAntigravityModel('gemini-3.8-flash-tiered')
  assert.ok(geminiTiered)
  assert.equal(normalizeAntigravityModel('gemini-3.8-flash-tiered'), 'gemini-3.8-flash-tiered')

  const opus = findAntigravityModel('claude-opus-4-6')
  assert.ok(opus)
  assert.equal(opus.family, 'claude')
  assert.equal(normalizeAntigravityModel('claude-opus-4-6'), 'claude-opus-4-6-thinking')
  assert.deepEqual(opus.supportedReasoningEfforts, [])

  const sonnet = findAntigravityModel('claude-sonnet-4-6')
  assert.ok(sonnet)
  assert.equal(sonnet.family, 'claude')
  assert.equal(normalizeAntigravityModel('claude-sonnet-4-6-thinking'), 'claude-sonnet-4-6')
  assert.equal(normalizeAntigravityModel('gemini-3.1-pro-high'), 'gemini-pro-agent')
  assert.equal(impliedAntigravityReasoningEffort('gemini-3.8-flash-high'), 'high')

  assert.equal(findAntigravityModel('unknown-model'), null)

  const catalog = antigravityAnthropicModels()
  assert.ok(catalog.length >= 3)
  assert.ok(catalog.some((m) => m.id === 'gemini-3.8-flash-tiered'))
  assert.ok(catalog.some((m) => m.id === 'claude-opus-4-6-thinking'))
  assert.ok(catalog.some((m) => m.id === 'claude-sonnet-4-6'))
  assert.ok(catalog.some((m) => m.id === 'gemini-pro-agent'))
})

test('converts Anthropic request to Google format with Gemini 3.8 thinking and tools', () => {
  const req = {
    model: 'gemini-3.8-flash-tiered',
    system: 'You are a helpful coding assistant.',
    messages: [
      { role: 'user', content: 'Read /tmp/test.txt' },
    ],
    tools: [
      {
        name: 'Read',
        description: 'Read file contents',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to file' },
          },
          required: ['file_path'],
        },
      },
    ],
    output_config: { effort: 'high' },
  }

  const google = convertAnthropicToGoogle(req)
  assert.equal(google.systemInstruction.parts[0].text, 'You are a helpful coding assistant.')
  assert.equal(google.contents[0].role, 'user')
  assert.equal(google.contents[0].parts[0].text, 'Read /tmp/test.txt')
  assert.deepEqual(google.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: 'HIGH',
  })
  assert.equal(google.generationConfig.maxOutputTokens, 65536)
  assert.equal(google.tools[0].functionDeclarations[0].name, 'Read')
  assert.equal(google.tools[0].functionDeclarations[0].parameters.type, 'object')
})

test('converts Claude Opus 4.6 request with interleaved thinking and tool definitions', () => {
  const req = {
    model: 'claude-opus-4-6',
    system: 'You are an architect.',
    messages: [
      { role: 'user', content: 'Design an app' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig_12345678901234567890123456789012345678901234567890' },
          { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: 'file1.txt\nfile2.txt' },
        ],
      },
    ],
    tools: [
      { name: 'Bash', description: 'Run bash command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
    ],
    thinking: { budget_tokens: 16000 },
  }

  const google = convertAnthropicToGoogle(req)
  assert.ok(google.systemInstruction.parts.some((p) => p.text.includes('Interleaved thinking is enabled')))
  assert.equal(google.generationConfig.thinkingConfig.include_thoughts, true)
  assert.equal(google.generationConfig.thinkingConfig.thinking_budget, 16000)

  // Assistant turn
  const assistantTurn = google.contents[1]
  assert.equal(assistantTurn.role, 'model')
  assert.equal(assistantTurn.parts[0].thought, true)
  assert.equal(assistantTurn.parts[1].functionCall.name, 'Bash')
  assert.equal(assistantTurn.parts[1].functionCall.id, 'toolu_01')

  // Tool result turn
  const userResultTurn = google.contents[2]
  assert.equal(userResultTurn.role, 'user')
  assert.equal(userResultTurn.parts[0].functionResponse.name, 'toolu_01')
  assert.equal(userResultTurn.parts[0].functionResponse.id, 'toolu_01')
})

test('converts Google responses to Anthropic messages with thinking, tools, and usage', () => {
  const googleResponse = {
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: 'Thinking about the answer...', thoughtSignature: 'sig_12345678901234567890123456789012345678901234567890' },
            { text: 'Here is the answer.' },
            { functionCall: { id: 'call_123', name: 'Read', args: { file_path: 'test.txt' } }, thoughtSignature: 'sig_12345678901234567890123456789012345678901234567890' },
          ],
        },
        finishReason: 'TOOL_USE',
      },
    ],
    usageMetadata: {
      promptTokenCount: 150,
      cachedContentTokenCount: 50,
      candidatesTokenCount: 75,
      thoughtsTokenCount: 40,
    },
  }

  const anthropic = convertGoogleToAnthropic(googleResponse, 'gemini-3.8-flash')
  assert.equal(anthropic.type, 'message')
  assert.equal(anthropic.role, 'assistant')
  assert.equal(anthropic.model, 'gemini-3.8-flash')
  assert.equal(anthropic.stop_reason, 'tool_use')
  assert.equal(anthropic.content[0].type, 'thinking')
  assert.equal(anthropic.content[0].thinking, 'Thinking about the answer...')
  assert.equal(anthropic.content[1].type, 'text')
  assert.equal(anthropic.content[1].text, 'Here is the answer.')
  assert.equal(anthropic.content[2].type, 'tool_use')
  assert.equal(anthropic.content[2].name, 'Read')
  assert.equal(anthropic.usage.input_tokens, 100) // 150 - 50 cached
  assert.equal(anthropic.usage.output_tokens, 75)
  assert.equal(anthropic.usage.reasoning_tokens, 40)
  assert.equal(anthropic.usage.cache_read_input_tokens, 50)
})

test('sanitizes tool schema properties safely', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'MyTool',
    type: 'object',
    properties: {
      items: {
        type: 'array',
      },
      nested: {
        type: 'object',
        default: {},
        properties: {
          code: { type: 'string', examples: ['foo'] },
          count: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100 },
        },
      },
    },
  }
  const clean = sanitizeSchema(schema)
  assert.equal(clean.$schema, undefined)
  assert.equal(clean.title, undefined)
  assert.equal(clean.properties.items.items.type, 'string')
  assert.equal(clean.properties.nested.default, undefined)
  assert.equal(clean.properties.nested.properties.code.examples, undefined)
  assert.equal(clean.properties.nested.properties.count.exclusiveMinimum, undefined)
  assert.equal(clean.properties.nested.properties.count.exclusiveMaximum, undefined)
})

test('transforms string const and sanitizes unsupported schema keywords recursively', () => {
  const clean = sanitizeSchema({
    type: 'object',
    propertyNames: { pattern: '^[a-z]+$' },
    additionalProperties: false,
    $defs: { state: { type: 'string' } },
    properties: {
      state: {
        anyOf: [
          { type: 'string', const: 'ready' },
          { type: 'null' },
        ],
      },
      values: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'string' },
      },
      linked: { $ref: '#/$defs/state' },
    },
  })

  assert.equal(clean.propertyNames, undefined)
  assert.equal(clean.properties.state.anyOf[0].const, undefined)
  assert.deepEqual(clean.properties.state.anyOf[0].enum, ['ready'])
  assert.equal(clean.properties.values.propertyNames, undefined)
  assert.equal(clean.properties.values.additionalProperties, undefined)
  assert.equal(clean.properties.linked.$ref, undefined)
  assert.equal(clean.$defs, undefined)
  assert.equal(clean.additionalProperties, undefined)
})
