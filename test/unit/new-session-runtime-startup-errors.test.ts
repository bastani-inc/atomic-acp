import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  closeCalls: string[] = []

  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }
}

test('AtomicAcpAgent: newSession returns AUTH_REQUIRED when Atomic reports an auth error after spawn', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-runtime-auth-'))
  const sessionMapPath = join(root, 'session-map.json')

  const session = {
    sessionId: 's-auth',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        throw new Error('Authentication required: missing key')
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null, sessionId: 's-auth' }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const store = new SessionStore(sessionMapPath)
  store.upsert({ sessionId: 's-auth', cwd: process.cwd() })
  const agent = new AtomicAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = sessions as any
  ;(agent as any).store = store as any

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => e?.code === -32000
  )

  assert.deepEqual(sessions.closeCalls, ['s-auth'])
  assert.equal(store.get('s-auth'), null)
})

test('AtomicAcpAgent: newSession returns Internal error on non-auth model probe failures after spawn', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's-internal',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        throw new Error('socket hang up')
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const agent = new AtomicAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = sessions as any

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => e?.code === -32603 && String(e?.message ?? '').includes('socket hang up')
  )

  assert.deepEqual(sessions.closeCalls, ['s-internal'])
})
