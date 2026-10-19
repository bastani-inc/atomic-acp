import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn, listedSession } from '../helpers/fakes.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

/** A saved session as Atomic lists it for its project, mapped to that project by the adapter. */
function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-lifecycle-'))
  const listing = [listedSession('saved', root, { name: 'Saved title', firstMessage: 'Original prompt' })]
  const conn = new FakeAgentSideConnection()
  const agent = new AtomicAcpAgent(asAgentConn(conn))
  const store = new SessionStore(join(root, 'session-map.json'))
  store.upsert({ sessionId: 'saved', cwd: root })
  Object.defineProperty(agent, 'store', { value: store })
  t.after(() => {
    agent.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, listing, conn, agent, store }
}

/** Every Atomic started shares the saved `sessions` and has the session it was started on open. */
function mockAtomic(t: import('node:test').TestContext, sessions: Array<Record<string, unknown>>) {
  const started: FakeAtomicRpcProcess[] = []
  t.mock.method(AtomicRpcProcess, 'spawn', async (options: Parameters<typeof AtomicRpcProcess.spawn>[0]) => {
    const proc = Object.assign(new FakeAtomicRpcProcess(), {
      getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
      getAvailableThinkingLevels: async () => ['high']
    })
    proc.sessions = sessions
    proc.openSessionId = options.sessionId ?? `new-${started.length}`
    started.push(proc)
    return proc as unknown as AtomicRpcProcess
  })
  return started
}

const listedIds = (sessions: Array<Record<string, unknown>>) => sessions.map(session => session.id)

test('session deletion is advertised, removes the session from Atomic and the mapping, and is idempotent', async t => {
  const { root, listing, agent, store } = fixture(t)
  const started = mockAtomic(t, listing)
  const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} })
  assert.deepEqual(init.agentCapabilities?.sessionCapabilities?.delete, {})
  assert.deepEqual(await agent.unstable_deleteSession({ sessionId: 'saved' }), {})
  assert.deepEqual(listedIds(listing), [])
  assert.equal(store.get('saved'), null)
  assert.deepEqual((await agent.listSessions({ cwd: root })).sessions, [])
  assert.deepEqual(await agent.unstable_deleteSession({ sessionId: 'saved' }), {})
  assert.deepEqual(await agent.unstable_deleteSession({ sessionId: 'never-existed' }), {})
  assert.ok(started.length > 0)
  assert.ok(
    started.every(proc => proc.hasExited),
    'Atomic started only for deleting or listing exits'
  )
})

test('deleting an open session stops its Atomic and deletes it through another', async t => {
  const { root, listing, agent } = fixture(t)
  const started = mockAtomic(t, listing)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  const [own] = started
  await agent.unstable_deleteSession({ sessionId: 'saved' })
  assert.equal(own?.hasExited, true)
  assert.deepEqual(listedIds(listing), [])
})

test('deletion goes through a running Atomic of the same project instead of starting one', async t => {
  const { root, listing, agent } = fixture(t)
  listing.push(listedSession('other', root))
  const started = mockAtomic(t, listing)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  await agent.unstable_deleteSession({ sessionId: 'other' })
  assert.equal(started.length, 1)
  assert.equal(started[0]?.hasExited, false)
  assert.deepEqual(listedIds(listing), ['saved'])
})

test('prompt restores a saved session by ID once and republishes its saved title without changing activity', async t => {
  const { root, listing, conn, agent } = fixture(t)
  const calls: Parameters<typeof AtomicRpcProcess.spawn>[0][] = []
  const proc = new FakeAtomicRpcProcess()
  proc.sessions = listing
  t.mock.method(AtomicRpcProcess, 'spawn', async (options: Parameters<typeof AtomicRpcProcess.spawn>[0]) => {
    calls.push(options)
    return proc as unknown as AtomicRpcProcess
  })
  const first = agent.prompt({ sessionId: 'saved', prompt: [{ type: 'text', text: 'continue' }] })
  while (proc.prompts.length === 0) await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'agent_settled' })
  assert.equal((await first).stopReason, 'end_turn')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.cwd, root)
  assert.equal(calls[0]?.sessionId, 'saved')
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
  const { root, conn, agent } = fixture(t)
  let spawns = 0
  const modes: string[] = []
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
    getAvailableThinkingLevels: async () => ['low', 'high'],
    setThinkingLevel: async (mode: string) => {
      modes.push(mode)
    }
  })
  proc.sessions = [listedSession('saved', root, { hasName: true, firstMessage: 'Old prompt' })]
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

