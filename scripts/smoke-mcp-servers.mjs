// Real-Atomic smoke test for ACP mcpServers: opens a session with a stdio MCP server that exposes
// `echo_marker`, asks the model to call it, and checks that the server received the call.
// Needs `npm run build` and an Atomic provider login; skips when Atomic has no usable model.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = await mkdtemp(join(tmpdir(), 'atomic-acp-mcp-smoke-'))
const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const fakeServer = fileURLToPath(new URL('./fixtures/echo-marker-mcp-server.mjs', import.meta.url))
const markerLog = join(workspace, 'echo-marker.jsonl')
const marker = `marker-${Math.random().toString(36).slice(2, 10)}`
const extensionDirs = () => new Set(readdirSync(tmpdir()).filter(name => name.startsWith('atomic-acp-ext-')))
const dirsBefore = extensionDirs()

const child = spawn(process.execPath, [entrypoint], {
  cwd: workspace,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32'
})
const pending = new Map()
const toolCalls = []
let nextId = 0
let buffer = ''
let stderr = ''
let text = ''

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
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request.reject(Object.assign(new Error(JSON.stringify(message.error)), message.error))
      else request.resolve(message.result)
      continue
    }
    const update = message.method === 'session/update' ? message.params?.update : undefined
    if (update?.sessionUpdate === 'tool_call') toolCalls.push(update.title ?? '')
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text
  }
})

function request(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function shutdown() {
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit')
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGTERM')
    }
  } else {
    child.kill('SIGTERM')
  }
  await exited
}

const timeout = setTimeout(() => failPending(new Error(`MCP smoke timed out after 180 seconds. ${stderr}`)), 180000)
let skipped = false
try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(init.agentCapabilities.mcpCapabilities.http, true)

  let session
  try {
    session = await request('session/new', {
      cwd: workspace,
      mcpServers: [
        {
          name: 'echo-marker',
          command: process.execPath,
          args: [fakeServer],
          env: [{ name: 'ECHO_MARKER_LOG', value: markerLog }]
        }
      ]
    })
  } catch (error) {
    if (error.code !== -32000) throw error
    skipped = true
    console.log('MCP smoke skipped: Atomic has no provider login. Run `atomic` and sign in, then retry.')
  }

  if (session) {
    if (process.env.ATOMIC_ACP_SMOKE_MODEL) {
      await request('session/set_model', { sessionId: session.sessionId, modelId: process.env.ATOMIC_ACP_SMOKE_MODEL })
    }
    const result = await request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [
        {
          type: 'text',
          text: `Call the echo_marker MCP tool with marker "${marker}", then reply with exactly what it returned.`
        }
      ]
    })
    assert.equal(result.stopReason, 'end_turn')
    assert.ok(existsSync(markerLog), `The MCP server was never called. Tool calls: ${JSON.stringify(toolCalls)}`)
    const calls = readFileSync(markerLog, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(
      calls.some(call => call.tool === 'echo_marker' && call.marker === marker),
      `Expected an echo_marker call with ${marker}, got ${JSON.stringify(calls)}`
    )
    assert.match(text, new RegExp(marker), 'Expected the reply to include the tool result')
    console.log(`MCP smoke passed: echo_marker received ${marker}; tool calls: ${toolCalls.join(', ')}`)
  }
} finally {
  clearTimeout(timeout)
  await shutdown()
  await rm(workspace, { recursive: true, force: true })
}

if (!skipped) {
  const leftover = [...extensionDirs()].filter(name => !dirsBefore.has(name))
  assert.deepEqual(leftover, [], 'The per-session MCP extension must be deleted when the adapter exits')
}
