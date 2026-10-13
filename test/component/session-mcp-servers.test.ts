import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

const stdioServer: McpServer = {
  name: 'run tools',
  command: '/usr/bin/node',
  args: ['server.mjs'],
  env: [{ name: 'RUN_TOKEN', value: 'secret' }]
}

const expectedAtomicServers = {
  run_tools: { command: '/usr/bin/node', args: ['server.mjs'], env: { RUN_TOKEN: 'secret' }, exposure: 'direct' }
}

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-mcp-session-'))
  const previous = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  mkdirSync(join(root, 'sessions'))
  const sessionFile = join(root, 'sessions', 'saved.jsonl')
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'saved', cwd: root }) + '\n')
  const agent = new AtomicAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const store = new SessionStore(join(root, 'session-map.json'))
  store.upsert({ sessionId: 'saved', cwd: root, sessionFile })
  Object.defineProperty(agent, 'store', { value: store })

  const spawns: Parameters<typeof AtomicRpcProcess.spawn>[0][] = []
  t.mock.method(AtomicRpcProcess, 'spawn', async (options: Parameters<typeof AtomicRpcProcess.spawn>[0]) => {
    spawns.push(options)
    return Object.assign(new FakeAtomicRpcProcess(), {
      getState: async () => ({ sessionId: 'saved', sessionFile, thinkingLevel: 'off' }),
      getAvailableThinkingLevels: async () => ['off'],
      dispose() {}
    }) as unknown as AtomicRpcProcess
  })
  t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
  t.after(() => {
    agent.dispose()
    if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  return { root, agent, spawns }
}

test('initialize advertises HTTP MCP servers and no SSE', async t => {
  const { agent } = fixture(t)
  const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })
  assert.deepEqual(init.agentCapabilities?.mcpCapabilities, { http: true, sse: false })
})

test('session/new gives the client MCP servers to its Atomic process', async t => {
  const { root, agent, spawns } = fixture(t)
  await agent.newSession({ cwd: root, mcpServers: [stdioServer] })
  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0]?.mcpServers, expectedAtomicServers)
})

test('session/load gives the client MCP servers to the restored Atomic process', async t => {
  const { root, agent, spawns } = fixture(t)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [stdioServer] })
  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0]?.mcpServers, expectedAtomicServers)
})

test('session/load restarts a running session whose MCP servers changed and reuses it otherwise', async t => {
  const { root, agent, spawns } = fixture(t)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  assert.equal(spawns.length, 1)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [stdioServer] })
  assert.equal(spawns.length, 2)
  assert.deepEqual(spawns[1]?.mcpServers, expectedAtomicServers)
})
