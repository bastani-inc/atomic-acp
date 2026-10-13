import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { AtomicRpcProcess, AtomicRpcSpawnError } from '../../src/atomic-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

const stdioServer: McpServer = { name: 'tools', command: 'node', args: ['server.mjs'], env: [] }
const killed = () => new Error('Atomic process exited (code=null, signal=SIGKILL)')
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-exit-agent-'))
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
  const procs: FakeAtomicRpcProcess[] = []
  const spawnFailures: Error[] = []
  t.mock.method(AtomicRpcProcess, 'spawn', async (options: Parameters<typeof AtomicRpcProcess.spawn>[0]) => {
    spawns.push(options)
    const failure = spawnFailures.shift()
    if (failure) throw failure
    const proc = Object.assign(new FakeAtomicRpcProcess(), {
      getState: async () => ({ sessionId: 'saved', sessionFile, thinkingLevel: 'off' }),
      getAvailableThinkingLevels: async () => ['off'],
      dispose() {}
    })
    procs.push(proc)
    return proc as unknown as AtomicRpcProcess
  })
  t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
  t.after(() => {
    agent.dispose()
    if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  const prompt = (text: string) => agent.prompt({ sessionId: 'saved', prompt: [{ type: 'text', text }] })
  return { root, agent, spawns, procs, spawnFailures, sessionFile, prompt }
}

function isInternalError(pattern: RegExp) {
  return (error: Error & { code?: number }) => {
    assert.equal(error.code, -32603)
    assert.match(error.message, pattern)
    return true
  }
}

test('session/prompt fails with a JSON-RPC error when Atomic exits during the prompt', async t => {
  const { root, agent, procs, prompt } = fixture(t)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  const turn = prompt('one')
  await tick()
  procs[0]!.exit(killed())
  await assert.rejects(turn, isInternalError(/exited.*SIGKILL/))
})

test('session/prompt fails with a JSON-RPC error when Atomic refuses the prompt', async t => {
  const { root, agent, procs, prompt } = fixture(t)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  procs[0]!.promptError = new Error('Atomic prompt failed: busy')
  await assert.rejects(prompt('one'), isInternalError(/busy/))
})

test('the next prompt restarts Atomic from the session file with the same MCP servers', { timeout: 5000 }, async t => {
  const { root, agent, spawns, procs, sessionFile, prompt } = fixture(t)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [stdioServer] })
  const first = prompt('one')
  await tick()
  procs[0]!.exit(killed())
  await assert.rejects(first)

  const second = prompt('two')
  while (procs.length < 2 || procs[1]!.prompts.length === 0) await tick()
  assert.equal(spawns[1]?.sessionPath, sessionFile, 'the conversation continues from the same session file')
  assert.deepEqual(spawns[1]?.mcpServers, spawns[0]?.mcpServers)
  assert.equal(spawns[1]?.headless, spawns[0]?.headless)
  assert.equal(procs[1]!.prompts[0]?.message, 'two')
  procs[1]!.emit({ type: 'agent_start' })
  procs[1]!.emit({ type: 'agent_end' })
  procs[1]!.emit({ type: 'agent_settled' })
  assert.deepEqual(await second, { stopReason: 'end_turn' })
})

test('a prompt whose Atomic restart fails returns a JSON-RPC error, not end_turn', { timeout: 5000 }, async t => {
  const { root, agent, procs, spawnFailures, prompt } = fixture(t)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  procs[0]!.exit(killed())
  spawnFailures.push(new AtomicRpcSpawnError('Could not start Atomic: executable not found', { code: 'ENOENT' }))
  await assert.rejects(prompt('two'), isInternalError(/Could not start Atomic/))
})
