import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import {
  readFakeAtomicReport as readReport,
  writeFakeAtomicCli as writeFakeAtomic
} from '../helpers/fake-atomic-cli.js'

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
