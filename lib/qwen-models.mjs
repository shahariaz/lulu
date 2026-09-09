export const QWEN_WEB_MODELS = Object.freeze([
  {
    model: 'qwen3.8-max',
    displayName: 'Qwen 3.8 Max (Web Thinking)',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['high'],
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    contextLength: 1000000,
    maxOutputTokens: 131072,
  },
  {
    model: 'qwen-web/qwen3.7-max',
    canonicalModel: 'qwen3.7-max',
    displayName: 'Qwen 3.7 Max (Web)',
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    supportsThinking: false,
    supportsTools: true,
    supportsVision: false,
    contextLength: 1000000,
    maxOutputTokens: 65536,
  },
  {
    model: 'qwen-web/qwen3.7-plus',
    canonicalModel: 'qwen3.7-plus',
    displayName: 'Qwen 3.7 Plus (Web)',
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    supportsThinking: false,
    supportsTools: true,
    supportsVision: false,
    contextLength: 1000000,
    maxOutputTokens: 65536,
  },
  {
    model: 'qwen-web/qwen3.6-plus',
    canonicalModel: 'qwen3.6-plus',
    displayName: 'Qwen 3.6 Plus (Web)',
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    supportsThinking: false,
    supportsTools: true,
    supportsVision: false,
    contextLength: 1000000,
    maxOutputTokens: 65536,
  },
])

export const QWEN_WEB_MODEL_ALIASES = Object.freeze({
  'qwen-web': 'qwen3.8-max',
  'qwen3.8-max': 'qwen3.8-max',
  'qwen3.8-max-preview': 'qwen3.8-max',
  'qwen3.8-max-web': 'qwen3.8-max',
  'qwen-web/qwen3.8-max': 'qwen3.8-max',
  'qwen-web/qwen3.8-max-preview': 'qwen3.8-max',
  'qwen-web/qwen3.7-max': 'qwen3.7-max',
  'qwen3.7-max-web': 'qwen3.7-max',
  'qwen-max-web': 'qwen3.7-max',
  'qwen-web/qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.7-plus-web': 'qwen3.7-plus',
  'qwen-plus-web': 'qwen3.7-plus',
  'qwen-web/qwen3.6-plus': 'qwen3.6-plus',
  'qwen3.6-plus-web': 'qwen3.6-plus',
})

export function normalizeQwenWebModel(requestedModel) {
  if (!requestedModel || typeof requestedModel !== 'string') return null
  const cleaned = requestedModel.trim().toLowerCase()
  if (QWEN_WEB_MODEL_ALIASES[cleaned]) return QWEN_WEB_MODEL_ALIASES[cleaned]
  return null
}

export function findQwenWebModel(model) {
  const normalized = normalizeQwenWebModel(model)
  if (!normalized) return null
  return (
    QWEN_WEB_MODELS.find((m) => m.model === normalized || m.canonicalModel === normalized) || null
  )
}

export function isQwenWebModel(model) {
  return normalizeQwenWebModel(model) !== null
}

export function qwenWebAnthropicModels() {
  return QWEN_WEB_MODELS.map((item) => ({
    type: 'model',
    id: item.model,
    display_name: item.displayName,
    created_at: '2026-01-01T00:00:00Z',
    input_modalities: item.supportsVision ? ['text', 'image'] : ['text'],
    output_modalities: ['text'],
    max_tokens: item.maxOutputTokens,
  }))
}
