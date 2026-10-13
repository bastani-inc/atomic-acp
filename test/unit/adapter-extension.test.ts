import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeAdapterExtension } from '../../src/atomic-rpc/adapter-extension.js'

function busy(): Error {
  return Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' })
}

test('removing the extension retries while Windows reports its directory busy', async () => {
  const attempts: string[] = []
  const extension = writeAdapterExtension(
    { mcpServers: { a: { command: 'x', args: [], env: {}, exposure: 'direct' } } },
    {
      rm: async dir => {
        attempts.push(dir)
        if (attempts.length <= 2) throw busy()
        await rm(dir, { recursive: true, force: true })
      },
      retryDelaysMs: [1, 1, 1]
    }
  )
  assert.ok(extension)
  const dir = dirname(extension.path)

  await extension.dispose()

  assert.equal(attempts.length, 3)
  assert.deepEqual(new Set(attempts), new Set([dir]))
  assert.equal(existsSync(dir), false)
})

test('removing the extension never throws, even when the directory stays busy', async () => {
  let attempts = 0
  const extension = writeAdapterExtension(
    { askUserQuestionUnavailable: 'nobody here' },
    {
      rm: async () => {
        attempts++
        throw busy()
      },
      retryDelaysMs: [1, 1]
    }
  )
  assert.ok(extension)

  await extension.dispose()

  assert.equal(attempts, 3)
  await rm(dirname(extension.path), { recursive: true, force: true })
})
