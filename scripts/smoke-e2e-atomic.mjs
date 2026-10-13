import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = await mkdtemp(join(tmpdir(), 'atomic-acp-e2e-'))
const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const child = spawn(process.execPath, [entrypoint], {
  cwd: workspace,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32'
})
const pending = new Map()
let nextId = 0
let buffer = ''
let stderr = ''
let activeSessionId
let collecting = false
let text = ''
let chunkCount = 0

function failPending(error) {
  for (const { reject } of pending.values()) reject(error)
  pending.clear()
}

child.on('error', failPending)
child.on('exit', (code, signal) => {
  failPending(new Error(`Adapter exited before response (code=${code}, signal=${signal}). ${stderr}`))
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => {
  stderr = (stderr + chunk).slice(-8000)
})
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      failPending(new Error('Adapter wrote non-JSON output to ACP stdout'))
      continue
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id)
      if (!request) continue
      pending.delete(message.id)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    } else if (
      collecting &&
      message.method === 'session/update' &&
      message.params?.sessionId === activeSessionId &&
      message.params.update?.sessionUpdate === 'agent_message_chunk' &&
      message.params.update.content?.type === 'text'
    ) {
      chunkCount++
      text += message.params.update.content.text
    }
  }
})

function request(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
      if (!error) return
      pending.delete(id)
      reject(error)
    })
  })
}

const timeout = setTimeout(() => failPending(new Error(`Atomic E2E timed out after 180 seconds. ${stderr}`)), 180000)
try {
  const initialized = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'atomic-acp-e2e', version: '1.0.0' }
  })
  assert.equal(initialized.protocolVersion, 1)
  const session = await request('session/new', { cwd: workspace, mcpServers: [] })
  assert.equal(typeof session.sessionId, 'string')
  activeSessionId = session.sessionId
  await request('session/set_model', { sessionId: activeSessionId, modelId: 'openai/gpt-6-luna-fast' })
  collecting = true
  const result = await request('session/prompt', {
    sessionId: activeSessionId,
    prompt: [{ type: 'text', text: 'Reply with only the word ok. Do not use tools.' }]
  })
  assert.equal(result.stopReason, 'end_turn')
  assert.ok(chunkCount > 0, 'Expected an agent_message_chunk during the prompt')
  assert.match(text, /\bok\b/i, 'Expected the requested model reply')
  console.log(`Atomic E2E passed: openai/gpt-6-luna-fast, ${chunkCount} text chunks, stopReason=${result.stopReason}`)
} finally {
  clearTimeout(timeout)
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit')
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') {
        console.error('Failed to terminate the smoke-test process group:', error)
        child.kill('SIGTERM')
        process.exitCode = 1
      }
    }
  } else {
    child.kill('SIGTERM')
  }
  await exited
  await rm(workspace, { recursive: true, force: true })
}
