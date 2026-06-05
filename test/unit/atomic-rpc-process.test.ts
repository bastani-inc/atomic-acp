import test from 'node:test'
import assert from 'node:assert/strict'

import { splitLfJsonlChunk } from '../../src/atomic-rpc/process.js'

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
