import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  anthropicToOpenAiMessages,
  anthropicToOpenAiTools,
  QwenClient,
} from '../lib/qwen-client.mjs'

test('anthropicToOpenAiMessages converts system prompt and user text', () => {
  const result = anthropicToOpenAiMessages({
    system: 'You are an expert coder.',
    messages: [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there!' },
    ],
  })

  assert.deepEqual(result, [
    { role: 'system', content: 'You are an expert coder.' },
    { role: 'user', content: 'Hello world' },
    { role: 'assistant', content: 'Hi there!' },
  ])
})

test('anthropicToOpenAiMessages converts tool_use and tool_result blocks', () => {
  const result = anthropicToOpenAiMessages({
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Check weather in London' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking now...' },
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'get_weather',
            input: { location: 'London' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: '{"temp": 18, "condition": "Cloudy"}',
          },
        ],
      },
    ],
  })

  assert.equal(result.length, 3)
  assert.equal(result[0].role, 'user')
  assert.equal(result[0].content, 'Check weather in London')

  assert.equal(result[1].role, 'assistant')
  assert.equal(result[1].content, 'Checking now...')
  assert.equal(result[1].tool_calls.length, 1)
  assert.equal(result[1].tool_calls[0].id, 'call_123')
  assert.equal(result[1].tool_calls[0].function.name, 'get_weather')
  assert.equal(result[1].tool_calls[0].function.arguments, '{"location":"London"}')

  assert.equal(result[2].role, 'tool')
  assert.equal(result[2].tool_call_id, 'call_123')
  assert.equal(result[2].content, '{"temp": 18, "condition": "Cloudy"}')
})

test('anthropicToOpenAiTools formats Anthropic tool schemas to OpenAI format', () => {
  const anthropicTools = [
    {
      name: 'search_files',
      description: 'Search files matching a pattern',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  ]

  const openAiTools = anthropicToOpenAiTools(anthropicTools)
  assert.equal(openAiTools.length, 1)
  assert.equal(openAiTools[0].type, 'function')
  assert.equal(openAiTools[0].function.name, 'search_files')
  assert.equal(openAiTools[0].function.description, 'Search files matching a pattern')
  assert.deepEqual(openAiTools[0].function.parameters, anthropicTools[0].input_schema)
})

test('iterateSseStream correctly parses OpenAI chunk SSE lines', async () => {
  const sseData = [
    'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"content":" "}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"content":"Qwen"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseData))
      controller.close()
    },
  })

  const client = new QwenClient()
  const deltas = []
  for await (const chunk of client.iterateSseStream(stream)) {
    deltas.push(chunk?.choices?.[0]?.delta?.content)
  }

  assert.deepEqual(deltas, ['Hello', ' ', 'Qwen'])
})
