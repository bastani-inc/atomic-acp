import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

/** A saved session restored into an Atomic that reports `state`, recording the paths it exports to. */
function fixture(t: import('node:test').TestContext, state: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-export-'))
  const conn = new FakeAgentSideConnection()
  const agent = new AtomicAcpAgent(asAgentConn(conn))
  const store = new SessionStore(join(root, 'session-map.json'))
  store.upsert({ sessionId: 'saved', cwd: root })
  Object.defineProperty(agent, 'store', { value: store })
  const exports: Array<string | undefined> = []
  const proc = Object.assign(new FakeAtomicRpcProcess(), {
    getState: async () => ({ thinkingLevel: 'off', ...state }),
    getAvailableThinkingLevels: async () => ['off'],
    exportHtml: async (outputPath?: string) => {
      exports.push(outputPath)
      return { path: outputPath ?? '' }
    }
  })
  t.mock.method(AtomicRpcProcess, 'spawn', async () => proc as unknown as AtomicRpcProcess)
  t.after(() => {
    agent.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const exportSession = () => agent.prompt({ sessionId: 'saved', prompt: [{ type: 'text', text: '/export' }] })
  return { root, conn, exports, exportSession }
}

test('/export saves a session Atomic keeps in its database as HTML in the project', async t => {
  // Database sessions report no JSONL location.
  const { root, conn, exports, exportSession } = fixture(t, { sessionId: 'saved', messageCount: 2 })

  assert.equal((await exportSession()).stopReason, 'end_turn')

  const htmlPath = join(root, 'atomic-session-saved.html')
  assert.deepEqual(exports, [htmlPath])
  const links = conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'resource_link' ? [update.content] : []
  )
  assert.deepEqual(
    links.map(link => link.uri),
    [`file://${htmlPath}`]
  )
})

test('/export of a session without messages explains there is nothing to export', async t => {
  const { conn, exports, exportSession } = fixture(t, { sessionId: 'saved', messageCount: 0 })

  await exportSession()

  assert.deepEqual(exports, [])
  const texts = conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
  )
  assert.ok(texts.some(text => text.startsWith('Nothing to export yet')))
})
