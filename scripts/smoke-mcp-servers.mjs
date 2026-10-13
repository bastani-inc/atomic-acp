// Real-Atomic smoke test for ACP mcpServers: opens a session with a stdio MCP server that exposes
// `echo_marker` and an HTTP MCP server, asks the model to call `echo_marker`, and checks that the
// server received the call. Env and header values, including `${...}` and `!command` text, must
// reach the servers unchanged, and no copy of the secret ones may remain on disk after exit
// (temp dir, Node's compile cache). Servers Atomic can't use safely are refused at session/new:
// a header value with a newline (Atomic's error would echo it) and a URL with an env reference
// (Atomic would fill in the host's variable).
// Needs `npm run build` and an Atomic provider login; skips when Atomic has no usable model.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = await mkdtemp(join(tmpdir(), 'atomic-acp-mcp-smoke-'))
// The adapter and Atomic use this as their temp dir, so Node's default compile cache lands here too.
const smokeTmp = await mkdtemp(join(tmpdir(), 'atomic-acp-mcp-smoke-tmp-'))
const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const fakeServer = fileURLToPath(new URL('./fixtures/echo-marker-mcp-server.mjs', import.meta.url))
const markerLog = join(workspace, 'echo-marker.jsonl')
const random = () => Math.random().toString(36).slice(2, 10)
const marker = `marker-${random()}`
const envSecret = `mcp-env-secret-${random()}`
const headerSecret = `mcp-header-secret-${random()}`
const literalEnv = {
  ECHO_MARKER_ENV_SECRET: envSecret,
  ECHO_MARKER_ENV_TEMPLATE: '${HOME} $PATH $$',
  ECHO_MARKER_ENV_COMMAND: '!echo smoke-command-ran'
}
const literalHeaders = { authorization: `Bearer ${headerSecret}`, 'x-literal': '!echo header-command-ran ${HOME}' }
const leakSecret = `mcp-leak-secret-${random()}`
const urlHostSecret = `mcp-url-host-secret-${random()}`
const httpUrls = []

const httpRequests = []
const httpServer = createServer((req, res) => {
  httpUrls.push(req.url)
  httpRequests.push({ authorization: req.headers.authorization, 'x-literal': req.headers['x-literal'] })
  let raw = ''
  req.on('data', chunk => (raw += chunk))
  req.on('end', () => {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      res.writeHead(405).end()
      return
    }
    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'header-probe', version: '1.0.0' }
          }
        : message.method === 'tools/list'
          ? { tools: [] }
          : {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
})
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
const httpUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`

const child = spawn(process.execPath, [entrypoint], {
  cwd: workspace,
  env: { ...process.env, TMPDIR: smokeTmp, TMP: smokeTmp, TEMP: smokeTmp, ACP_URL_SECRET: urlHostSecret },
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32'
})
const pending = new Map()
const toolCalls = []
let nextId = 0
let buffer = ''
let stderr = ''
let text = ''
let stdout = ''

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
    stdout += line + '\n'
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
  // Atomic writes Node's compile cache as it exits, so wait for the whole group before scanning.
  for (let i = 0; child.pid && process.platform !== 'win32' && i < 100; i += 1) {
    try {
      process.kill(-child.pid, 0)
    } catch {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

const timeout = setTimeout(() => failPending(new Error(`MCP smoke timed out after 180 seconds. ${stderr}`)), 180000)
let skipped = false
try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(init.agentCapabilities.mcpCapabilities.http, true)

  const refused = [
    {
      type: 'http',
      name: 'header-leak',
      url: httpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${leakSecret}\ninvalid` }]
    },
    { type: 'http', name: 'url-env', url: `${httpUrl}?token=\${ACP_URL_SECRET}`, headers: [] },
    { type: 'http', name: 'url-env-ps', url: `${httpUrl}?token=$env:ACP_URL_SECRET`, headers: [] }
  ]
  for (const server of refused) {
    await assert.rejects(request('session/new', { cwd: workspace, mcpServers: [server] }), error => {
      assert.equal(error.code, -32602, `session/new with ${server.name} must fail with invalidParams`)
      return true
    })
  }
  assert.ok(!stdout.includes(leakSecret), 'A refused header value must never reach the client')
  assert.ok(!stderr.includes(leakSecret), 'A refused header value must never reach stderr')
  assert.ok(!httpUrls.some(url => url.includes(urlHostSecret)), 'The host value of a URL variable reached the server')
  assert.deepEqual(httpUrls, [], 'Atomic must not contact a refused server')
  console.log('MCP smoke passed: a newline header and env-referencing URLs were refused at session/new')

  let session
  try {
    session = await request('session/new', {
      cwd: workspace,
      mcpServers: [
        {
          name: 'echo-marker',
          command: process.execPath,
          args: [fakeServer],
          env: [
            { name: 'ECHO_MARKER_LOG', value: markerLog },
            ...Object.entries(literalEnv).map(([name, value]) => ({ name, value }))
          ]
        },
        {
          type: 'http',
          name: 'header-probe',
          url: httpUrl,
          headers: Object.entries(literalHeaders).map(([name, value]) => ({ name, value }))
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
    const entries = readFileSync(markerLog, 'utf8').trim().split('\n').map(JSON.parse)
    const calls = entries.filter(entry => entry.tool)
    for (const { env } of entries.filter(entry => entry.env)) {
      assert.deepEqual(env, literalEnv, 'MCP env values must reach the server unchanged')
    }
    assert.ok(
      entries.some(entry => entry.env),
      'The stdio MCP server never logged its environment'
    )
    assert.ok(httpRequests.length > 0, 'Atomic never connected to the HTTP MCP server')
    for (const headers of httpRequests) {
      assert.deepEqual(headers, literalHeaders, 'MCP header values must reach the server unchanged')
    }
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
  httpServer.closeAllConnections()
  httpServer.close()
  await rm(workspace, { recursive: true, force: true })
}

function filesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath ?? entry.path, entry.name))
}

try {
  if (!skipped) {
    const leftover = readdirSync(smokeTmp).filter(name => name.startsWith('atomic-acp-ext-'))
    assert.deepEqual(leftover, [], 'The per-session MCP extension must be deleted when the adapter exits')

    const cacheDirs = [smokeTmp, join(tmpdir(), 'node-compile-cache'), process.env.NODE_COMPILE_CACHE].filter(Boolean)
    const secrets = [envSecret, headerSecret]
    const copies = cacheDirs.flatMap(filesUnder).filter(file => {
      const bytes = readFileSync(file)
      return secrets.some(secret => bytes.includes(secret) || bytes.includes(Buffer.from(secret, 'utf16le')))
    })
    assert.deepEqual(copies, [], `MCP secret values must not outlive the session on disk: ${copies.join(', ')}`)
    console.log(`MCP smoke passed: no copy of the env or header secret under ${cacheDirs.join(', ')}`)
  }
} finally {
  await rm(smokeTmp, { recursive: true, force: true })
}
