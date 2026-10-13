import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function fixture() {
  const conn = new FakeAgentSideConnection()
  const state = { thinkingLevel: 'max', model: { provider: 'test', id: 'reasoning' } }
  const calls: string[] = []
  const proc = {
    getState: async () => state,
    getAvailableModels: async () => ({
      models: [
        { provider: 'test', id: 'reasoning' },
        { provider: 'test', id: 'plain' }
      ]
    }),
    getAvailableThinkingLevels: async () => (state.model.id === 'plain' ? ['off'] : ['low', 'high', 'max']),
    async setThinkingLevel(level: string) {
      calls.push(level)
      state.thinkingLevel = 'max'
    },
    async setModel(provider: string, id: string) {
      calls.push(id)
      state.model = { provider, id }
      state.thinkingLevel = id === 'plain' ? 'off' : 'max'
    }
  }
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    async publishContextUsage() {},
    setFileCommands() {},
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }
  const agent = new AtomicAcpAgent(asAgentConn(conn))
  Reflect.set(agent, 'sessions', {
    get: () => session,
    maybeGet: () => session,
    create: async () => session,
    close() {}
  })
  return { agent, conn, proc, state, calls }
}

test('new session advertises model and exact model-specific thinking selectors', async t => {
  const { agent } = fixture()
  t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] })
  assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/reasoning')
  assert.equal(result.modes.currentModeId, 'max')
  assert.deepEqual(
    result.modes.availableModes.map(mode => mode.id),
    ['low', 'high', 'max']
  )
  assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'max')
})

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy' : 'config'} thinking setter publishes applied rather than requested level`, async () => {
    const { agent, conn, calls } = fixture()
    if (legacy) await agent.setSessionMode({ sessionId: 's1', modeId: 'high' })
    else {
      const result = await agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' })
      assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'max')
    }
    assert.deepEqual(calls, ['high'])
    assert.deepEqual(conn.updates[0].update, { sessionUpdate: 'current_mode_update', currentModeId: 'max' })
    assert.equal(conn.updates[1].update.sessionUpdate, 'config_option_update')
  })

  test(`${legacy ? 'legacy' : 'config'} model setter refreshes model-specific thinking choices`, async () => {
    const { agent, conn } = fixture()
    if (legacy) await agent.unstable_setSessionModel({ sessionId: 's1', modelId: 'plain' })
    else await agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'test/plain' })
    assert.deepEqual(conn.updates[0].update, { sessionUpdate: 'current_mode_update', currentModeId: 'off' })
    const update = conn.updates[1].update
    assert.equal(update.sessionUpdate, 'config_option_update')
    if (update.sessionUpdate !== 'config_option_update') throw new Error('missing configuration')
    const option = update.configOptions.find(option => option.id === 'thought_level')
    assert.equal(option?.currentValue, 'off')
    assert.ok(option?.type === 'select')
    assert.deepEqual(option.options, [{ value: 'off', name: 'Thinking: off', description: null }])
  })
}

test('configuration rejects unknown ids, non-string values and empty levels without mutation', async () => {
  const { agent, calls } = fixture()
  for (const request of [
    { configId: 'unknown', value: 'high' },
    { configId: 'thought_level', value: '' }
  ]) {
    await assert.rejects(agent.setSessionConfigOption({ sessionId: 's1', ...request }), { code: -32602 })
  }
  await assert.rejects(
    agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', type: 'boolean', value: true }),
    { code: -32602 }
  )
  await assert.rejects(agent.setSessionMode({ sessionId: 's1', modeId: '' }), { code: -32602 })
  assert.deepEqual(calls, [])
})

for (const failure of ['state', 'discovery', 'inconsistent']) {
  test(`configuration ${failure} failure emits no success updates`, async () => {
    const { agent, proc, state, conn } = fixture()
    if (failure === 'state')
      proc.getState = async () => {
        throw new Error('unavailable')
      }
    if (failure === 'discovery')
      proc.getAvailableThinkingLevels = async () => {
        throw new Error('unavailable')
      }
    if (failure === 'inconsistent')
      proc.setThinkingLevel = async () => {
        state.thinkingLevel = 'missing'
      }
    await assert.rejects(agent.setSessionMode({ sessionId: 's1', modeId: 'high' }))
    assert.deepEqual(conn.updates, [])
  })
}

for (const failure of ['state', 'discovery', 'inconsistent']) {
  test(`load ${failure} failure disposes the child without replaying or deleting history`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'atomic-acp-thinking-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
    const sessionFile = join(root, 'history.jsonl')
    writeFileSync(sessionFile, 'saved history\n')
    const store = new SessionStore(join(root, 'map.json'))
    store.upsert({ sessionId: 's1', cwd: root, sessionFile })
    const { agent, conn, proc, state } = fixture()
    const sessions = new SessionManager()
    Reflect.set(agent, 'sessions', sessions)
    Reflect.set(agent, 'store', store)
    t.after(() => sessions.disposeAll())
    let disposed = 0
    let historyReads = 0
    let fail = true
    t.mock.method(
      AtomicRpcProcess,
      'spawn',
      async () =>
        ({
          ...proc,
          onEvent: () => () => {},
          dispose() {
            disposed++
          },
          async getState() {
            if (fail && failure === 'state') throw new Error('state unavailable')
            return fail && failure === 'inconsistent' ? { ...state, thinkingLevel: 'missing' } : state
          },
          async getAvailableThinkingLevels() {
            if (fail && failure === 'discovery') throw new Error('discovery unavailable')
            return proc.getAvailableThinkingLevels()
          },
          async getMessages() {
            historyReads++
            return { messages: [{ role: 'user', content: 'saved prompt' }] }
          }
        }) as unknown as AtomicRpcProcess
    )
    await assert.rejects(agent.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] }))
    assert.equal(disposed, 1)
    assert.equal(historyReads, 0)
    assert.equal(sessions.maybeGet('s1'), undefined)
    assert.deepEqual(conn.updates, [])
    assert.equal(readFileSync(sessionFile, 'utf8'), 'saved history\n')
    assert.equal(store.get('s1')?.sessionFile, sessionFile)
    fail = false
    const result = await agent.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] })
    assert.equal(result.modes?.currentModeId, 'max')
    assert.equal(historyReads, 1)
    assert.equal(disposed, 1)
  })
}

test('new session configuration failure closes and removes the failed mapping', async t => {
  const { agent, proc } = fixture()
  t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
  proc.getAvailableThinkingLevels = async () => {
    throw new Error('discovery failed')
  }
  const closed: string[] = []
  const deleted: string[] = []
  Reflect.set(agent, 'sessions', {
    create: async () => ({ sessionId: 's1', proc }),
    close: (id: string) => closed.push(id)
  })
  Reflect.set(agent, 'store', { get: () => undefined, delete: (id: string) => deleted.push(id) })
  await assert.rejects(agent.newSession({ cwd: process.cwd(), mcpServers: [] }), /discovery failed/)
  assert.deepEqual(closed, ['s1'])
  assert.deepEqual(deleted, ['s1'])
})
