import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransformStream } from 'node:stream/web'
import { AgentSideConnection, ClientSideConnection } from '@agentclientprotocol/sdk'

import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock AtomicRpcProcess.spawn so loadSession doesn't actually spawn `atomic`.
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

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

test('AtomicAcpAgent: listSessions lists Atomic sessions and loadSession replays history', async () => {
  // Create a fake ATOMIC_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        name: 'My Named Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new AtomicAcpAgent(asAgentConn(conn))

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return fake proc with getMessages
    const originalSpawn = AtomicRpcProcess.spawn

    ;(AtomicRpcProcess as any).spawn = async (params: any) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.endsWith('/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'))

      return {
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => ({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
          ]
        }),
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.text === 'Hello'))
      assert.ok(texts.some(t => t.kind === 'agent_message_chunk' && t.text === 'Hi there!'))
    } finally {
      AtomicRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})

test('AtomicAcpAgent: SDK dispatches session/list to stable listSessions after initialize', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--sdk-project--')
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    join(sessionsDir, '0000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-sdk-list',
        timestamp: '2026-02-12T00:00:00.000Z',
        cwd: '/tmp/sdk-project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'sdk-message-1',
        parentId: null,
        timestamp: '2026-02-12T00:00:01.000Z',
        message: { role: 'user', content: 'Hello through SDK' }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'sdk-info-1',
        parentId: 'sdk-message-1',
        timestamp: '2026-02-12T00:00:02.000Z',
        name: 'SDK Listed Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  const streams = createAcpMemoryStreams()

  try {
    const agentConn = new AgentSideConnection(conn => new AtomicAcpAgent(conn), streams.agentStream)
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

    const listed = await clientConn.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    const s = listed.sessions.find(x => x.sessionId === 'sess-sdk-list')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/sdk-project')
    assert.equal(s?.title, 'SDK Listed Session')
  } finally {
    await streams.close()
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})

test('AtomicAcpAgent: loadSession rejects stored session mappings from a different cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const sessionsDir = join(root, 'sessions')
  const sessionFile = join(sessionsDir, 'wrong-project.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-cross-cwd',
      timestamp: '2026-02-11T00:00:00.000Z',
      cwd: '/tmp/project-a'
    }) + '\n',
    'utf8'
  )

  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root

  const originalSpawn = AtomicRpcProcess.spawn
  ;(AtomicRpcProcess as any).spawn = async () => {
    throw new Error('spawn should not be called for a session in another cwd')
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new AtomicAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new SessionStore(join(root, 'session-map.json'))
    ;(agent as any).store.upsert({
      sessionId: 'sess-cross-cwd',
      cwd: '/tmp/project-a',
      sessionFile
    })

    await assert.rejects(
      () =>
        agent.loadSession({ sessionId: 'sess-cross-cwd', cwd: '/tmp/project-b', mcpServers: [], _meta: null } as any),
      (e: any) => String(e?.message ?? '').includes('Invalid params')
    )
  } finally {
    AtomicRpcProcess.spawn = originalSpawn
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})
