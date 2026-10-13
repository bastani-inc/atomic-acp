import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('AtomicAcpSession: reports Atomic compaction without ending the prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as ConstructorParameters<typeof AtomicAcpSession>[0]['proc'],
    conn: asAgentConn(conn),
    fileCommands: []
  })
  let finished = false
  const prompt = session.prompt('continue').then(reason => {
    finished = true
    return reason
  })
  proc.emit({ type: 'compaction_start' })
  proc.emit({ type: 'compaction_end' })
  await new Promise(resolve => setTimeout(resolve, 0))
  const chunks = conn.updates.filter(update => update.update.sessionUpdate === 'agent_message_chunk')
  assert.equal(chunks.length, 2)
  assert.equal(finished, false)
  proc.emit({ type: 'agent_end' })
  assert.equal(await prompt, 'end_turn')
})
