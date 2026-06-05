import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

beforeEach(() => {
  delete process.env.ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT
})

afterEach(() => {
  delete process.env.ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT
})

async function initializeWithEmbeddedContext(value?: string) {
  if (value != null) process.env.ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT = value

  const agent = new AtomicAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.ok(res.agentCapabilities)
  assert.ok(res.agentCapabilities.promptCapabilities)
  return res.agentCapabilities.promptCapabilities.embeddedContext
}

test('ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT: defaults embeddedContext to false when undefined', async () => {
  assert.equal(await initializeWithEmbeddedContext(), false)
})

test("ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT: 'false' keeps embeddedContext disabled", async () => {
  assert.equal(await initializeWithEmbeddedContext('false'), false)
})

test("ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' enables embeddedContext", async () => {
  assert.equal(await initializeWithEmbeddedContext('true'), true)
})
