import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { readFakeAtomicReport, writeFakeAtomicCli } from '../helpers/fake-atomic-cli.js'

function entry(customType: string, data: Record<string, unknown>) {
  return { type: 'entry_appended', entry: { type: 'custom', customType, data } }
}

test('Atomic dying mid-workflow fails the prompt and every open tool call of the turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-exit-'))
  let proc: AtomicRpcProcess | undefined
  try {
    const atomicCommand = writeFakeAtomicCli(root, {
      promptEvents: [
        { type: 'agent_start' },
        { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'workflow', args: { name: 'sleepy' } },
        entry('workflow.run.start', { runId: 'run-1', name: 'sleepy' }),
        entry('workflow.stage.start', { runId: 'run-1', stageId: 't', name: 'sleep' })
      ]
    })
    proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand })
    const conn = new FakeAgentSideConnection()
    const session = new AtomicAcpSession({
      sessionId: 's',
      cwd: root,
      mcpServers: [],
      conn: asAgentConn(conn),
      proc,
      waitForWorkflows: true
    })
    const opened = new Set<string>()
    const allOpen = new Promise<void>(resolve => {
      const poll = setInterval(() => {
        for (const { update } of conn.updates) if (update.sessionUpdate === 'tool_call') opened.add(update.toolCallId)
        if (opened.has('tool-1') && opened.has('workflow-run-run-1')) {
          clearInterval(poll)
          resolve()
        }
      }, 5)
    })

    const turn = session.prompt('/workflow sleepy')
    await allOpen
    process.kill(readFakeAtomicReport(root).pid, 'SIGKILL')

    await assert.rejects(turn, (error: Error & { code?: number }) => {
      assert.equal(error.code, -32603)
      assert.match(error.message, /Atomic exited/)
      assert.match(error.message, /SIGKILL/)
      return true
    })
    for (const toolCallId of opened) {
      const last = conn.updates
        .map(({ update }) => update)
        .filter(update => 'toolCallId' in update && update.toolCallId === toolCallId)
        .at(-1)
      assert.equal(last && 'status' in last ? last.status : undefined, 'failed', `${toolCallId} must end as failed`)
      assert.match(JSON.stringify(last), /Atomic exited/)
    }
  } finally {
    proc?.dispose('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
