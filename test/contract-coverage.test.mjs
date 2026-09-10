import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guard: every module that talks to an external system must have a contract test.
 *
 * This runs in the HERMETIC suite (no gateway needed) and enforces the rule that
 * test/contract/ exists to serve. Without it, that suite decays the first time someone adds a
 * gateway-calling module and forgets — and we are back to the failure mode that produced three
 * shipped defects:
 *
 *   the mock sits exactly where the bug is, so the test proves everything except the
 *   broken thing.
 *
 * If this fails, the fix is to add a contract test that exercises the new module WITHOUT
 * injecting its mock seam — not to add the module to the exemption list.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = path.join(repoRoot, 'lib', 'orchestrator')
const contractDir = path.join(repoRoot, 'test', 'contract')

/**
 * Modules that call a gateway but are legitimately covered elsewhere.
 * Adding an entry here is a decision to be argued, not a way to silence the guard.
 */
const EXEMPT = new Map([
  // The transport itself is exercised by every contract test, and directly by
  // "the gateway speaks the Anthropic Messages API we depend on".
  ['gateway-errors.mjs', 'the shared transport, covered directly by gateway.contract.mjs'],
  // qa-engine's external dependency is the agent-browser CLI, not the gateway. It has a live
  // browser test in test/qa-engine.test.mjs that drives real headless Chrome.
  ['qa-engine.mjs', 'its real dependency is agent-browser; covered live in test/qa-engine.test.mjs'],
])

function listEngineModules(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listEngineModules(full))
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

test('every gateway-calling module has a contract test that skips its mock seam', () => {
  const gatewayCallers = listEngineModules(engineDir)
    .filter((file) => /callGatewayForText/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.basename(file))

  assert.ok(gatewayCallers.length > 0, 'expected to find modules calling the gateway')

  const contractSource = fs.existsSync(contractDir)
    ? fs.readdirSync(contractDir)
      .filter((f) => f.endsWith('.contract.mjs'))
      .map((f) => fs.readFileSync(path.join(contractDir, f), 'utf8'))
      .join('\n')
    : ''

  assert.ok(contractSource.length > 0, 'test/contract/ must contain at least one contract test')

  const uncovered = gatewayCallers.filter((moduleName) => {
    if (EXEMPT.has(moduleName)) return false
    // A contract test covers a module if it imports it.
    return !contractSource.includes(`/${moduleName}'`)
  })

  assert.deepEqual(
    uncovered,
    [],
    `These modules call a model gateway but no contract test exercises them:\n` +
    uncovered.map((m) => `  - lib/orchestrator/${m}`).join('\n') +
    `\n\nAdd a test in test/contract/ that calls the real gateway WITHOUT injecting the ` +
    `module's mock seam. Three defects shipped past a green suite because the mock sat exactly ` +
    `where the bug was; this guard exists so that cannot quietly happen again.`,
  )
})

test('contract tests are excluded from the hermetic suite', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

  // `npm test` must stay runnable with no gateway and no quota spend — CI depends on it.
  assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/)
  assert.doesNotMatch(pkg.scripts.test, /contract/,
    'npm test must not run contract tests — they need infrastructure and spend real quota')
  assert.ok(pkg.scripts['test:contract'], 'a test:contract script must exist')
})

test('contract tests skip loudly rather than passing silently when the gateway is down', () => {
  const files = fs.existsSync(contractDir)
    ? fs.readdirSync(contractDir).filter((f) => f.endsWith('.contract.mjs'))
    : []

  assert.ok(files.length > 0)

  for (const file of files) {
    const source = fs.readFileSync(path.join(contractDir, file), 'utf8')
    // A contract test that silently passes without reaching the dependency is worse than none:
    // it reports coverage it does not have.
    assert.match(source, /skip/,
      `${file} must skip with a stated reason when its dependency is unavailable`)
    assert.match(source, /unreachable|not available|start it with/i,
      `${file}'s skip reason must tell the reader how to run it`)
  }
})

/**
 * Guard: a call whose output is PARSED must not run on the default chat budget.
 *
 * The blueprint call and the decomposition call were each raised to 32000 separately, after each
 * was caught failing in production. Both times, market-research structuring and the QA verdict
 * were left on the 4096 default — not because anyone decided they were fine, but because nothing
 * connected "this response gets JSON.parse'd" to "this needs a reasoning-aware budget".
 *
 * The failure is silent by construction: max_tokens is shared with reasoning, so the response
 * comes back cut off mid-array while reporting stop_reason "end_turn", and surfaces downstream
 * as "malformed JSON".
 */
test('every gateway call whose output is parsed sets an explicit token budget', () => {
  const offenders = []

  for (const file of listEngineModules(engineDir)) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes('callGatewayForText')) continue

    const lines = source.split('\n')
    lines.forEach((line, i) => {
      if (!line.includes('callGatewayForText(')) return
      // The call's argument object, up to the closing brace of the call.
      const block = lines.slice(i, i + 25).join('\n')
      const parsed = /jsonObjectFromText|JSON\.parse|parseJson/.test(block)
        // ...or the result is fed to a parser on the following lines.
        || /jsonObjectFromText|JSON\.parse/.test(lines.slice(Math.max(0, i - 3), i + 30).join('\n'))
      if (parsed && !/maxTokens/.test(block)) {
        offenders.push(`${path.basename(file)}:${i + 1}`)
      }
    })
  }

  assert.deepEqual(offenders, [],
    `These calls parse their response but run on the default chat budget:\n`
    + offenders.map((o) => `  - ${o}`).join('\n')
    + `\n\nPass maxTokens: STRUCTURED_OUTPUT_MAX_TOKENS from gateway-errors.mjs. `
    + `max_tokens is shared with reasoning, so a chat-sized budget returns JSON truncated `
    + `mid-array while reporting stop_reason "end_turn".`)
})
