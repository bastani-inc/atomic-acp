import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransformStream } from 'node:stream/web'
import { AgentSideConnection, ClientSideConnection } from '@agentclientprotocol/sdk'

import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn, listedSession } from '../helpers/fakes.js'

type SpawnParams = Parameters<typeof AtomicRpcProcess.spawn>[0]

function createAcpMemoryStreams() {
  const clientToAgent = new TransformStream<any, any>()
  const agentToClient = new TransformStream<any, any>()

  return {
    agentStream: {
      readable: clientToAgent.readable,
      writable: agentToClient.writable
    },
    clientStream: {
      readable: agentToClient.readable,
      writable: clientToAgent.writable
    },
    async close() {
      await Promise.allSettled([clientToAgent.writable.close(), agentToClient.writable.close()])
    }
  }
}

/** An Atomic process resumed on a saved session. */
function restorable(): FakeAtomicRpcProcess {
  return Object.assign(new FakeAtomicRpcProcess(), {
    getState: async () => ({ thinkingLevel: 'medium' }),
    getAvailableThinkingLevels: async () => ['medium']
  })
}

/** Atomic as the adapter starts it: a listing process without a session, a restored one with `--session`. */
function fakeAtomic(t: import('node:test').TestContext, restored: FakeAtomicRpcProcess = restorable()) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-list-'))
  const store = new SessionStore(join(root, 'session-map.json'))
  const lister = new FakeAtomicRpcProcess()
  const spawns: SpawnParams[] = []
  t.mock.method(AtomicRpcProcess, 'spawn', async (params: SpawnParams) => {
    spawns.push(params)
    return (params.sessionId === undefined ? lister : restored) as unknown as AtomicRpcProcess
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, store, lister, restored, spawns }
}

function newAgent(store: SessionStore, conn = new FakeAgentSideConnection()) {
  const agent = new AtomicAcpAgent(asAgentConn(conn))
  Object.defineProperty(agent, 'store', { value: store })
  return { agent, conn }
}

test('session/list shows the sessions Atomic lists for the project, newest first', async t => {
  const { store, lister, spawns } = fakeAtomic(t)
  lister.sessions = [
    listedSession('older', '/tmp/project', { modified: '2026-10-01T00:00:00.000Z', firstMessage: 'Fix  the\nbuild' }),
    listedSession('named', '/tmp/project', { modified: '2026-10-02T00:00:00.000Z', name: 'My Named Session' }),
    listedSession('cleared', '/tmp/project', { modified: '2026-09-01T00:00:00.000Z', hasName: true })
  ]
  const { agent } = newAgent(store)

  const listed = await agent.listSessions({ cwd: '/tmp/project' })

  assert.deepEqual(listed.sessions, [
    { sessionId: 'named', cwd: '/tmp/project', title: 'My Named Session', updatedAt: '2026-10-02T00:00:00.000Z' },
    { sessionId: 'older', cwd: '/tmp/project', title: 'Fix the build', updatedAt: '2026-10-01T00:00:00.000Z' },
    { sessionId: 'cleared', cwd: '/tmp/project', title: '', updatedAt: '2026-09-01T00:00:00.000Z' }
  ])
  assert.deepEqual(
    spawns.map(params => ({ cwd: params.cwd, sessionId: params.sessionId })),
    [{ cwd: '/tmp/project', sessionId: undefined }]
  )
  assert.equal(lister.disposeCount, 1, 'the listing process is stopped')
})

test('session/list leaves out sessions with no messages, name or summary', async t => {
  const { store, lister } = fakeAtomic(t)
  lister.sessions = [
    listedSession('kept', '/tmp/project'),
    listedSession('empty', '/tmp/project', { messageCount: 0, firstMessage: '(no messages)' }),
    listedSession('summarized', '/tmp/project', { messageCount: 0, summary: 'Earlier work' })
  ]
  const { agent } = newAgent(store)

  const listed = await agent.listSessions({ cwd: '/tmp/project' })

  assert.deepEqual(
    listed.sessions.map(s => [s.sessionId, s.title]),
    [
      ['kept', 'Hello'],
      ['summarized', null]
    ]
  )
})

test('session/list asks the running Atomic of that project instead of starting another', async t => {
  const live = restorable()
  live.sessions = [listedSession('live', '/tmp/project')]
  const { store, spawns } = fakeAtomic(t, live)
  store.upsert({ sessionId: 'live', cwd: '/tmp/project' })
  const { agent } = newAgent(store)
  await agent.loadSession({ sessionId: 'live', cwd: '/tmp/project', mcpServers: [] })
  spawns.length = 0

  const listed = await agent.listSessions({ cwd: '/tmp/project' })

  assert.deepEqual(
    listed.sessions.map(s => s.sessionId),
    ['live']
  )
  assert.equal(spawns.length, 0)
  assert.equal(live.disposeCount, 0)
})

