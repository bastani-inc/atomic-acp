import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

for (const [command, expected] of [
  ['/workflow-runs completed', 'list:completed'],
  ['/workflow-run run-1', 'get:run-1']
]) {
  test(`${command} renders retained workflow history without a model turn`, async () => {
    const conn = new FakeAgentSideConnection()
    const agent = new AtomicAcpAgent(asAgentConn(conn))
    const calls: string[] = []
    const run = { runId: 'run-1', name: 'review', status: 'completed', summary: 'Verified all changes.' }
    const proc = {
      listWorkflowRuns: async (status?: string) => {
        calls.push(`list:${status}`)
        return { runs: [run] }
      },
      getWorkflowRunSummary: async (id: string) => {
        calls.push(`get:${id}`)
        return run
      }
    }
    ;(agent as unknown as { sessions: unknown }).sessions = { get: () => ({ sessionId: 's', proc }) }
    const response = await agent.prompt({ sessionId: 's', prompt: [{ type: 'text', text: command! }] })
    assert.equal(response.stopReason, 'end_turn')
    assert.deepEqual(calls, [expected])
    const update = conn.updates.at(-1)?.update
    assert.equal(update?.sessionUpdate, 'agent_message_chunk')
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      assert.match(update.content.text, /review.*run-1/)
      assert.match(update.content.text, /completed/)
      assert.match(update.content.text, /Verified all changes/)
    }
  })
}
