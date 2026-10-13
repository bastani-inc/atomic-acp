import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession } from '../../src/acp/session.js'
import type { AtomicRpcProcess, AtomicSessionStats } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('AtomicAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  // first started, second+third queued
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)

  // queued prompts should resolve as cancelled
  assert.equal(await second, 'cancelled')
  assert.equal(await third, 'cancelled')

  // Finish first prompt as cancelled after settlement.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')

  // queue should have been cleared, so no further prompt started
  assert.equal(proc.prompts.length, 1)
})

test('AtomicAcpSession: Atomic exit fails active and queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  proc.exit(new Error('crash after prompt accepted'))

  await assert.rejects(first, /Atomic exited/)
  await assert.rejects(second, /Atomic exited/)
  assert.equal(proc.prompts.length, 1)
})

test('AtomicAcpSession: cancellation during settlement waits for usage and returns cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  let releaseStats!: (stats: AtomicSessionStats) => void
  let statsStarted!: () => void
  const started = new Promise<void>(resolve => {
    statsStarted = resolve
  })
  const stats = new Promise<AtomicSessionStats>(resolve => {
    releaseStats = resolve
  })
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getSessionStats: async () => {
      statsStarted()
      return stats
    }
  })
  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as AtomicRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  let finished = false
  const prompt = session.prompt('one').then(reason => {
    finished = true
    return reason
  })
  const queued = session.prompt('two')
  proc.emit({ type: 'agent_settled' })
  await started
  await session.cancel()
  assert.equal(await queued, 'cancelled')
  assert.equal(finished, false)
  releaseStats({ contextUsage: { tokens: 12, contextWindow: 100 } })
  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.prompts.length, 1)
  assert.ok(conn.updates.some(({ update }) => update.sessionUpdate === 'usage_update' && update.used === 12))
})
