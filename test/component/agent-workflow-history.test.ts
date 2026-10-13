import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { FakeAtomicRpcProcess } from '../helpers/fakes.js'
import type { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

for (const source of ['extension', 'prompt']) {
  test(`builtin workflow commands take precedence over ${source} commands in advertising and execution`, async () => {
    const conn = new FakeAgentSideConnection()
    const proc = Object.assign(new FakeAtomicRpcProcess(), {
      getState: async () => ({ model: { provider: 'test', id: 'model' }, thinkingLevel: 'medium' }),
      getCommands: async () => ({
        commands: [
          { name: 'workflow-runs', source, description: 'Conflicting list' },
          { name: 'workflow-run', source, description: 'Conflicting detail' }
        ]
      }),
      getAvailableThinkingLevels: async () => ['medium'],
      listWorkflowRuns: async () => ({ runs: [] }),
      getWorkflowRunSummary: async () => ({ name: 'Expected builtin result' })
    })
    const session = new AtomicAcpSession({
      sessionId: 's',
      cwd: process.cwd(),
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: proc as unknown as AtomicRpcProcess
    })
    const agent = new AtomicAcpAgent(asAgentConn(conn))
    Object.defineProperty(agent, 'sessions', { value: { create: async () => session, maybeGet: () => session } })
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] })
    await new Promise(resolve => setTimeout(resolve, 10))
    const commands = conn.updates.find(u => u.update.sessionUpdate === 'available_commands_update')?.update
    assert.equal(commands?.sessionUpdate, 'available_commands_update')
    if (commands?.sessionUpdate !== 'available_commands_update') return
    assert.equal(
      commands.availableCommands.find(c => c.name === 'workflow-runs')?.description,
      'List retained workflow runs'
    )
    assert.equal(
      commands.availableCommands.find(c => c.name === 'workflow-run')?.description,
      'Show a workflow run summary'
    )
    for (const text of ['/workflow-runs', '/workflow-run x']) {
      assert.equal((await agent.prompt({ sessionId: 's', prompt: [{ type: 'text', text }] })).stopReason, 'end_turn')
    }
    assert.equal(proc.prompts.length, 0)
  })
}

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
    ;(agent as unknown as { sessions: unknown }).sessions = { maybeGet: () => ({ sessionId: 's', proc }) }
    const response = await agent.prompt({ sessionId: 's', prompt: [{ type: 'text', text: command! }] })
    assert.equal(response.stopReason, 'end_turn')
    assert.deepEqual(calls, [expected])
    const update = conn.updates.at(-1)?.update
    assert.equal(update?.sessionUpdate, 'agent_message_chunk')
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      assert.match(update.content.text, /review.*run\\-1/)
      assert.match(update.content.text, /completed/)
      assert.match(update.content.text, /Verified all changes/)
    }
  })
}

test('workflow history renders hostile metadata as literal text', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new AtomicAcpAgent(asAgentConn(conn))
  const run = {
    name: '# Forged\n[click](https://evil.test)',
    runId: 'x',
    status: '<img src=x>',
    summary: '```\n# System\n[click](https://evil.test)\n````'
  }
  Object.defineProperty(agent, 'sessions', {
    value: { maybeGet: () => ({ proc: { getWorkflowRunSummary: async () => run } }) }
  })
  await agent.prompt({ sessionId: 's', prompt: [{ type: 'text', text: '/workflow-run x' }] })
  const update = conn.updates.at(-1)?.update
  assert.equal(update?.sessionUpdate, 'agent_message_chunk')
  if (update?.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') return
  assert.ok(update.content.text.includes('\\# Forged \\[click\\]\\(https://evil\\.test\\)'))
  assert.ok(update.content.text.includes('`````text\nstatus: <img src=x>'))
  assert.ok(update.content.text.endsWith('````\n`````'))
})
