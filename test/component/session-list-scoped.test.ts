import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn, listedSession } from '../helpers/fakes.js'

test('AtomicAcpAgent: listSessions lists the last session cwd when cwd param is omitted', async t => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwds: string[] = []
  t.mock.method(AtomicRpcProcess, 'spawn', async (params: Parameters<typeof AtomicRpcProcess.spawn>[0]) => {
    cwds.push(params.cwd)
    const lister = new FakeAtomicRpcProcess()
    lister.sessions = [listedSession(`sess-${params.cwd}`, params.cwd, { name: params.cwd })]
    return lister as unknown as AtomicRpcProcess
  })
  const agent = new AtomicAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  Object.defineProperty(agent, 'store', { value: new SessionStore(join(root, 'session-map.json')) })
  ;(agent as any).lastSessionCwd = '/cwd/a'

  const listed = await agent.listSessions({})

  assert.deepEqual(cwds, ['/cwd/a'])
  assert.deepEqual(
    listed.sessions.map(s => s.sessionId),
    ['sess-/cwd/a']
  )
})
