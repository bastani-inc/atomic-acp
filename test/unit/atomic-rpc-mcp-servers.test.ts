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

    assert.deepEqual(report.resolved, {
      'run-tools': { env: { TOKEN: 'secret' } },
      docs: { headers: { Authorization: 'Bearer x' } }
    })
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

test('AtomicRpcProcess keeps MCP env and header values out of the extension, and Atomic resolves them literally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-mcp-'))
  let proc: AtomicRpcProcess | undefined
  try {
    const atomicCommand = writeFakeAtomic(root)
    const secret = 'secret-6c1d0b'
    const env = {
      TOKEN: secret,
      TEMPLATE: '${HOME} $USER $$ ${ATOMIC_ACP_NOPE',
      COMMAND: '!echo pwned',
      EMPTY: ''
    }
    const headers = { Authorization: `Bearer ${secret}`, 'X-Command': '!echo header-command-ran' }
    proc = await AtomicRpcProcess.spawn({
      cwd: root,
      atomicCommand,
      mcpServers: {
        tools: { command: 'node', args: ['server.js'], env, exposure: 'direct' },
        web: { url: 'https://example.com/mcp', headers, exposure: 'direct' }
      }
    })
    const report = readReport(root)

    assert.deepEqual(report.resolved, { tools: { env }, web: { headers } })
    const [source] = report.sources
    assert.ok(source?.includes('https://example.com/mcp'), 'names, commands and URLs stay in the extension')
    for (const value of [secret, '${HOME}', '!echo pwned', '!echo header-command-ran']) {
      assert.ok(!source.includes(value), `extension source must not contain ${value}`)
    }
    assert.equal(report.disableCompileCache, '1', "Node's compile cache must not keep a copy of the extension")
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
