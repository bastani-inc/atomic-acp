import test from 'node:test'
import assert from 'node:assert/strict'
import { promptToSessionTitle } from '../../src/acp/translate/prompt.js'

test('session titles use only normalized prompt text and truncate without splitting Unicode', () => {
  assert.equal(
    promptToSessionTitle([
      { type: 'text', text: '  Fix\n the ' },
      { type: 'resource_link', uri: 'file:///context', name: 'context' },
      { type: 'text', text: 'title  ' }
    ]),
    'Fix the title'
  )
  assert.equal(promptToSessionTitle([{ type: 'text', text: '😀'.repeat(81) }]), '😀'.repeat(80))
  assert.equal(promptToSessionTitle([{ type: 'text', text: ' \n ' }]), null)
})
