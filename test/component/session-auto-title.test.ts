import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(existingName?: string, autoTitle = true) {
  const conn = new FakeAgentSideConnection()
  const names: string[] = []
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getState: async () => ({ sessionName: existingName }),
    setSessionName: async (name: string) => {
      names.push(name)
    }
  })
  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as AtomicRpcProcess,
    conn: asAgentConn(conn),
    autoTitle
  })
  return { conn, names, proc, session }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('new session is named at first prompt start, independently of startup banner', async () => {
  const { session, proc, names, conn } = createSession()
  session.setStartupInfo('Welcome to Atomic')
  const first = session.prompt('hello', [], 'Fix thread titles')
  await tick()
  assert.deepEqual(names, ['Fix thread titles'])
  assert.ok(
    conn.updates.some(
      ({ update }) => update.sessionUpdate === 'session_info_update' && update.title === 'Fix thread titles'
    )
  )
  proc.emit({ type: 'agent_settled' })
  await first
  const second = session.prompt('again', [], 'Do not rename')
  await tick()
  assert.deepEqual(names, ['Fix thread titles'])
  proc.emit({ type: 'agent_settled' })
  await second
})

test('automatic names preserve existing names and manual names win', async () => {
  const { session, proc, names } = createSession('Existing title')
  const prompt = session.prompt('hello', [], 'Automatic title')
  await tick()
  assert.deepEqual(names, [])
  await session.setSessionName('Manual title')
  assert.deepEqual(names, ['Manual title'])
  proc.emit({ type: 'agent_settled' })
  await prompt
})

test('failed automatic naming does not fail the prompt', async () => {
  const { session, proc } = createSession()
  proc.setSessionName = async () => {
    throw new Error('unavailable')
  }
  const prompt = session.prompt('hello', [], 'Automatic title')
  await tick()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('rename events ignore duplicates and malformed values but publish cleared names', async () => {
  const { proc, conn } = createSession(undefined, false)
  for (const name of ['Manual', 'Manual', 123, {}, 'Manual', undefined, undefined])
    proc.emit({ type: 'session_info_changed', name })
  await tick()
  assert.deepEqual(
    conn.updates.flatMap(({ update }) =>
      update.sessionUpdate === 'session_info_update' && 'title' in update ? [update.title] : []
    ),
    ['Manual', null]
  )
})
