import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile } from '../../src/acp/atomic-settings.js'

test('Atomic settings accept a leading UTF-8 BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-settings-'))
  try {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '\uFEFF{"quietStartup":true}')
    assert.deepEqual(readJsonFile(path), { quietStartup: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
