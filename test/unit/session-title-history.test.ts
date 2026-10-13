import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAtomicSessionTitle } from '../../src/acp/atomic-sessions.js'

test('saved title reader scans long histories and does not resurrect explicitly cleared names', t => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-title-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'session.jsonl')
  const history = [
    { type: 'session', id: 's1', cwd: dir },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '  Original\n' },
          { type: 'text', text: 'prompt  ' }
        ]
      }
    },
    ...Array.from({ length: 2100 }, () => ({
      type: 'message',
      message: { role: 'assistant', content: 'x'.repeat(200) }
    }))
  ]
  const save = (entries: unknown[]) => writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n'))
  save(history)
  assert.equal(readAtomicSessionTitle(path), 'Original prompt')
  save([history[0], { type: 'session_info', name: 'Early name' }, ...history.slice(1)])
  assert.equal(readAtomicSessionTitle(path), 'Early name')
  save([...history, { type: 'session_info', name: 'Old name' }, { type: 'session_info', name: '' }])
  assert.equal(readAtomicSessionTitle(path), '')
})
