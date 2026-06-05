import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAtomicAssistantText, normalizeAtomicMessageText } from '../../src/acp/translate/atomic-messages.js'

test('normalizeAtomicMessageText: supports string', () => {
  assert.equal(normalizeAtomicMessageText('hello'), 'hello')
})

test('normalizeAtomicMessageText: joins text blocks', () => {
  assert.equal(
    normalizeAtomicMessageText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'not_text', x: 1 }
    ]),
    'ab'
  )
})

test('normalizeAtomicAssistantText: joins only text blocks', () => {
  assert.equal(
    normalizeAtomicAssistantText([
      { type: 'text', text: 'hi' },
      { type: 'thinking', text: '...' },
      { type: 'text', text: '!' }
    ]),
    'hi!'
  )
})
