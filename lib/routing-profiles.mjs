import {
  activateRoutingProfile,
  deleteRoutingProfile,
  listRoutingProfiles,
  upsertRoutingProfile,
} from './db.mjs'
import { findCodexModel, getCodexModels } from './codex-models.mjs'
import {
  ANTIGRAVITY_MODELS,
  findAntigravityModel,
  impliedAntigravityReasoningEffort,
  normalizeAntigravityModel,
} from './antigravity-models.mjs'
import { QWEN_MODELS } from './qwen-accounts.mjs'

export const VIRTUAL_MODELS = Object.freeze({
  opus: 'claude-zen-opus',
  sonnet: 'claude-zen-sonnet',
  haiku: 'claude-zen-haiku',
})

export const ROUTING_CATALOG = {
  codex: getCodexModels().map((item) => item.model),
  antigravity: ANTIGRAVITY_MODELS.map((item) => item.model),
  zen: [
    'qwen3.7-plus', 'mimo-v2.5', 'mimo-v2.5-free', 'x-preview-f-free', 'minimax-m3', 'kimi-k3',
    'glm-5', 'nemotron-3.5-lightning-free', 'ling-3.0-tiny-free',
    'laguna-s-2.1-free', 'hy3-free', 'nemotron-3-ultra-free',
  ],
  qwen: [...QWEN_MODELS],
}

const ANTIGRAVITY_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high'])

function antigravityRoutingMetadata(model) {
  const meta = findAntigravityModel(model)
  const supportedReasoningEfforts = meta?.supportedReasoningEfforts || ANTIGRAVITY_REASONING_EFFORTS
  let defaultReasoningEffort = supportedReasoningEfforts.length
    ? (meta?.defaultReasoningEffort || 'medium')
    : null
  const impliedEffort = impliedAntigravityReasoningEffort(model)
  if (impliedEffort) defaultReasoningEffort = impliedEffort
  return {
    meta,
    defaultReasoningEffort,
    supportedReasoningEfforts,
  }
}

export function refreshRoutingCatalog() {
  ROUTING_CATALOG.codex = getCodexModels().map((item) => item.model)
  return ROUTING_CATALOG
}

export function routingModelMetadata() {
  const agwMetadata = {}
  for (const model of ROUTING_CATALOG.antigravity) {
    const { meta, defaultReasoningEffort, supportedReasoningEfforts } = antigravityRoutingMetadata(model)
    const displayName = meta ? meta.displayName : model

    agwMetadata[model] = {
      id: model,
      model,
      displayName,
      defaultReasoningEffort,
      supportedReasoningEfforts,
    }
  }

  const zenMetadata = Object.fromEntries(
    ROUTING_CATALOG.zen.map((model) => [model, { id: model, model, displayName: model }]),
  )

  const qwenMetadata = Object.fromEntries(
    ROUTING_CATALOG.qwen.map((model) => [model, {
      id: model,
      model,
      displayName: `Qwen Chat (${model})`,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
    }]),
  )

  return {
    codex: Object.fromEntries(getCodexModels().map((item) => [item.model, item])),
    antigravity: agwMetadata,
    zen: zenMetadata,
    qwen: qwenMetadata,
  }
}

const TIERS = Object.keys(VIRTUAL_MODELS)

