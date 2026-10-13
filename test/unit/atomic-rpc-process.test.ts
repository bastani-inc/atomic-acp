import test from 'node:test'
import assert from 'node:assert/strict'

import { AtomicRpcProcess, splitLfJsonlChunk } from '../../src/atomic-rpc/process.js'

test('splitLfJsonlChunk: splits only on LF and preserves Unicode separators inside JSON strings', () => {
  const record = JSON.stringify({ type: 'message_update', text: 'before\u2028middle\u2029after' })
  const split = splitLfJsonlChunk('', `${record}\n`)

  assert.deepEqual(split.lines, [record])
  assert.equal(split.buffer, '')
  assert.equal(JSON.parse(split.lines[0]!).text, 'before\u2028middle\u2029after')
})

test('splitLfJsonlChunk: carries partial records across chunks', () => {
  const first = splitLfJsonlChunk('', '{"type":"response"')
  assert.deepEqual(first.lines, [])
  assert.equal(first.buffer, '{"type":"response"')

  const second = splitLfJsonlChunk(first.buffer, ',"success":true}\n')
  assert.deepEqual(second.lines, ['{"type":"response","success":true}'])
  assert.equal(second.buffer, '')
})

test('AtomicRpcProcess.writeExtensionUiResponse writes uncorrelated JSONL without pending request', async () => {
  const written: string[] = []
  const proc = Object.create(AtomicRpcProcess.prototype) as any

  proc.pending = new Map()
  proc.child = {
    stdin: {
      write(line: string, cb: (err?: Error) => void) {
        written.push(line)
        cb()
      }
    }
  }

  await (proc as AtomicRpcProcess).writeExtensionUiResponse({
    type: 'extension_ui_response',
    id: 'select',
    value: 'selected option'
  })

  await (proc as AtomicRpcProcess).writeExtensionUiResponse({
    type: 'extension_ui_response',
    id: 'cancel',
    cancelled: true
  })

  assert.equal(proc.pending.size, 0)
  assert.equal(written.length, 2)
  assert.equal(
    written[0],
    JSON.stringify({
      type: 'extension_ui_response',
      id: 'select',
      value: 'selected option'
    }) + '\n'
  )
  assert.equal(
    written[1],
    JSON.stringify({
      type: 'extension_ui_response',
      id: 'cancel',
      cancelled: true
    }) + '\n'
  )
})
