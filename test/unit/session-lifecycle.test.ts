import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-lifecycle-'))
  const previous = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  const dir = join(root, 'sessions')
  mkdirSync(dir)
  const path = join(dir, 'saved.jsonl')
  writeFileSync(
    path,
    [
      { type: 'session', id: 'saved', cwd: root, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'message', message: { role: 'user', content: 'Original prompt' } },
      { type: 'session_info', name: 'Saved title' }
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n') + '\n'
  )
  const conn = new FakeAgentSideConnection()
  const agent = new AtomicAcpAgent(asAgentConn(conn))
  const store = new SessionStore(join(root, 'session-map.json'))
  Object.defineProperty(agent, 'store', { value: store })
  t.after(() => {
    agent.dispose()
    if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  return { root, path, conn, agent, store }
}

test('session deletion is advertised, removes history and mappings, and is idempotent', async t => {
  const { root, path, agent, store } = fixture(t)
  store.upsert({ sessionId: 'saved', cwd: root, sessionFile: path })
  const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })
  assert.deepEqual(init.agentCapabilities?.sessionCapabilities?.delete, {})
  assert.deepEqual(await agent.deleteSession({ sessionId: 'saved' }), {})
  assert.equal(existsSync(path), false)
  assert.equal(store.get('saved'), null)
  assert.deepEqual((await agent.listSessions({})).sessions, [])
  assert.deepEqual(await agent.deleteSession({ sessionId: 'saved' }), {})
  assert.deepEqual(await agent.deleteSession({ sessionId: 'never-existed' }), {})
})

test('prompt restores a discovered session once and republishes its saved title without changing activity', async t => {
  const { root, path, conn, agent } = fixture(t)
  const calls: Parameters<typeof AtomicRpcProcess.spawn>[0][] = []
  const proc = new FakeAtomicRpcProcess()
  const original = AtomicRpcProcess.spawn
  AtomicRpcProcess.spawn = async options => {
    calls.push(options)
    return proc as unknown as AtomicRpcProcess
  }
  t.after(() => {
    AtomicRpcProcess.spawn = original
  })
  const first = agent.prompt({ sessionId: 'saved', prompt: [{ type: 'text', text: 'continue' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(proc.prompts.length, 1)
  proc.emit({ type: 'agent_settled' })
  assert.equal((await first).stopReason, 'end_turn')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.cwd, root)
  assert.equal(calls[0]?.sessionPath, path)
  const titleUpdate = conn.updates.find(
    ({ update }) => update.sessionUpdate === 'session_info_update' && update.title === 'Saved title'
  )
  assert.ok(titleUpdate)
  assert.equal('updatedAt' in titleUpdate.update, false)
})

test('cancelling a stale session is a no-op without starting Atomic', async t => {
  const { agent } = fixture(t)
  await agent.cancel({ sessionId: 'unknown' })
})

test('concurrent operations restore one stored session and preserve a cleared title', async t => {
  const { root, path, conn, agent, store } = fixture(t)
  writeFileSync(
    path,
    [
      { type: 'session', id: 'saved', cwd: root },
      { type: 'message', message: { role: 'user', content: 'Old prompt' } },
      { type: 'session_info', name: '' }
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
  )
  store.upsert({ sessionId: 'saved', cwd: root, sessionFile: path })
  let spawns = 0
  const modes: string[] = []
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    setThinkingLevel: async (mode: string) => {
      modes.push(mode)
    }
  })
  t.mock.method(AtomicRpcProcess, 'spawn', async () => {
    spawns++
    return proc as unknown as AtomicRpcProcess
  })
  await Promise.all([
    agent.setSessionMode({ sessionId: 'saved', modeId: 'low' }),
    agent.setSessionMode({ sessionId: 'saved', modeId: 'high' })
  ])
  assert.equal(spawns, 1)
  assert.deepEqual(modes, ['low', 'high'])
  assert.ok(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'session_info_update' && update.title === null && !('updatedAt' in update)
    )
  )
})

test('load restores the original prompt title and replays history without renaming it', async t => {
  const { root, path, conn, agent, store } = fixture(t)
  writeFileSync(
    path,
    [
      { type: 'session', id: 'saved', cwd: root },
      { type: 'message', message: { role: 'user', content: ' Original\n prompt ' } }
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
  )
  store.upsert({ sessionId: 'saved', cwd: root, sessionFile: path })
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getMessages: async () => ({ messages: [{ role: 'user', content: 'Original prompt' }] })
  })
  t.mock.method(AtomicRpcProcess, 'spawn', async () => proc as unknown as AtomicRpcProcess)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  assert.ok(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'session_info_update' && update.title === 'Original prompt' && !('updatedAt' in update)
    )
  )
  assert.ok(conn.updates.some(({ update }) => update.sessionUpdate === 'user_message_chunk'))
})

test('deletion discovers files without a mapping and tolerates already missing files', async t => {
  const { root, path, agent, store } = fixture(t)
  await agent.deleteSession({ sessionId: 'saved' })
  assert.equal(existsSync(path), false)
  store.upsert({ sessionId: 'missing', cwd: root, sessionFile: path })
  await agent.deleteSession({ sessionId: 'missing' })
  assert.equal(store.get('missing'), null)
})
