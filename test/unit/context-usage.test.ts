import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { AtomicRpcProcess, SESSION_STATS_TIMEOUT_MS, type AtomicSessionStats } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

function fixture(stats: AtomicSessionStats) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const timeouts: Array<number | undefined> = []
  Object.assign(proc, {
    async getSessionStats(timeout?: number) {
      timeouts.push(timeout)
      return stats
    }
  })
  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as unknown as AtomicRpcProcess
  })
  return { session, conn, proc, timeouts }
}

test('context usage reports window occupancy, not cumulative token totals, before prompt completion', async () => {
  const { session, proc, conn, timeouts } = fixture({
    tokens: { total: 1000000 },
    contextUsage: { tokens: 42, contextWindow: 200000 }
  })
  const turn = session.prompt('hello')
  proc.emit({ type: 'agent_end' })
  let completed = false
  void turn.then(() => {
    completed = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  assert.deepEqual(timeouts, [])
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.ok(
    conn.updates.some(
      ({ update }) => update.sessionUpdate === 'usage_update' && update.used === 42 && update.size === 200000
    )
  )
  assert.deepEqual(timeouts, [SESSION_STATS_TIMEOUT_MS])
})

for (const contextUsage of [
  undefined,
  null,
  { tokens: null, contextWindow: 100 },
  { tokens: -1, contextWindow: 100 },
  { tokens: 1.5, contextWindow: 100 },
  { tokens: 1, contextWindow: 0 },
  { tokens: 1, contextWindow: Infinity }
]) {
  test(`context usage omits untrustworthy occupancy ${JSON.stringify(contextUsage)}`, async () => {
    const { session, conn } = fixture({ contextUsage })
    await session.publishContextUsage()
    assert.deepEqual(conn.updates, [])
  })
}

test('context usage preserves zero occupancy and over-window occupancy', async () => {
  for (const tokens of [0, 101]) {
    const { session, conn } = fixture({ contextUsage: { tokens, contextWindow: 100 } })
    await session.publishContextUsage()
    assert.deepEqual(conn.updates[0].update, { sessionUpdate: 'usage_update', used: tokens, size: 100 })
  }
})

test('stats failure still flushes assistant output and completes the turn', async () => {
  const { session, proc, conn } = fixture({})
  Object.assign(proc, {
    async getSessionStats() {
      throw new Error('stats unavailable')
    }
  })
  const turn = session.prompt('hello')
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.ok(conn.updates.some(({ update }) => update.sessionUpdate === 'agent_message_chunk'))
})
