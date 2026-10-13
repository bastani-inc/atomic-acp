import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession } from '../../src/acp/session.js'
import type { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

function setup() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const session = new AtomicAcpSession({
    sessionId: 's',
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as unknown as AtomicRpcProcess
  })
  return { conn, proc, session }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('workflow command output, status and widget stream without an active prompt', async () => {
  const { conn, proc } = setup()
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'workflows:command-output',
      content: 'Available workflows: smoke',
      display: true
    }
  })
  proc.emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'workflow', statusText: 'Running smoke' })
  proc.emit({
    type: 'extension_ui_request',
    method: 'setWidget',
    widgetKey: 'workflow.run',
    widgetLines: ['smoke completed']
  })
  await tick()
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', display: false, content: 'Internal reconciliation: do not show' }
  })
  await tick()
  assert.deepEqual(
    conn.updates.map(u => (u.update.sessionUpdate === 'agent_message_chunk' ? u.update.content : null)),
    [
      { type: 'text', text: 'Available workflows: smoke' },
      { type: 'text', text: 'Running smoke' },
      { type: 'text', text: 'smoke completed' }
    ]
  )
})

test('handled workflow commands pass through and finish after output without agent_end', async () => {
  const { conn, proc, session } = setup()
  proc.promptDisposition = 'handled'
  const result = session.prompt('/workflow list')
  proc.emit({ type: 'message_end', message: { role: 'custom', display: true, content: 'Available workflows' } })
  assert.equal(await result, 'end_turn')
  assert.equal(proc.prompts[0]?.message, '/workflow list')
  assert.ok(conn.updates.some(u => u.update.sessionUpdate === 'agent_message_chunk'))
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Background workflow finished' }
  })
  proc.emit({ type: 'agent_end' })
  await tick()
  assert.ok(
    conn.updates.some(
      u =>
        u.update.sessionUpdate === 'agent_message_chunk' &&
        u.update.content.type === 'text' &&
        u.update.content.text === 'Background workflow finished'
    )
  )
})

test('workflow tool reports action and identity through execution and results', async () => {
  const { conn, proc } = setup()
  proc.emit({ type: 'tool_execution_start', toolCallId: 'launch', toolName: 'workflow', args: { workflow: 'review' } })
  await tick()
  const launch = conn.updates.shift()?.update
  assert.equal(launch?.sessionUpdate, 'tool_call')
  if (launch?.sessionUpdate === 'tool_call') assert.equal(launch.title, 'workflow: run review')
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 'w', name: 'workflow', arguments: {} } }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'w',
    toolName: 'workflow',
    args: { action: 'status', runId: 'run-1' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'w',
    result: { content: [{ type: 'text', text: 'Completed review' }] }
  })
  await tick()
  const update = conn.updates[1]?.update
  assert.equal(update?.sessionUpdate, 'tool_call_update')
  if (update?.sessionUpdate === 'tool_call_update') {
    assert.equal(update.title, 'workflow: status run-1')
    assert.equal(update.kind, 'other')
  }
  const end = conn.updates[2]?.update
  assert.equal(end?.sessionUpdate, 'tool_call_update')
  if (end?.sessionUpdate === 'tool_call_update')
    assert.deepEqual(end.content, [{ type: 'content', content: { type: 'text', text: 'Completed review' } }])
})

test('a prompt submitted during background work waits for its own settlement', async () => {
  const { proc, session } = setup()
  proc.promptDisposition = 'handled'
  assert.equal(await session.prompt('/workflow run review'), 'end_turn')
  proc.emit({ type: 'agent_start' })
  proc.promptDisposition = 'queued'
  let finished = false
  const result = session.prompt('Explain the changes').then(reason => {
    finished = true
    return reason
  })
  await tick()
  assert.equal(proc.prompts.length, 2)
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(finished, false)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await result, 'end_turn')
})

test('completed out-of-turn background work does not prevent a later prompt from completing', async () => {
  const { conn, proc, session } = setup()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Background output' } })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  const result = session.prompt('Continue chatting')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await result, 'end_turn')
  assert.ok(
    conn.updates.some(
      u =>
        u.update.sessionUpdate === 'agent_message_chunk' &&
        u.update.content.type === 'text' &&
        u.update.content.text === 'Background output'
    )
  )
})

test('a follow-up starting before background settlement completes at the shared settlement', async () => {
  const { proc, session } = setup()
  proc.emit({ type: 'agent_start' })
  proc.promptDisposition = 'queued'
  const result = session.prompt('Follow up')
  await tick()
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await result, 'end_turn')
})