test('config setters restore a saved session and publish its applied configuration', async t => {
  const { agent, conn } = fixture(t)
  const state = { thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }
  let spawns = 0
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getState: async () => state,
    getAvailableThinkingLevels: async () => ['low', 'high'],
    setThinkingLevel: async (level: string) => {
      state.thinkingLevel = level
    },
    setModel: async (provider: string, id: string) => {
      state.model = { provider, id }
    }
  })
  t.mock.method(AtomicRpcProcess, 'spawn', async () => {
    spawns++
    return proc as unknown as AtomicRpcProcess
  })
  const thinking = await agent.setSessionConfigOption({ sessionId: 'saved', configId: 'thought_level', value: 'low' })
  assert.equal(thinking.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'low')
  const model = await agent.setSessionConfigOption({ sessionId: 'saved', configId: 'model', value: 'test/model' })
  assert.equal(model.configOptions.find(option => option.id === 'model')?.currentValue, 'test/model')
  assert.equal(spawns, 1)
  assert.equal(conn.updates.filter(({ update }) => update.sessionUpdate === 'config_option_update').length, 2)
})

test('load restores the original prompt title and replays history without renaming it', async t => {
  const { root, conn, agent } = fixture(t)
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
    getAvailableThinkingLevels: async () => ['low', 'high'],
    getMessages: async () => ({ messages: [{ role: 'user', content: 'Original prompt' }] })
  })
  proc.sessions = [listedSession('saved', root, { firstMessage: ' Original\n prompt ' })]
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

test('failed restore initialization disposes the child and permits a fresh restore', async t => {
  const { agent } = fixture(t)
  let disposals = 0
  let spawns = 0
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    dispose: () => {
      disposals++
    },
    getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
    getAvailableThinkingLevels: async () => ['high'],
    setThinkingLevel: async () => {}
  })
  t.mock.method(AtomicRpcProcess, 'spawn', async () => {
    spawns++
    return proc as unknown as AtomicRpcProcess
  })
  const events = t.mock.method(proc, 'onEvent', () => {
    throw new Error('process unavailable')
  })
  await assert.rejects(agent.setSessionMode({ sessionId: 'saved', modeId: 'high' }), /process unavailable/)
  assert.equal(disposals, 1)
  events.mock.restore()
  await agent.setSessionMode({ sessionId: 'saved', modeId: 'high' })
  assert.equal(spawns, 2)
})

test('load waits for an in-flight restore and reuses its live process', async t => {
  const { root, listing, agent, conn } = fixture(t)
  const titleStarted = deferred<void>()
  const titleReleased = deferred<void>()
  let spawns = 0
  let disposals = 0
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    dispose: () => {
      disposals++
    },
    getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
    getAvailableThinkingLevels: async () => ['high'],
    setThinkingLevel: async () => {}
  })
  proc.sessions = listing
  t.mock.method(AtomicRpcProcess, 'spawn', async () => {
    spawns++
    return proc as unknown as AtomicRpcProcess
  })
  const publish = conn.sessionUpdate.bind(conn)
  t.mock.method(conn, 'sessionUpdate', async (message: Parameters<typeof conn.sessionUpdate>[0]) => {
    if (message.update.sessionUpdate === 'session_info_update') {
      titleStarted.resolve()
      await titleReleased.promise
    }
    await publish(message)
  })
  const restore = agent.setSessionMode({ sessionId: 'saved', modeId: 'high' })
  await titleStarted.promise
  const load = agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  titleReleased.resolve()
  await Promise.all([restore, load])
  assert.equal(spawns, 1)
  assert.equal(disposals, 0)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  assert.equal(spawns, 1)
  assert.equal(disposals, 0)
})

