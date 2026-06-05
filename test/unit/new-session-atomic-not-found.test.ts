import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('AtomicAcpAgent: newSession returns a helpful Internal error when Atomic is not installed', async () => {
  const prevAtomicCmd = process.env.ATOMIC_ACP_ATOMIC_COMMAND
  process.env.ATOMIC_ACP_ATOMIC_COMMAND = 'atomic-does-not-exist-12345'

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new AtomicAcpAgent(asAgentConn(conn), {} as any)

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) =>
        e?.code === -32603 &&
        String(e?.message ?? '')
          .toLowerCase()
          .includes('executable not found')
    )
  } finally {
    if (prevAtomicCmd == null) delete process.env.ATOMIC_ACP_ATOMIC_COMMAND
    else process.env.ATOMIC_ACP_ATOMIC_COMMAND = prevAtomicCmd
  }
})
