import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromAtomicGetCommands } from '../../src/acp/atomic-commands.js'

test('workflow extension command is advertised with its usage argument hint', () => {
  const { commands } = toAvailableCommandsFromAtomicGetCommands({
    commands: [
      {
        name: 'workflow',
        source: 'extension',
        hasArgumentCompletions: true,
        description: 'Run workflows. Usage: /workflow <name> [key=value…] | /workflow list'
      }
    ]
  })
  assert.deepEqual(commands, [
    {
      name: 'workflow',
      description: 'Run workflows. Usage: /workflow <name> [key=value…] | /workflow list',
      input: { hint: '<name> [key=value…] | /workflow list' }
    }
  ])
})
