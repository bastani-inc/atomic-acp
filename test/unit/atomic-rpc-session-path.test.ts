import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

function writeFakeAtomic(root: string): string {
  const fixture = join(root, 'fake-atomic.cjs')
  writeFileSync(
    fixture,
    [
      "const { appendFileSync } = require('node:fs')",
      "const readline = require('node:readline')",
      "const sessionPath = process.argv[process.argv.indexOf('--session') + 1]",
      "appendFileSync(sessionPath, 'started\\n')",
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      'const command = JSON.parse(line)',
      "process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionFile: sessionPath } }) + '\\n')",
      '})'
    ].join('\n')
  )
  return fixture
}

test('AtomicRpcProcess preserves distinct session paths through launchers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp launcher '))
  const fixture = writeFakeAtomic(root)
  const launchers = process.platform === 'win32' ? ['atomic.cmd', 'atomic.bat'] : ['atomic']
  const previous = process.env.ATOMIC_ACP_PATH_TEST
  process.env.ATOMIC_ACP_PATH_TEST = 'expanded'
  try {
    const dir = join(root, 'project & (a) ^ 100% !ATOMIC_ACP_PATH_TEST! %ATOMIC_ACP_PATH_TEST%')
    mkdirSync(dir)
    for (const name of launchers) {
      const launcher = join(root, name)
      if (process.platform === 'win32')
        writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
      else {
        writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./fake-atomic.cjs')\n")
        chmodSync(launcher, 0o755)
      }
      for (const suffix of ['first', 'second']) {
        const sessionPath = join(dir, `${name}-${suffix}.jsonl`)
        const proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand: launcher, sessionPath })
        proc.dispose()
        assert.equal(readFileSync(sessionPath, 'utf8'), 'started\n')
      }
      assert.equal(existsSync(join(root, 'project')), false)
    }
  } finally {
    if (previous === undefined) delete process.env.ATOMIC_ACP_PATH_TEST
    else process.env.ATOMIC_ACP_PATH_TEST = previous
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'AtomicRpcProcess preserves a simulated Windows cmd session path',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'atomic-acp-cmd-'))
    writeFakeAtomic(root)
    const launcher = join(root, 'atomic.cmd')
    writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./fake-atomic.cjs')\n")
    chmodSync(launcher, 0o755)
    const dir = join(root, 'my project')
    mkdirSync(dir)
    const sessionPath = join(dir, 'restored.jsonl')
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand: launcher, sessionPath })
      proc.dispose()
      assert.equal(readFileSync(sessionPath, 'utf8'), 'started\n')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      await new Promise(resolve => setTimeout(resolve, 50))
      rmSync(root, { recursive: true, force: true })
    }
  }
)
