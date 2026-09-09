import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-routing-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'routing.sqlite')

const routing = await import('../lib/routing-profiles.mjs')

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

test('seeds a usable profile and resolves stable Claude tier aliases', () => {
  const profiles = routing.getRoutingProfiles()
  assert.ok(profiles.some((profile) => profile.is_active))
  const oxAlpha = profiles.find((profile) => profile.id === 'profile_ox_alpha_free')
  assert.ok(oxAlpha)
  assert.equal(oxAlpha.tiers.sonnet.model, 'x-preview-f-free')
  assert.equal(oxAlpha.tiers.sonnet.provider, 'zen')
  assert.deepEqual(routing.resolveVirtualRoute('claude-zen-opus'), {
    tier: 'opus',
    profileId: 'profile_serious_backend',
    profileName: 'Serious Backend',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoning_effort: 'high',
    fallback: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
    zen_fallback: { provider: 'zen', model: 'qwen3.7-plus' },
  })
})

test('switches a profile at runtime without changing the virtual model', () => {
  const profile = routing.saveRoutingProfile({
    name: 'Test Runtime Route',
    tiers: {
      opus: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', reasoning_effort: 'high' },
      sonnet: { provider: 'zen', model: 'mimo-v2.5' },
      haiku: { provider: 'codex', model: 'gpt-5.6-luna' },
    },
  })
  routing.setActiveRoutingProfile(profile.id)
  assert.equal(routing.resolveVirtualRoute('claude-zen-sonnet').model, 'mimo-v2.5')
  assert.equal(routing.resolveVirtualRoute('claude-zen-sonnet').provider, 'zen')
})

test('edits the active profile in place and resolves the change on the next turn', () => {
  const active = routing.activeRoutingProfile()
  const countBefore = routing.getRoutingProfiles().length
  const updated = routing.saveRoutingProfile({
    id: active.id,
    name: active.name,
    description: 'Edited while the Claude session remains open',
    tiers: {
      ...active.tiers,
      sonnet: { provider: 'zen', model: 'minimax-m3' },
    },
  })

  assert.equal(updated.id, active.id)
  assert.equal(updated.is_active, true)
  assert.equal(routing.getRoutingProfiles().length, countBefore)
  assert.equal(routing.resolveVirtualRoute('claude-zen-sonnet').model, 'minimax-m3')
})

test('rejects a model assigned to the wrong provider', () => {
  assert.throws(() => routing.validateRoutingProfile({
    name: 'Invalid',
    tiers: {
      opus: { provider: 'zen', model: 'gpt-5.6-sol' },
      sonnet: { provider: 'zen', model: 'mimo-v2.5' },
      haiku: { provider: 'zen', model: 'mimo-v2.5-free' },
    },
  }), /not registered/)
})

test('persists supported Gemini thinking levels and rejects invalid ones', () => {
  const profile = routing.saveRoutingProfile({
    name: 'Gemini Effort Route',
    tiers: {
      opus: {
        provider: 'antigravity',
        model: 'gemini-3.8-flash-tiered',
        reasoning_effort: 'medium',
      },
      sonnet: { provider: 'zen', model: 'mimo-v2.5' },
      haiku: { provider: 'zen', model: 'mimo-v2.5-free' },
    },
  })
  assert.equal(profile.tiers.opus.reasoning_effort, 'medium')

  assert.throws(() => routing.validateRoutingProfile({
    name: 'Invalid Gemini Effort',
    tiers: {
      opus: {
        provider: 'antigravity',
        model: 'gemini-3.8-flash-tiered',
        reasoning_effort: 'xhigh',
      },
      sonnet: { provider: 'zen', model: 'mimo-v2.5' },
      haiku: { provider: 'zen', model: 'mimo-v2.5-free' },
    },
  }), /does not support reasoning effort/)
})

test('uses each Antigravity model default effort when a profile omits it', () => {
  const profile = routing.validateRoutingProfile({
    name: 'Antigravity Defaults',
    tiers: {
      opus: { provider: 'antigravity', model: 'claude-opus-4-6-thinking' },
      sonnet: { provider: 'antigravity', model: 'claude-sonnet-4-6' },
      haiku: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
    },
  })

  assert.equal(profile.tiers.opus.reasoning_effort, undefined)
  assert.equal(profile.tiers.sonnet.reasoning_effort, undefined)
  assert.equal(profile.tiers.haiku.reasoning_effort, 'medium')
})

test('exposes fixed Gemini Pro presets without an adjustable effort', () => {
  const profile = routing.validateRoutingProfile({
    name: 'Antigravity Pro Presets',
    tiers: {
      opus: { provider: 'antigravity', model: 'gemini-pro-agent' },
      sonnet: { provider: 'antigravity', model: 'gemini-3.1-pro-low' },
      haiku: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
    },
  })

  assert.equal(profile.tiers.opus.reasoning_effort, undefined)
  assert.equal(profile.tiers.sonnet.reasoning_effort, undefined)
  assert.equal(profile.tiers.haiku.reasoning_effort, 'medium')
})
