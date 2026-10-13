import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromAtomicGetCommands } from '../../src/acp/atomic-commands.js'

test('toAvailableCommandsFromAtomicGetCommands: includes extension commands and filters skill commands', () => {
  const data = {
    commands: [
      { name: 'x', description: 'X', source: 'extension' },
      { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user' },
      { name: 'y', source: 'prompt', location: 'project' }
    ]
  }

  const all = toAvailableCommandsFromAtomicGetCommands(data, { enableSkillCommands: true }).commands
  assert.deepEqual(all, [
    { name: 'x', description: 'X' },
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const includeExt = toAvailableCommandsFromAtomicGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: false
  }).commands
  assert.deepEqual(includeExt, [
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const noSkills = toAvailableCommandsFromAtomicGetCommands(data, { enableSkillCommands: false }).commands
  assert.deepEqual(noSkills, [
    { name: 'x', description: 'X' },
    { name: 'y', description: '(prompt:project)' }
  ])
})
