import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

/** A fake Atomic that appends the `--session` value it received to `session-ids.txt` in the cwd it started in. */
function writeFakeAtomic(root: string): string {
  const fixture = join(root, 'fake-atomic.cjs')
  writeFileSync(
    fixture,
    [
      "const { appendFileSync } = require('node:fs')",
      "const readline = require('node:readline')",
      "const index = process.argv.indexOf('--session')",
      "appendFileSync('session-ids.txt', (index < 0 ? '<none>' : process.argv[index + 1]) + '\\n')",
      // Behind a Windows launcher it outlives the stopped cmd.exe until its stdin closes; it must not keep the project busy.
      "process.chdir(require('node:os').tmpdir())",
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      'const command = JSON.parse(line)',
      "process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: {} }) + '\\n')",
      '})'
    ].join('\n')
  )
  return fixture
}

async function startAndStop(params: Parameters<typeof AtomicRpcProcess.spawn>[0]): Promise<void> {
  const proc = await AtomicRpcProcess.spawn(params)
  await proc.getState()
  await proc.dispose()
}

test('AtomicRpcProcess resumes the session ID through launchers in a cwd with shell metacharacters', async () => {
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
      await startAndStop({ cwd: dir, atomicCommand: launcher, sessionId: `${name}-01a14fc7-024e-7169-b9c2` })
      await startAndStop({ cwd: dir, atomicCommand: launcher })
      assert.equal(readFileSync(join(dir, 'session-ids.txt'), 'utf8'), `${name}-01a14fc7-024e-7169-b9c2\n<none>\n`)
      rmSync(join(dir, 'session-ids.txt'))
    }
    assert.equal(existsSync(join(root, 'project')), false)
  } finally {
    if (previous === undefined) delete process.env.ATOMIC_ACP_PATH_TEST
    else process.env.ATOMIC_ACP_PATH_TEST = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'AtomicRpcProcess resumes the session ID through a simulated Windows cmd launcher',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'atomic-acp-cmd-'))
    writeFakeAtomic(root)
    const launcher = join(root, 'atomic.cmd')
    writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./fake-atomic.cjs')\n")
    chmodSync(launcher, 0o755)
    const dir = join(root, 'my project')
    mkdirSync(dir)
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      await startAndStop({ cwd: dir, atomicCommand: launcher, sessionId: 'restored-session' })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
    try {
      assert.equal(readFileSync(join(dir, 'session-ids.txt'), 'utf8'), 'restored-session\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
