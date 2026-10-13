import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { AtomicAcpSession } from '../../src/acp/session.js'
import type { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('startup info includes global and project packages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-packages-'))
  const previous = process.env.ATOMIC_CODING_AGENT_DIR
  const globalDir = join(root, 'global')
  const cwd = join(root, 'project')
  mkdirSync(globalDir)
  mkdirSync(join(cwd, '.atomic'), { recursive: true })
  writeFileSync(join(globalDir, 'settings.json'), JSON.stringify({ packages: ['npm:global-ext'] }))
  writeFileSync(join(cwd, '.atomic', 'settings.json'), JSON.stringify({ packages: ['/local/extension'] }))
  process.env.ATOMIC_CODING_AGENT_DIR = globalDir
  try {
    const conn = new FakeAgentSideConnection()
    const proc = new FakeAtomicRpcProcess()
    const session = new AtomicAcpSession({
      sessionId: 's1',
      cwd,
      mcpServers: [],
      proc: proc as unknown as AtomicRpcProcess,
      conn: asAgentConn(conn)
    })
    const agent = new AtomicAcpAgent(asAgentConn(conn))
    Object.assign(agent, { sessions: { create: async () => session, closeAllExcept() {} } })
    const response = await agent.newSession({ cwd, mcpServers: [] })
    const text = response._meta?.atomicAcp as { startupInfo?: string }
    assert.match(text.startupInfo ?? '', /npm:global-ext/)
    assert.match(text.startupInfo ?? '', /\/local\/extension/)
  } finally {
    if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
