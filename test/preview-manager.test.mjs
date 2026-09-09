import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {
  isPortAvailable,
  allocatePreviewPort,
  releasePreviewPort,
  startPreviewServer,
  stopPreviewServer,
  getPreviewStatus,
  stopAllPreviewServers,
  waitForServerReady,
} from '../lib/orchestrator/preview-manager.mjs'

test('allocatePreviewPort and isPortAvailable manage pool ports cleanly', async () => {
  const port1 = await allocatePreviewPort()
  assert.ok(port1 >= 41000)

  const port2 = await allocatePreviewPort()
  assert.ok(port2 >= 41000)
  assert.notEqual(port1, port2)

  releasePreviewPort(port1)
  releasePreviewPort(port2)
})

test('startPreviewServer spawns dev server, waits for ready, and stops cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-prev-test-'))
  const port = await allocatePreviewPort()

  // Node script that acts as our test dev server
  const serverScript = `
    import http from 'node:http';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Preview Live!</h1>');
    });
    server.listen(${port}, '127.0.0.1', () => console.log('Ready on ${port}'));
  `
  fs.writeFileSync(path.join(tmpDir, 'server.mjs'), serverScript)

  // Start preview server
  const session = await startPreviewServer({
    taskId: 'task_prev_01',
    worktreePath: tmpDir,
    command: 'node',
    args: ['server.mjs'],
    port,
    timeoutMs: 5000,
  })

  assert.equal(session.taskId, 'task_prev_01')
  assert.equal(session.port, port)
  assert.equal(session.status, 'RUNNING')
  assert.ok(session.pid > 0)

  // Verify HTTP response from the preview server
  const responseText = await new Promise((resolve, reject) => {
    http.get(session.url, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })

  assert.match(responseText, /Preview Live!/)

  // Verify getPreviewStatus
  const status = getPreviewStatus('task_prev_01')
  assert.equal(status.status, 'RUNNING')
  assert.equal(status.port, port)

  // Stop preview server
  const stopResult = stopPreviewServer('task_prev_01')
  assert.equal(stopResult.stopped, true)
  assert.equal(stopResult.wasRunning, true)

  // Verify process terminated and port released
  await new Promise((r) => setTimeout(r, 200))
  const portIsFree = await isPortAvailable(port)
  assert.equal(portIsFree, true, 'Port must be freed after teardown')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