test('session/load restores a listed session by ID and replays its history', async t => {
  const restored = Object.assign(restorable(), {
    getMessages: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      ]
    })
  })
  const { store, lister, spawns } = fakeAtomic(t, restored)
  lister.sessions = [listedSession('sess-1', '/tmp/project', { name: 'My Named Session' })]
  restored.sessions = lister.sessions
  const { agent, conn } = newAgent(store)
  await agent.listSessions({ cwd: '/tmp/project' })

  await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [] })

  assert.deepEqual(
    spawns.map(params => ({ cwd: params.cwd, sessionId: params.sessionId })),
    [
      { cwd: '/tmp/project', sessionId: undefined },
      { cwd: '/tmp/project', sessionId: 'sess-1' }
    ]
  )
  const updates = conn.updates.map(u => u.update as { sessionUpdate: string; content?: { text?: string } })
  assert.ok(updates.some(u => u.sessionUpdate === 'user_message_chunk' && u.content?.text === 'Hello'))
  assert.ok(updates.some(u => u.sessionUpdate === 'agent_message_chunk' && u.content?.text === 'Hi there!'))
  assert.ok(
    conn.updates.some(
      ({ update }) => update.sessionUpdate === 'session_info_update' && update.title === 'My Named Session'
    )
  )
})

test('session/load finds a session the client did not list first', async t => {
  const { store, lister, spawns } = fakeAtomic(t)
  lister.sessions = [listedSession('cli-session', '/tmp/project')]
  const { agent } = newAgent(store)

  await agent.loadSession({ sessionId: 'cli-session', cwd: '/tmp/project', mcpServers: [] })

  assert.deepEqual(
    spawns.map(params => params.sessionId),
    [undefined, 'cli-session']
  )
  assert.equal(store.get('cli-session')?.cwd, '/tmp/project')
})

test('session/load rejects a session that belongs to another project without resuming it', async t => {
  const { store, spawns } = fakeAtomic(t)
  store.upsert({ sessionId: 'sess-cross-cwd', cwd: '/tmp/project-a' })
  const { agent } = newAgent(store)

  await assert.rejects(agent.loadSession({ sessionId: 'sess-cross-cwd', cwd: '/tmp/project-b', mcpServers: [] }), {
    code: -32602
  })
  assert.deepEqual(
    spawns.map(params => params.sessionId),
    [undefined],
    'only the listing for /tmp/project-b runs'
  )
})

test('AtomicAcpAgent: SDK dispatches session/list to stable listSessions after initialize', async t => {
  const { store, lister } = fakeAtomic(t)
  lister.sessions = [listedSession('sess-sdk-list', '/tmp/sdk-project', { name: 'SDK Listed Session' })]
  const streams = createAcpMemoryStreams()

  try {
    const agentConn = new AgentSideConnection(conn => {
      const agent = new AtomicAcpAgent(conn)
      Object.defineProperty(agent, 'store', { value: store })
      return agent
    }, streams.agentStream)
    void agentConn

    const clientConn = new ClientSideConnection(
      () =>
        ({
          requestPermission: async () => {
            throw new Error('requestPermission should not be called by session/list')
          },
          sessionUpdate: async () => {
            // no-op
          }
        }) as any,
      streams.clientStream
    )

    const initialized = await clientConn.initialize({ protocolVersion: 1 } as any)
    assert.deepEqual((initialized as any).agentCapabilities?.sessionCapabilities?.list, {})

    const listed = await clientConn.listSessions({ cwd: '/tmp/sdk-project' })
    const s = listed.sessions.find(x => x.sessionId === 'sess-sdk-list')
    assert.equal(s?.cwd, '/tmp/sdk-project')
    assert.equal(s?.title, 'SDK Listed Session')
  } finally {
    await streams.close()
  }
})

test('AtomicAcpAgent: SDK dispatches session/delete, which removes the session from Atomic', async t => {
  const { store, lister } = fakeAtomic(t)
  lister.sessions = [listedSession('sess-sdk-delete', '/tmp/sdk-project')]
  store.upsert({ sessionId: 'sess-sdk-delete', cwd: '/tmp/sdk-project' })
  const streams = createAcpMemoryStreams()

  try {
    const agentConn = new AgentSideConnection(conn => {
      const agent = new AtomicAcpAgent(conn)
      Object.defineProperty(agent, 'store', { value: store })
      return agent
    }, streams.agentStream)
    void agentConn
    const clientConn = new ClientSideConnection(
      () => ({ requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate: async () => {} }),
      streams.clientStream
    )

    const initialized = await clientConn.initialize({ protocolVersion: 1 })
    assert.deepEqual(initialized.agentCapabilities?.sessionCapabilities?.delete, {})

    assert.deepEqual(await clientConn.deleteSession({ sessionId: 'sess-sdk-delete' }), {})
    assert.deepEqual(lister.sessions, [])
    assert.equal(store.get('sess-sdk-delete'), null)
  } finally {
    await streams.close()
  }
})
