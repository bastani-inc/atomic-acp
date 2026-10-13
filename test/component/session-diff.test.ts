import type { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('AtomicAcpSession: emits ACP diff content for edit tool when file changes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  new AtomicAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Start edit -> snapshot should be taken
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { input: '[a.txt#1234]\nreplace 1..1:\n+after' }
  })

  // Simulate file being edited by Atomic
  writeFileSync(filePath, 'after\n', 'utf8')

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for edit completion')

  const content = (end!.update as any).content as any[]
  assert.ok(Array.isArray(content), 'expected content array')
  const diff = content.find(c => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')

  assert.equal(diff.path, filePath)
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
  assert.equal(content.length, 1)
  assert.equal((end.update as { rawOutput?: unknown }).rawOutput, undefined)
})

test('hashline edits report each affected file and realized diff', async () => {
  const { rmSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-multidiff-'))
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  new AtomicAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as unknown as AtomicRpcProcess,
    conn: asAgentConn(conn)
  })
  try {
    for (const name of ['a', 'b']) writeFileSync(join(dir, name), `before ${name}\n`)
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'multi',
      toolName: 'edit',
      args: { input: '[a#1234]\nreplace 1..1:\n+after a\n[b#5678]\nreplace 1..1:\n+after b' }
    })
    for (const name of ['a', 'b']) writeFileSync(join(dir, name), `realized ${name}\n`)
    proc.emit({ type: 'tool_execution_end', toolCallId: 'multi', result: { details: { diff: 'preview' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    const first = conn.updates[0]!.update
    assert.ok(first.sessionUpdate === 'tool_call')
    assert.deepEqual(
      first.locations,
      ['a', 'b'].map(name => ({ path: join(dir, name) }))
    )
    const last = conn.updates.at(-1)!.update
    assert.ok(last.sessionUpdate === 'tool_call_update')
    assert.deepEqual(
      last.content,
      ['a', 'b'].map(name => ({
        type: 'diff',
        path: join(dir, name),
        oldText: `before ${name}\n`,
        newText: `realized ${name}\n`
      }))
    )
    assert.equal(last.rawOutput, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write diffs use null old text for new files and failed mutations retain errors', async () => {
  const { rmSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-writediff-'))
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  new AtomicAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as unknown as AtomicRpcProcess,
    conn: asAgentConn(conn)
  })
  try {
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 'write',
      toolName: 'write',
      args: { path: 'new.txt', content: 'requested' }
    })
    proc.emit({
      type: 'tool_execution_update',
      toolCallId: 'write',
      partialResult: { content: [{ type: 'text', text: 'preview' }] }
    })
    writeFileSync(join(dir, 'new.txt'), 'realized\n')
    proc.emit({ type: 'tool_execution_end', toolCallId: 'write', result: { content: [{ type: 'text', text: 'ok' }] } })
    proc.emit({ type: 'tool_execution_start', toolCallId: 'failed', toolName: 'write', args: { path: 'new.txt' } })
    proc.emit({
      type: 'tool_execution_end',
      toolCallId: 'failed',
      isError: true,
      result: { content: [{ type: 'text', text: 'denied' }] }
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const partial = conn.updates[1]!.update
    assert.ok(partial.sessionUpdate === 'tool_call_update')
    assert.equal(partial.content, undefined)
    assert.equal(partial.rawOutput, undefined)
    const end = conn.updates[2]!.update
    assert.ok(end.sessionUpdate === 'tool_call_update')
    assert.deepEqual(end.content, [{ type: 'diff', path: join(dir, 'new.txt'), oldText: null, newText: 'realized\n' }])
    const failed = conn.updates.at(-1)!.update
    assert.ok(failed.sessionUpdate === 'tool_call_update')
    assert.equal(failed.status, 'failed')
    assert.deepEqual(failed.content, [{ type: 'content', content: { type: 'text', text: 'denied' } }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