const DEFAULT_PROFILES = [
  {
    id: 'profile_serious_backend',
    name: 'Serious Backend',
    description: 'Maximum reasoning for architecture and implementation, fast Gemini for routine work.',
    tiers: {
      opus: { provider: 'codex', model: 'gpt-5.6-sol', reasoning_effort: 'high' },
      sonnet: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', fallback: { provider: 'codex', model: 'gpt-5.6-luna' } },
      haiku: { provider: 'codex', model: 'gpt-5.6-luna', reasoning_effort: 'medium', fallback: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' } },
    },
  },
  {
    id: 'profile_fast_fun',
    name: 'Fast & Fun',
    description: 'Low-latency defaults for exploration and lightweight tasks.',
    tiers: {
      opus: { provider: 'antigravity', model: 'claude-opus-4-6-thinking', fallback: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' } },
      sonnet: { provider: 'antigravity', model: 'claude-sonnet-4-6', fallback: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' } },
      haiku: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', fallback: { provider: 'antigravity', model: 'claude-sonnet-4-6' } },
    },
  },
  {
    id: 'profile_ox_alpha_free',
    name: 'Ox Alpha Free',
    description: 'Use OpenCode Zen Ox Alpha Free for every Claude tier.',
    tiers: {
      opus: { provider: 'zen', model: 'x-preview-f-free' },
      sonnet: { provider: 'zen', model: 'x-preview-f-free' },
      haiku: { provider: 'zen', model: 'x-preview-f-free' },
    },
  },
]

export function validateRoutingProfile(profile) {
  refreshRoutingCatalog()
  if (!profile || typeof profile !== 'object') throw new Error('Profile body is required')
  const name = String(profile.name || '').trim()
  if (!name || name.length > 80) throw new Error('Profile name must be 1-80 characters')
  const tiers = {}
  for (const tier of TIERS) {
    const route = profile.tiers?.[tier]
    if (!route) throw new Error(`Missing ${tier} route`)
    const provider = String(route.provider || '')
    const model = String(route.model || '')
    if (!ROUTING_CATALOG[provider]) throw new Error(`Unknown provider for ${tier}: ${provider}`)
    if (!ROUTING_CATALOG[provider].includes(model)) {
      throw new Error(`Model ${model} is not registered for provider ${provider}`)
    }
    const requestedEffort = route.reasoning_effort ? String(route.reasoning_effort) : null
    if (provider === 'codex') {
      const metadata = findCodexModel(model)
      if (requestedEffort && !metadata?.supportedReasoningEfforts.includes(requestedEffort)) {
        throw new Error(`${model} does not support reasoning effort ${requestedEffort}`)
      }
      tiers[tier] = {
        provider,
        model,
        reasoning_effort: requestedEffort || metadata?.defaultReasoningEffort || 'medium',
      }
    } else if (provider === 'antigravity') {
      const metadata = antigravityRoutingMetadata(model)
      const supportedEfforts = metadata.supportedReasoningEfforts
      if (requestedEffort && !supportedEfforts.includes(requestedEffort)) {
        throw new Error(`${model} does not support reasoning effort ${requestedEffort}`)
      }
      tiers[tier] = supportedEfforts.length
        ? { provider, model, reasoning_effort: requestedEffort || metadata.defaultReasoningEffort }
        : { provider, model }
    } else {
      tiers[tier] = { provider, model }
    }
    const fallback = route.fallback
    if (fallback) {
      const fallbackProvider = String(fallback.provider || '')
      const fallbackModel = String(fallback.model || '')
      if (!['codex', 'antigravity'].includes(fallbackProvider)) {
        throw new Error(`Fallback provider for ${tier} must be codex or antigravity`)
      }
      if (!ROUTING_CATALOG[fallbackProvider]?.includes(fallbackModel)) {
        throw new Error(`Fallback model ${fallbackModel} is not registered for provider ${fallbackProvider}`)
      }
      const metadata = fallbackProvider === 'codex'
        ? findCodexModel(fallbackModel)
        : antigravityRoutingMetadata(fallbackModel)
      tiers[tier].fallback = {
        provider: fallbackProvider,
        model: fallbackModel,
        ...(metadata?.defaultReasoningEffort ? { reasoning_effort: metadata.defaultReasoningEffort } : {}),
      }
    }
    const zenFallback = route.zen_fallback
    if (zenFallback) {
      const zenModel = String(zenFallback.model || zenFallback)
      if (!ROUTING_CATALOG.zen.includes(zenModel)) {
        throw new Error(`Zen fallback model ${zenModel} is not registered for provider zen`)
      }
      tiers[tier].zen_fallback = { provider: 'zen', model: zenModel }
    }
  }
  return {
    id: profile.id ? String(profile.id) : undefined,
    name,
    description: String(profile.description || '').slice(0, 300),
    tiers,
  }
}

export function ensureRoutingProfiles() {
  let profiles = listRoutingProfiles()
  if (!profiles.length) {
    for (const profile of DEFAULT_PROFILES) upsertRoutingProfile(profile)
    activateRoutingProfile(DEFAULT_PROFILES[0].id)
    profiles = listRoutingProfiles()
  } else {
    // Add newly shipped built-in profiles without disturbing the user's
    // active profile or custom profiles.
    let added = false
    for (const profile of DEFAULT_PROFILES) {
      if (!profiles.some((existing) => existing.id === profile.id)) {
        upsertRoutingProfile(profile)
        added = true
      }
    }
    if (added) profiles = listRoutingProfiles()
  }
  if (!profiles.some((profile) => profile.is_active)) {
    activateRoutingProfile(profiles[0].id)
    profiles = listRoutingProfiles()
  }
  const serious = profiles.find((profile) => profile.id === 'profile_serious_backend')
  if (serious && !serious.tiers.opus?.reasoning_effort) {
    serious.tiers.opus.reasoning_effort = 'high'
    if (serious.tiers.haiku?.provider === 'codex') serious.tiers.haiku.reasoning_effort = 'medium'
    upsertRoutingProfile(serious)
    profiles = listRoutingProfiles()
  }
  let migrated = false
  for (const profile of profiles) {
    let changed = false
    for (const tier of TIERS) {
      const route = profile.tiers[tier]
      if (!route.fallback) {
        const alternate = TIERS.map((name) => profile.tiers[name])
          .find((candidate) => candidate && candidate !== route && ['codex', 'antigravity'].includes(candidate.provider) && candidate.model !== route.model)
        route.fallback = alternate
          ? { provider: alternate.provider, model: alternate.model, ...(alternate.reasoning_effort ? { reasoning_effort: alternate.reasoning_effort } : {}) }
          : route.model === 'gemini-3.8-flash-tiered'
            ? { provider: 'antigravity', model: 'claude-sonnet-4-6' }
            : { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', reasoning_effort: 'medium' }
        changed = true
      }
      if (!route.zen_fallback) {
        route.zen_fallback = { provider: 'zen', model: tier === 'opus' ? 'qwen3.7-plus' : 'glm-5' }
        changed = true
      }
      if (route?.provider !== 'antigravity') continue
      const requestedModel = route.model
      const canonicalModel = normalizeAntigravityModel(requestedModel)
      if (!canonicalModel) continue
      if (canonicalModel !== requestedModel) {
        route.model = canonicalModel
        changed = true
      }
      const metadata = findAntigravityModel(canonicalModel)
      const efforts = metadata?.supportedReasoningEfforts || []
      if (!efforts.length && route.reasoning_effort) {
        delete route.reasoning_effort
        changed = true
      } else if (efforts.length && !efforts.includes(route.reasoning_effort)) {
        route.reasoning_effort = impliedAntigravityReasoningEffort(requestedModel)
          || metadata.defaultReasoningEffort
          || 'medium'
        changed = true
      }
    }
    if (changed) {
      upsertRoutingProfile(profile)
      migrated = true
    }
  }
  if (migrated) profiles = listRoutingProfiles()
  return profiles
}

export function getRoutingProfiles() {
  return ensureRoutingProfiles()
}

export function saveRoutingProfile(profile) {
  const clean = validateRoutingProfile(profile)
  const id = upsertRoutingProfile(clean)
  return getRoutingProfiles().find((item) => item.id === id)
}

export function setActiveRoutingProfile(id) {
  ensureRoutingProfiles()
  activateRoutingProfile(id)
  return getRoutingProfiles().find((profile) => profile.id === id)
}

export function removeRoutingProfile(id) {
  return deleteRoutingProfile(id)
}

export function activeRoutingProfile() {
  return ensureRoutingProfiles().find((profile) => profile.is_active)
}

export function tierForVirtualModel(model) {
  return TIERS.find((tier) => VIRTUAL_MODELS[tier] === model) || null
}

export function resolveVirtualRoute(model) {
  const tier = tierForVirtualModel(model)
  if (!tier) return null
  const profile = activeRoutingProfile()
  const route = { ...profile.tiers[tier] }
  if (route.provider === 'codex' && !route.reasoning_effort) {
    route.reasoning_effort = findCodexModel(route.model)?.defaultReasoningEffort || 'medium'
  }
  if (route.provider === 'antigravity' && !route.reasoning_effort) route.reasoning_effort = 'high'
  return { tier, profileId: profile.id, profileName: profile.name, ...route }
}

/**
 * Look up the zen_fallback model for a given requested model.
 * For virtual models (claude-zen-opus/sonnet/haiku), resolves the active
 * profile's tier directly. For direct models (gemini-3.8-flash-tiered, etc.),
 * searches the active profile's tiers for a matching primary or fallback model.
 * Returns the Zen model string (e.g. "glm-5") or null if not configured.
 */
export function zenFallbackForRoute(model) {
  if (!model) return null
  const tier = tierForVirtualModel(model)
  const profile = activeRoutingProfile()
  if (!profile?.tiers) return null
  if (tier) {
    return profile.tiers[tier]?.zen_fallback?.model || null
  }
  // First pass: match primary model
  for (const t of TIERS) {
    const route = profile.tiers[t]
    if (route?.model === model) {
      return route.zen_fallback?.model || null
    }
  }
  // Second pass: match fallback model
  for (const t of TIERS) {
    const route = profile.tiers[t]
    if (route?.fallback?.model === model) {
      return route.zen_fallback?.model || null
    }
  }
  return null
}
