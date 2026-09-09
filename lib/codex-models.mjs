import { getProviderModelCatalog, saveProviderModelCatalog } from './db.mjs'

export const FALLBACK_CODEX_MODELS = [
  { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], inputModalities: ['text', 'image'] },
  { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], inputModalities: ['text', 'image'] },
  { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], inputModalities: ['text', 'image'] },
  { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], inputModalities: ['text', 'image'] },
  { id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], inputModalities: ['text', 'image'] },
  { id: 'gpt-5.4-mini', model: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], inputModalities: ['text', 'image'] },
]

export function normalizeCodexModels(models = []) {
  const seen = new Set()
  return models.flatMap((item) => {
    const model = String(item.model || item.id || '')
    if (!model || item.hidden || seen.has(model)) return []
    seen.add(model)
    const efforts = (item.supportedReasoningEfforts || []).map((effort) =>
      typeof effort === 'string' ? effort : effort.reasoningEffort).filter(Boolean)
    return [{
      id: String(item.id || model),
      model,
      displayName: String(item.displayName || model),
      description: String(item.description || ''),
      isDefault: !!item.isDefault,
      defaultReasoningEffort: String(item.defaultReasoningEffort || efforts[0] || 'medium'),
      supportedReasoningEfforts: [...new Set(efforts)],
      inputModalities: item.inputModalities || ['text', 'image'],
      serviceTiers: item.serviceTiers || [],
    }]
  })
}

export function mergeCodexModels(catalogs = []) {
  const byModel = new Map()
  for (const catalog of catalogs) {
    for (const item of normalizeCodexModels(catalog)) {
      const existing = byModel.get(item.model)
      if (!existing) {
        byModel.set(item.model, item)
      } else {
        existing.supportedReasoningEfforts = [...new Set([
          ...existing.supportedReasoningEfforts,
          ...item.supportedReasoningEfforts,
        ])]
      }
    }
  }
  return [...byModel.values()]
}

export function saveCodexModels(models) {
  const normalized = normalizeCodexModels(models)
  if (normalized.length) saveProviderModelCatalog('codex', normalized)
  return normalized
}

export function getCodexModels() {
  return getProviderModelCatalog('codex')?.models || FALLBACK_CODEX_MODELS
}

export function findCodexModel(model, catalog = getCodexModels()) {
  return catalog.find((item) => item.model === model || item.id === model) || null
}

export function parseCodexModelSelection(selection, catalog = getCodexModels()) {
  const raw = String(selection || '')
  const at = raw.lastIndexOf('@')
  const model = at > 0 ? raw.slice(0, at) : raw
  const requestedEffort = at > 0 ? raw.slice(at + 1) : null
  const metadata = findCodexModel(model, catalog)
  if (!metadata) return null
  const effort = requestedEffort || metadata.defaultReasoningEffort
  if (!metadata.supportedReasoningEfforts.includes(effort)) {
    const error = new Error(`${model} does not support reasoning effort ${effort}`)
    error.statusCode = 400
    throw error
  }
  return { model: metadata.model, effort, metadata, explicitEffort: !!requestedEffort }
}

export function codexAnthropicModels(catalog = getCodexModels(), { includeEffortVariants = true } = {}) {
  const result = []
  for (const item of catalog) {
    const modalities = item.inputModalities || ['text', 'image']
    result.push({
      type: 'model',
      id: item.model,
      display_name: `${item.displayName} (default reasoning: ${item.defaultReasoningEffort})`,
      created_at: '2026-01-01T00:00:00Z',
      input_modalities: modalities,
      output_modalities: ['text'],
      max_tokens: 128000,
    })
    if (!includeEffortVariants) continue
    for (const effort of item.supportedReasoningEfforts) {
      result.push({
        type: 'model',
        id: `${item.model}@${effort}`,
        display_name: `${item.displayName} — reasoning ${effort}`,
        created_at: '2026-01-01T00:00:00Z',
        input_modalities: modalities,
        output_modalities: ['text'],
        max_tokens: 128000,
      })
    }
  }
  return result
}
