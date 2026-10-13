import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpAgent } from '../../src/acp/agent.js'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { readFakeAtomicReport, writeFakeAtomicCli } from '../helpers/fake-atomic-cli.js'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(opts: { headless?: boolean } = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as AtomicRpcProcess,
    conn: asAgentConn(conn),
    ...opts
  })
  return { conn, proc }
}

function agentText(conn: FakeAgentSideConnection): string {
  return conn.updates
    .map(({ update }) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : ''
    )
    .join('\n')
}

test('headless sessions answer every extension dialog at once, saying no person is available', async () => {
  const { conn, proc } = setup({ headless: true })
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    proc.emit({ type: 'extension_ui_request', id: method, method, title: `Question ${method}`, options: ['a', 'b'] })
  }
  await flush()
  await flush()
  assert.equal(conn.permissionRequests.length, 0)
  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(
    proc.extensionUiResponses,
    ['select', 'confirm', 'input', 'editor'].map(id => ({ type: 'extension_ui_response', id, cancelled: true }))
  )
  const text = agentText(conn)
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    assert.match(text, new RegExp(`No person is available to answer "Question ${method}"`))
  }
})

test('a client that cannot answer permission prompts gets the same clear cancellation', async () => {
  const { conn, proc } = setup()
  conn.requestPermission = async () => {
    throw new Error('Method not found')
  }
  proc.emit({ type: 'extension_ui_request', id: 'c', method: 'confirm', title: 'Deploy now?' })
  await flush()
  await flush()
  assert.deepEqual(proc.extensionUiResponses, [{ type: 'extension_ui_response', id: 'c', cancelled: true }])
  assert.match(agentText(conn), /No person is available to answer "Deploy now\?"/)
})

test('ATOMIC_ACP_HEADLESS=1 starts Atomic in headless mode', async t => {
  const previous = process.env.ATOMIC_ACP_HEADLESS
  process.env.ATOMIC_ACP_HEADLESS = '1'
  const spawns: Parameters<typeof AtomicRpcProcess.spawn>[0][] = []
  t.mock.method(AtomicRpcProcess, 'spawn', async (options: Parameters<typeof AtomicRpcProcess.spawn>[0]) => {
    spawns.push(options)
    return Object.assign(new FakeAtomicRpcProcess(), {
      getState: async () => ({ thinkingLevel: 'off' }),
      getAvailableThinkingLevels: async () => ['off'],
      dispose() {}
    }) as unknown as AtomicRpcProcess
  })
  t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
  const agent = new AtomicAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  t.after(() => {
    agent.dispose()
    if (previous === undefined) delete process.env.ATOMIC_ACP_HEADLESS
    else process.env.ATOMIC_ACP_HEADLESS = previous
  })
  await agent.newSession({ cwd: process.cwd(), mcpServers: [] })
  assert.equal(spawns[0]?.headless, true)
})

test('headless Atomic blocks ask_user_question with a clear result and leaves other tools alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-headless-'))
  let proc: AtomicRpcProcess | undefined
  try {
    proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand: writeFakeAtomicCli(root), headless: true })
    const { toolCallResults } = readFakeAtomicReport(root)
    const [blocked] = toolCallResults.ask_user_question ?? []
    assert.equal((blocked as { block?: unknown }).block, true)
    assert.match(String((blocked as { reason?: unknown }).reason), /No person is available/)
    assert.deepEqual(toolCallResults.bash, [null])
  } finally {
    proc?.dispose('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

function workflowEntry(customType: string, data: Record<string, unknown>) {
  return { type: 'entry_appended', entry: { type: 'custom', customType, data } }
}

test('headless sessions quit a workflow run that stops for human input and say why', async () => {
  const { conn, proc } = setup({ headless: true })
  proc.emit(workflowEntry('workflow.run.start', { runId: 'run-1', name: 'ask-name' }))
  proc.emit(workflowEntry('workflow.stage.start', { runId: 'run-1', stageId: 'st', name: 'tool', replayKey: 'tool:x' }))
  await flush()
  assert.equal(proc.prompts.length, 0)
  proc.emit(
    workflowEntry('workflow.stage.start', { runId: 'run-1', stageId: 'q', name: 'input', replayKey: 'prompt:input:ab' })
  )
  await flush()
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['/workflow quit run-1']
  )
  assert.match(agentText(conn), /No person is available to answer workflow "ask-name" \(stage input\)/)
})

test('interactive sessions leave workflow input prompts for a person to answer', async () => {
  const { proc } = setup()
  proc.emit(workflowEntry('workflow.run.start', { runId: 'run-1', name: 'ask-name' }))
  proc.emit(
    workflowEntry('workflow.stage.start', { runId: 'run-1', stageId: 'q', name: 'input', replayKey: 'prompt:input:ab' })
  )
  await flush()
  assert.deepEqual(proc.prompts, [])
})
