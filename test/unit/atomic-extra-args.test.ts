import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAtomicExtraArgs } from '../../src/atomic-rpc/command.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

const node = process.execPath
const entry = '/usr/lib/atomic-acp/dist/index.js'

test('parseAtomicExtraArgs: takes args after -- and from ATOMIC_ACP_ATOMIC_ARGS', () => {
  assert.deepEqual(parseAtomicExtraArgs([node, entry], {}), [])
  assert.deepEqual(parseAtomicExtraArgs([node, entry, '--', '--model', 'openai/gpt-6', '-e', './ext.ts'], {}), [
    '--model',
    'openai/gpt-6',
    '-e',
    './ext.ts'
  ])
  assert.deepEqual(
    parseAtomicExtraArgs([node, entry, '--', '--thinking', 'high'], {
      ATOMIC_ACP_ATOMIC_ARGS: '["--model","a b; rm -rf ~","--extension","$HOME/x.ts"]'
    }),
    ['--model', 'a b; rm -rf ~', '--extension', '$HOME/x.ts', '--thinking', 'high']
  )
})

test('parseAtomicExtraArgs: rejects malformed ATOMIC_ACP_ATOMIC_ARGS', () => {
  for (const value of ['--model x', '{"a":1}', '[1]', '["ok", null]', '["a\\u0000b"]']) {
    assert.throws(
      () => parseAtomicExtraArgs([node, entry], { ATOMIC_ACP_ATOMIC_ARGS: value }),
      /ATOMIC_ACP_ATOMIC_ARGS/
    )
  }
})

test('parseAtomicExtraArgs: rejects args that would take RPC mode or the session away from the adapter', () => {
  for (const arg of ['--mode', '--mode=text', '-p', '--print', '--session', '--no-session', '--continue', '--', '-h']) {
    assert.throws(() => parseAtomicExtraArgs([node, entry, '--', arg], {}), /not allowed/)
  }
})

test('AtomicRpcProcess.spawn appends extra args verbatim without a shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-args-'))
  let proc: AtomicRpcProcess | undefined
  try {
    const report = join(root, 'argv.json')
    writeFileSync(
      join(root, 'fake-atomic.mjs'),
      [
        "import { writeFileSync } from 'node:fs'",
        "import { createInterface } from 'node:readline'",
        `writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.argv.slice(2)))`,
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

    const extraArgs = ['--model', 'a b; echo pwned', '-e', '$HOME/ext.ts']
    proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand: launcher, extraArgs })
    const argv = JSON.parse(readFileSync(report, 'utf8')) as string[]
    assert.deepEqual(argv.slice(0, 3), ['--mode', 'rpc', '--no-themes'])
    assert.deepEqual(argv.slice(-extraArgs.length), extraArgs)
  } finally {
    proc?.dispose('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
