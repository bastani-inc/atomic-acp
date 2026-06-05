import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

test('AtomicAcpAgent: quietStartup=true disables startup info generation/emission', async () => {
  const prevAgentDir = process.env.ATOMIC_CODING_AGENT_DIR

  // Force quietStartup in Atomic settings by pointing ATOMIC_CODING_AGENT_DIR at a temp dir.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-quietstartup-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup: true }, null, 2), 'utf-8')
  process.env.ATOMIC_CODING_AGENT_DIR = dir

  // Spy on setTimeout calls (agent schedules startup info + available commands)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()

    let setStartupInfoCalled = false
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(_text: string) {
        setStartupInfoCalled = true
      },
      sendStartupInfoIfPending() {
        // may be called when an update notice is available
      }
    }

    const agent = new AtomicAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    const startupInfo = res?._meta?.atomicAcp?.startupInfo ?? null

    // When quietStartup=true the full prelude is suppressed. However, an update notice
    // (if one exists) is still surfaced because it's high-signal and actionable.
    // The test must tolerate both cases since the live npm check may or may not find an update.
    if (startupInfo) {
      assert.match(startupInfo, /New version available/)
      assert.equal(setStartupInfoCalled, true)
      assert.equal(timeouts.length, 2)
    } else {
      assert.equal(setStartupInfoCalled, false)
      assert.equal(timeouts.length, 1)
    }
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = prevAgentDir
  }
})

test('AtomicAcpAgent: startup info reads prompts from ATOMIC_CODING_AGENT_DIR', async () => {
  const prevAgentDir = process.env.ATOMIC_CODING_AGENT_DIR
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-startup-agent-dir-'))
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  writeFileSync(join(dir, 'prompts', 'custom.md'), 'Custom prompt\n', 'utf-8')
  process.env.ATOMIC_CODING_AGENT_DIR = dir

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(_text: string) {},
      sendStartupInfoIfPending() {}
    }

    const agent = new AtomicAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    assert.match(String(res?._meta?.atomicAcp?.startupInfo ?? ''), /\/custom/)
  } finally {
    if (prevAgentDir == null) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = prevAgentDir
  }
})
