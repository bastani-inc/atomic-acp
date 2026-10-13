import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

// Fake `atomic --mode rpc` that loads every `-e` extension with a stub extension API and
// records what it saw, so the test observes what real Atomic would receive.
function writeFakeAtomic(root: string): string {
  const report = join(root, 'report.json')
  writeFileSync(
    join(root, 'fake-atomic.mjs'),
    [
      "import { statSync, writeFileSync } from 'node:fs'",
      "import { dirname } from 'node:path'",
      "import { createInterface } from 'node:readline'",
      "import { pathToFileURL } from 'node:url'",
      'const args = process.argv.slice(2)',
      'const extensions = args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []))',
      'const registered = {}',
      'const modes = []',
      'for (const path of extensions) {',
      '  modes.push({ path, file: statSync(path).mode & 0o777, dir: statSync(dirname(path)).mode & 0o777 })',
      '  const mod = await import(pathToFileURL(path).href)',
      '  mod.default({ registerMcpServer: (name, config) => { registered[name] = config } })',
      '}',
      `writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, args, modes, registered }))`,
      'createInterface({ input: process.stdin }).on("line", line => {',
      '  const command = JSON.parse(line)',
      '  process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: {} }) + "\\n")',
      '})'
    ].join('\n')
  )
  const launcher = join(root, process.platform === 'win32' ? 'atomic.cmd' : 'atomic')
  if (process.platform === 'win32') {
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${join(root, 'fake-atomic.mjs')}" %*\r\n`)
  } else {
    writeFileSync(launcher, "#!/usr/bin/env node\nimport('./fake-atomic.mjs')\n")
    chmodSync(launcher, 0o755)
  }
  return launcher
}

type Report = {
  pid: number
  args: string[]
  modes: Array<{ path: string; file: number; dir: number }>
  registered: Record<string, unknown>
}

function readReport(root: string): Report {
  return JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as Report
}

test('AtomicRpcProcess registers MCP servers through a private extension removed on dispose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-mcp-'))
  let proc: AtomicRpcProcess | undefined
  try {
    const atomicCommand = writeFakeAtomic(root)
    const mcpServers = {
      'run-tools': { command: 'node', args: ['server.js'], env: { TOKEN: 'secret' }, exposure: 'direct' },
      docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, exposure: 'direct' }
    }

    proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand, mcpServers })
    const report = readReport(root)

    assert.deepEqual(report.registered, mcpServers)
    assert.equal(report.modes.length, 1)
    const extension = report.modes[0]!
    if (process.platform !== 'win32') {
      assert.equal(extension.file, 0o600)
      assert.equal(extension.dir, 0o700)
    }
    assert.ok(existsSync(extension.path))

    proc.dispose()
    assert.equal(existsSync(extension.path), false, 'extension file must be deleted when the session ends')
  } finally {
    proc?.dispose('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('AtomicRpcProcess deletes the MCP extension when Atomic exits on its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-mcp-'))
  let proc: AtomicRpcProcess | undefined
  try {
    const atomicCommand = writeFakeAtomic(root)
    proc = await AtomicRpcProcess.spawn({
      cwd: root,
      atomicCommand,
      mcpServers: { a: { command: 'x', args: [], env: {}, exposure: 'direct' } }
    })
    const report = readReport(root)
    const { path } = report.modes[0]!
    const exited = new Promise<void>(resolve => proc!.onExit(() => resolve()))
    process.kill(report.pid, 'SIGKILL')
    await exited
    assert.equal(existsSync(path), false)
  } finally {
    proc?.dispose('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('AtomicRpcProcess passes no extension when there are no MCP servers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-mcp-'))
  let proc: AtomicRpcProcess | undefined
  try {
    const atomicCommand = writeFakeAtomic(root)
    proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand, mcpServers: {} })
    proc.dispose()
    assert.deepEqual(readReport(root).modes, [])
    assert.ok(!readReport(root).args.includes('-e'))
  } finally {
    proc?.dispose('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
