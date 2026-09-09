// Callable Cloud Code model IDs. Display names and aliases are intentionally
// separate: fetchAvailableModels advertises some friendly/legacy IDs that the
// generation endpoint does not accept directly.

export const ANTIGRAVITY_MODELS = Object.freeze([
  {
    id: 'gemini-3.8-flash-tiered',
    model: 'gemini-3.8-flash-tiered',
    family: 'gemini',
    displayName: 'Gemini 3.8 Flash',
    description: 'Google Gemini 3.8 Flash with native thinking levels and 64k output window',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    maxOutputTokens: 65536,
    inputModalities: ['text', 'image'],
    isDefault: true,
    aliases: ['gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8-flash-xhigh', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'],
  },
  {
    id: 'claude-opus-4-6-thinking',
    model: 'claude-opus-4-6-thinking',
    family: 'claude',
    displayName: 'Claude Opus 4.6 (Thinking)',
    description: 'Anthropic Claude Opus 4.6 via Google Cloud Code with interleaved thinking',
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    maxOutputTokens: 65536,
    inputModalities: ['text', 'image'],
    isDefault: false,
    aliases: ['claude-opus-4-6'],
  },
  {
    id: 'claude-sonnet-4-6',
    model: 'claude-sonnet-4-6',
    family: 'claude',
    displayName: 'Claude Sonnet 4.6 (Thinking)',
    description: 'Anthropic Claude Sonnet 4.6 via Google Cloud Code with interleaved thinking',
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    maxOutputTokens: 65536,
    inputModalities: ['text', 'image'],
    isDefault: false,
    aliases: ['claude-sonnet-4-6-thinking'],
  },
  {
    id: 'gemini-3.1-pro-low',
    model: 'gemini-3.1-pro-low',
    family: 'gemini',
    displayName: 'Gemini 3.1 Pro (Low)',
    description: 'Google Gemini 3.1 Pro with the low thinking preset',
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    maxOutputTokens: 65536,
    inputModalities: ['text', 'image'],
    isDefault: false,
    aliases: [],
  },
  {
    id: 'gemini-pro-agent',
    model: 'gemini-pro-agent',
    family: 'gemini',
    displayName: 'Gemini 3.1 Pro (High)',
    description: 'Google Gemini 3.1 Pro with the high thinking preset',
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    maxOutputTokens: 65536,
    inputModalities: ['text', 'image'],
    isDefault: false,
    aliases: ['gemini-3.1-pro', 'gemini-3.1-pro-high'],
  },
])

const MODEL_MAP = new Map()
for (const m of ANTIGRAVITY_MODELS) {
  MODEL_MAP.set(m.model.toLowerCase(), m)
  MODEL_MAP.set(m.id.toLowerCase(), m)
  for (const alias of m.aliases || []) {
    MODEL_MAP.set(alias.toLowerCase(), m)
  }
}

export function findAntigravityModel(name) {
  if (!name || typeof name !== 'string') return null
  const clean = name.trim().toLowerCase()
  return MODEL_MAP.get(clean) || null
}

export function normalizeAntigravityModel(name) {
  const meta = findAntigravityModel(name)
  return meta ? meta.model : null
}

export function impliedAntigravityReasoningEffort(name) {
  const clean = String(name || '').trim().toLowerCase()
  if (clean === 'gemini-pro-agent' || clean === 'gemini-3.1-pro' || clean === 'gemini-3.1-pro-high') return 'high'
  if (clean.endsWith('-low')) return 'low'
  if (clean.endsWith('-high') || clean.endsWith('-xhigh')) return 'high'
  return null
}

export function getModelFamily(modelName) {
  const meta = findAntigravityModel(modelName)
  if (meta) return meta.family
  const lower = (modelName || '').toLowerCase()
  if (lower.includes('claude')) return 'claude'
  if (lower.includes('gemini')) return 'gemini'
  return 'unknown'
}

export function isThinkingModel(modelName) {
  const meta = findAntigravityModel(modelName)
  if (meta) return meta.family === 'claude' || meta.model.startsWith('gemini-')
  const lower = (modelName || '').toLowerCase()
  return lower.includes('thinking') || lower.includes('gemini-3') || lower.includes('claude')
}

export function antigravityAnthropicModels() {
  const result = []
  for (const item of ANTIGRAVITY_MODELS) {
    result.push({
      type: 'model',
      id: item.model,
      display_name: item.defaultReasoningEffort
        ? `${item.displayName} (default reasoning: ${item.defaultReasoningEffort})`
        : item.displayName,
      created_at: '2026-01-01T00:00:00Z',
      input_modalities: item.inputModalities,
      output_modalities: ['text'],
      max_tokens: item.maxOutputTokens,
    })
    for (const alias of item.aliases) {
      result.push({
        type: 'model',
        id: alias,
        display_name: `${item.displayName} (${alias})`,
        created_at: '2026-01-01T00:00:00Z',
        input_modalities: item.inputModalities,
        output_modalities: ['text'],
        max_tokens: item.maxOutputTokens,
      })
    }
  }
  return result
}
