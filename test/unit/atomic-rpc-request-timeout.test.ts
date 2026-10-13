import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

function fixture() {
  const stdout = new PassThrough()
  const written: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: {
      write(line: string, cb: () => void) {
        written.push(line)
        cb()
        return true
      }
    },
    killed: false,
    kill() {}
  })
  const proc = new (AtomicRpcProcess as unknown as new (child: ChildProcessWithoutNullStreams) => AtomicRpcProcess)(
    child as unknown as ChildProcessWithoutNullStreams
  )
  const respond = (data: unknown, id = (JSON.parse(written.at(-1)!) as { id: string }).id) =>
    stdout.write(JSON.stringify({ type: 'response', command: 'get_session_stats', success: true, id, data }) + '\n')
  return { proc, respond, stdout, written }
}

test('AtomicRpcProcess: timeout rejects auxiliary stats and drops late responses', async () => {
  const { proc, respond } = fixture()
  const events: unknown[] = []
  proc.onEvent(event => events.push(event))
  const keepAlive = setTimeout(() => {}, 100)
  try {
    await assert.rejects(proc.getSessionStats(5), /Atomic get_session_stats timed out after 5ms/)
  } finally {
    clearTimeout(keepAlive)
  }
  respond({ contextUsage: { tokens: 1, contextWindow: 2 } })
  assert.deepEqual(events, [])
})

test('AtomicRpcProcess: explicit stats waits longer than the auxiliary timeout', async () => {
  const { proc, respond } = fixture()
  const result = proc.getSessionStats()
  await new Promise(resolve => setTimeout(resolve, 1050))
  respond({ totalMessages: 42 })
  assert.deepEqual(await result, { totalMessages: 42 })
})

test('AtomicRpcProcess: a timely response clears the timer and unknown responses never become events', async () => {
  const { proc, respond, stdout } = fixture()
  const events: unknown[] = []
  proc.onEvent(event => events.push(event))
  const result = proc.getSessionStats(5000)
  respond({ contextUsage: { tokens: 10, contextWindow: 100 } })
  assert.deepEqual(await result, { contextUsage: { tokens: 10, contextWindow: 100 } })
  respond({}, 'unknown')
  stdout.write('{"type":"response","success":true}\n{"type":"agent_start"}\n')
  assert.deepEqual(events, [{ type: 'agent_start' }])
})

test('AtomicRpcProcess: discovery preserves opaque thinking levels and setters forward them unchanged', async () => {
  const { proc, respond, written } = fixture()
  const levels = proc.getAvailableThinkingLevels()
  assert.equal((JSON.parse(written.at(-1)!) as { type: string }).type, 'get_available_thinking_levels')
  respond({ levels: ['ordinary', 'mean', 'max'] })
  assert.deepEqual(await levels, ['ordinary', 'mean', 'max'])
  const setter = proc.setThinkingLevel('mean')
  assert.equal((JSON.parse(written.at(-1)!) as { level: string }).level, 'mean')
  respond({ level: 'max' })
  await setter
})

for (const data of [{}, { levels: [] }, { levels: [''] }, { levels: [1] }, { levels: 'high' }]) {
  test(`AtomicRpcProcess: rejects malformed thinking discovery ${JSON.stringify(data)}`, async () => {
    const { proc, respond } = fixture()
    const levels = proc.getAvailableThinkingLevels()
    respond(data)
    await assert.rejects(levels, /invalid levels/)
  })
}