test('delete waits for a blocked restore and prevents queued operations from resurrecting it', async t => {
  const { root, listing, agent, store } = fixture(t)
  const spawned = deferred<void>()
  const releaseSpawn = deferred<AtomicRpcProcess>()
  let disposals = 0
  let spawns = 0
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    dispose: () => {
      disposals++
    },
    getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
    getAvailableThinkingLevels: async () => ['high']
  })
  proc.sessions = listing
  proc.openSessionId = 'saved'
  const lister = new FakeAtomicRpcProcess()
  lister.sessions = listing
  t.mock.method(AtomicRpcProcess, 'spawn', async (options: Parameters<typeof AtomicRpcProcess.spawn>[0]) => {
    if (options.sessionId === undefined) return lister as unknown as AtomicRpcProcess
    spawns++
    spawned.resolve()
    return releaseSpawn.promise
  })
  const restoring = agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  await spawned.promise
  let deleted = false
  const deleting = agent.unstable_deleteSession({ sessionId: 'saved' }).then(() => {
    deleted = true
  })
  const laterLoad = agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  const rejected = assert.rejects(laterLoad, { code: -32602, data: 'Unknown sessionId: saved' })
  await new Promise(resolve => setImmediate(resolve))
  const deletedBeforeRestoreFinished = deleted
  releaseSpawn.resolve(proc as unknown as AtomicRpcProcess)
  await Promise.all([restoring, deleting, rejected])
  assert.equal(deletedBeforeRestoreFinished, false)
  assert.equal(disposals, 1)
  assert.equal(spawns, 1)
  assert.deepEqual(listedIds(listing), [])
  assert.equal(store.get('saved'), null)
  assert.deepEqual((await agent.listSessions({ cwd: root })).sessions, [])
})

test('restore operations wait for load history replay without replacing its process', async t => {
  const { root, agent, conn } = fixture(t)
  const historyStarted = deferred<void>()
  const historyReleased = deferred<void>()
  let spawns = 0
  let changes = 0
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
    getAvailableThinkingLevels: async () => ['high'],
    getMessages: async () => {
      historyStarted.resolve()
      await historyReleased.promise
      return { messages: [{ role: 'user', content: 'saved message' }] }
    },
    setThinkingLevel: async () => {
      changes++
    }
  })
  t.mock.method(AtomicRpcProcess, 'spawn', async () => {
    spawns++
    return proc as unknown as AtomicRpcProcess
  })
  const load = agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  await historyStarted.promise
  const config = agent.setSessionMode({ sessionId: 'saved', modeId: 'high' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(changes, 0)
  historyReleased.resolve()
  const [response] = await Promise.all([load, config])
  assert.equal(spawns, 1)
  assert.equal(changes, 1)
  assert.equal(response.modes?.currentModeId, 'high')
  assert.deepEqual(
    response.modes?.availableModes.map(mode => mode.id),
    ['high']
  )
  assert.ok(conn.updates.some(({ update }) => update.sessionUpdate === 'user_message_chunk'))
})

test('load rejects a different cwd without closing an already restored session', async t => {
  const { root, agent } = fixture(t)
  let disposals = 0
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    dispose: () => {
      disposals++
    },
    getState: async () => ({ thinkingLevel: 'high', model: { provider: 'test', id: 'model' } }),
    getAvailableThinkingLevels: async () => ['high']
  })
  t.mock.method(AtomicRpcProcess, 'spawn', async () => proc as unknown as AtomicRpcProcess)
  await agent.loadSession({ sessionId: 'saved', cwd: root, mcpServers: [] })
  await assert.rejects(agent.loadSession({ sessionId: 'saved', cwd: join(root, 'other'), mcpServers: [] }), {
    code: -32602
  })
  assert.equal(disposals, 0)
})
