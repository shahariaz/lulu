import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  detectContainerEngine,
  buildContainerArgs,
  executeContainerCommand,
  ContainerExecutionError,
} from '../lib/orchestrator/container-runner.mjs'

test('detectContainerEngine returns system container availability status', () => {
  const info = detectContainerEngine()
  assert.ok(typeof info.engine === 'string')
  assert.ok(typeof info.available === 'boolean')
  if (info.available) {
    assert.ok(['docker', 'podman', 'sandbox-exec'].includes(info.engine))
  }
})

test('buildContainerArgs constructs compliant container sandbox arguments', () => {
  const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-cntr-test-'))

  const args = buildContainerArgs({
    engine: 'docker',
    image: 'node:22-alpine',
    worktreePath: tmpWorktree,
    containerWorkdir: '/workspace',
    command: 'npm',
    args: ['test', '--', '--coverage'],
    networkMode: 'none',
    memoryLimit: '2g',
    cpuLimit: '2.0',
    pidsLimit: 100,
    user: '1000:1000',
    env: { TEST_VAR: 'hello' },
  })

  // Basic flags
  assert.equal(args[0], 'run')
  assert.equal(args[1], '--rm')

  // Mount check
  const vIdx = args.indexOf('-v')
  assert.ok(vIdx > 0)
  assert.match(args[vIdx + 1], new RegExp(`:${'/workspace'}:rw$`))

  // Resource limits check
  const memIdx = args.indexOf('--memory')
  assert.equal(args[memIdx + 1], '2g')

  const cpuIdx = args.indexOf('--cpus')
  assert.equal(args[cpuIdx + 1], '2.0')

  // Security checks
  assert.ok(args.includes('--security-opt'))
  assert.ok(args.includes('no-new-privileges'))

  const netIdx = args.indexOf('--network')
  assert.equal(args[netIdx + 1], 'none')

  // Environment checks
  assert.ok(args.includes('TEST_VAR=hello'))
  assert.ok(args.includes('CI=true'))

  // Image and command at end
  assert.equal(args[args.length - 5], 'node:22-alpine')
  assert.equal(args[args.length - 4], 'npm')
  assert.equal(args[args.length - 3], 'test')
  assert.equal(args[args.length - 2], '--')
  assert.equal(args[args.length - 1], '--coverage')

  fs.rmSync(tmpWorktree, { recursive: true, force: true })
})

test('executeContainerCommand runs via mockRunner and validates isolation', async () => {
  const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-cntr-exec-'))

  const result = await executeContainerCommand({
    worktreePath: tmpWorktree,
    command: 'npm',
    args: ['test'],
    mockRunner: async ({ image, command, networkMode }) => {
      assert.equal(image, 'node:22-slim')
      assert.equal(command, 'npm')
      assert.equal(networkMode, 'none')
      return {
        success: true,
        engine: 'mock-docker',
        image,
        exitCode: 0,
        stdout: 'Container test passed cleanly',
        stderr: '',
      }
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /Container test passed cleanly/)

  // If engine is 'none', calling without mockRunner must throw
  await assert.rejects(async () => {
    await executeContainerCommand({
      engine: 'none',
      worktreePath: tmpWorktree,
      command: 'npm test',
    })
  }, /no supported container engine/)

  fs.rmSync(tmpWorktree, { recursive: true, force: true })
})
