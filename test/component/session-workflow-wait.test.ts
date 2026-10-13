import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession, type StopReason } from '../../src/acp/session.js'
import type { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

function setup(opts: { waitForWorkflows?: boolean; headless?: boolean } = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const session = new AtomicAcpSession({
    sessionId: 's',
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as unknown as AtomicRpcProcess,
    workflowFollowUpGraceMs: 20,
    ...opts
  })
  return { conn, proc, session }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function track(result: Promise<StopReason>) {
  const state: { reason?: StopReason } = {}
  void result.then(reason => {
    state.reason = reason
  })
  return state
}

function entry(customType: string, data: Record<string, unknown>) {
  return { type: 'entry_appended', entry: { type: 'custom', customType, data } }
}

function completedNotice(runId: string) {
  return {
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'workflows:lifecycle-notice',
      display: true,
      content: `✓ Workflow "sleepy" completed (run ${runId})`,
      details: { kind: 'completed', scope: 'run', runId, workflowName: 'sleepy', status: 'completed' }
    }
  }
}

function runToolCall(conn: FakeAgentSideConnection, runId: string) {
  return conn.updates
    .map(({ update }) => update)
    .filter(
      update =>
        (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
        update.toolCallId === `workflow-run-${runId}`
    )
}

test('a turn that launches a workflow stays open until the run ends and the model follows up', async () => {
  const { conn, proc, session } = setup()
  proc.promptDisposition = 'started'
  const turn = track(session.prompt('Run the sleepy workflow'))
  await tick()
  proc.emit({ type: 'agent_start' })
  proc.emit(entry('workflow.run.start', { runId: 'run-1', name: 'sleepy' }))
  proc.emit(entry('workflow.stage.start', { runId: 'run-1', stageId: 't', name: 'sleep', replayKey: 'tool:abc' }))
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await sleep(40)
  assert.equal(turn.reason, undefined, 'the prompt must not end while its workflow runs')

  proc.emit(completedNotice('run-1'))
  proc.emit({ type: 'agent_start' })
  proc.emit(entry('workflow.run.end', { runId: 'run-1', status: 'completed', result: { marker: 'sleepy-done' } }))
  await sleep(40)
  assert.equal(turn.reason, undefined, 'the prompt waits for the follow-up turn on the completion notice')
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The workflow finished.' } })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await sleep(10)
  assert.equal(turn.reason, 'end_turn')

  const updates = runToolCall(conn, 'run-1')
  assert.equal(updates[0]?.sessionUpdate, 'tool_call')
  const last = updates.at(-1)
  assert.equal(last?.sessionUpdate === 'tool_call_update' ? last.status : undefined, 'completed')
  assert.match(JSON.stringify(updates), /stage sleep/)
  assert.match(JSON.stringify(last), /sleepy-done/)
})

test('a handled /workflow command ends after the run when no follow-up turn comes', async () => {
  const { proc, session } = setup()
  proc.promptDisposition = 'handled'
  const turn = track(session.prompt('/workflow sleepy'))
  proc.emit(entry('workflow.run.start', { runId: 'run-2', name: 'sleepy' }))
  await sleep(40)
  assert.equal(turn.reason, undefined)
  proc.emit(entry('workflow.run.end', { runId: 'run-2', status: 'failed', error: 'boom' }))
  await sleep(60)
  assert.equal(turn.reason, 'end_turn')
})

test('runs started by a handled command before its response are still awaited', async () => {
  const { proc, session } = setup()
  let release!: () => void
  proc.promptPromise = new Promise<void>(resolve => {
    release = resolve
  })
  proc.promptDisposition = 'handled'
  const turn = track(session.prompt('/workflow sleepy'))
  await tick()
  proc.emit(entry('workflow.run.start', { runId: 'run-3', name: 'sleepy' }))
  release()
  await sleep(40)
  assert.equal(turn.reason, undefined)
  proc.emit(completedNotice('run-3'))
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await sleep(10)
  assert.equal(turn.reason, 'end_turn')
})

test('session/cancel ends the turn and quits the workflow runs it started', async () => {
  const { conn, proc, session } = setup()
  proc.promptDisposition = 'started'
  const turn = track(session.prompt('Run two workflows'))
  await tick()
  proc.emit({ type: 'agent_start' })
  proc.emit(entry('workflow.run.start', { runId: 'run-a', name: 'one' }))
  proc.emit(entry('workflow.run.start', { runId: 'run-b', name: 'two' }))
  proc.emit(entry('workflow.run.end', { runId: 'run-a', status: 'completed' }))
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await sleep(10)
  assert.equal(turn.reason, undefined)

  await session.cancel()
  await sleep(10)
  assert.equal(turn.reason, 'cancelled')
  assert.deepEqual(
    proc.prompts.slice(1).map(p => p.message),
    ['/workflow quit run-b']
  )
  const last = runToolCall(conn, 'run-b').at(-1)
  assert.equal(last?.sessionUpdate === 'tool_call_update' ? last.status : undefined, 'failed')
})

test('a workflow waiting for human input releases the turn and says how to answer', async () => {
  const { conn, proc, session } = setup()
  proc.promptDisposition = 'handled'
  const turn = track(session.prompt('/workflow ask-name'))
  proc.emit(entry('workflow.run.start', { runId: 'run-q', name: 'ask-name' }))
  await sleep(10)
  proc.emit(entry('workflow.stage.start', { runId: 'run-q', stageId: 'q', name: 'input', replayKey: 'prompt:input:x' }))
  await sleep(60)
  assert.equal(turn.reason, 'end_turn')
  const text = conn.updates
    .map(({ update }) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : ''
    )
    .join('\n')
  assert.match(text, /Workflow "ask-name" is waiting for input/)
})

test('ATOMIC_ACP_WAIT_FOR_WORKFLOWS=0 keeps the old behaviour', async () => {
  const previous = process.env.ATOMIC_ACP_WAIT_FOR_WORKFLOWS
  process.env.ATOMIC_ACP_WAIT_FOR_WORKFLOWS = '0'
  try {
    const { proc, session } = setup()
    proc.promptDisposition = 'started'
    const turn = track(session.prompt('Run the sleepy workflow'))
    await tick()
    proc.emit({ type: 'agent_start' })
    proc.emit(entry('workflow.run.start', { runId: 'run-x', name: 'sleepy' }))
    proc.emit({ type: 'agent_end' })
    proc.emit({ type: 'agent_settled' })
    await sleep(10)
    assert.equal(turn.reason, 'end_turn')
  } finally {
    if (previous === undefined) delete process.env.ATOMIC_ACP_WAIT_FOR_WORKFLOWS
    else process.env.ATOMIC_ACP_WAIT_FOR_WORKFLOWS = previous
  }
})

test('a run that ends inside the start-notice turn of a handled command still ends the prompt', async () => {
  const { proc, session } = setup()
  let release!: () => void
  proc.promptPromise = new Promise<void>(resolve => {
    release = resolve
  })
  proc.promptDisposition = 'handled'
  const turn = track(session.prompt('/workflow sleepy'))
  await tick()
  proc.emit(entry('workflow.run.start', { runId: 'run-f', name: 'sleepy' }))
  proc.emit({ type: 'agent_start' })
  release()
  await tick()
  proc.emit(completedNotice('run-f'))
  proc.emit(entry('workflow.run.end', { runId: 'run-f', status: 'completed', result: { marker: 'fast' } }))
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await sleep(60)
  assert.equal(turn.reason, 'end_turn')
})
