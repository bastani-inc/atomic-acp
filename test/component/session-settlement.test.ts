import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('AtomicAcpSession keeps the prompt and its queue open across retries until settlement', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as AtomicRpcProcess,
    conn: asAgentConn(conn)
  })
  let completed = false
  const first = session.prompt('first').then(reason => {
    completed = true
    return reason
  })
  const second = session.prompt('second')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  assert.equal(proc.prompts.length, 1)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'retried' } })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(proc.prompts.length, 2)
  assert.ok(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text === 'retried'
    )
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})
