import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'

/** A fake Atomic that records every command type it receives, and refuses the capability command when told to. */
function writeFakeAtomic(root: string, refuseCapabilities: boolean): string {
  const fixture = join(root, 'fake-atomic.cjs')
  writeFileSync(
    fixture,
    [
      "const { appendFileSync } = require('node:fs')",
      "const readline = require('node:readline')",
      `const log = ${JSON.stringify(join(root, 'commands.txt'))}`,
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      'const command = JSON.parse(line)',
      "appendFileSync(log, command.type + (command.questionnaire === undefined ? '' : ':' + command.questionnaire) + '\\n')",
      `const refused = ${refuseCapabilities} && command.type === 'set_extension_ui_capabilities'`,
      "process.stdout.write(JSON.stringify(refused ? { type: 'response', id: command.id, command: command.type, success: false, error: 'Unknown command' } : { type: 'response', id: command.id, command: command.type, success: true, data: {} }) + '\\n')",
      '})'
    ].join('\n')
  )
  return fixture
}

async function commandsSent(params: { answersQuestionnaires?: boolean; headless?: boolean }, refuse = false) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-questionnaire-'))
  try {
    const fixture = writeFakeAtomic(root, refuse)
    const launcher = join(root, process.platform === 'win32' ? 'atomic.cmd' : 'atomic')
    writeFileSync(
      launcher,
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
      { mode: 0o755 }
    )
    const proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand: launcher, extraArgs: [], ...params })
    await proc.dispose()
    return readFileSync(join(root, 'commands.txt'), 'utf8').trim().split('\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('Atomic is told the client answers ask_user_question when the client has forms', async () => {
  assert.deepEqual(await commandsSent({ answersQuestionnaires: true }), [
    'get_state',
    'set_extension_ui_capabilities:true'
  ])
})

test('without forms, or headless, Atomic is not told to send questionnaires', async () => {
  assert.deepEqual(await commandsSent({}), ['get_state'])
  assert.deepEqual(await commandsSent({ answersQuestionnaires: true, headless: true }), ['get_state'])
})

test('an Atomic that refuses the capability command still starts', async () => {
  assert.deepEqual(await commandsSent({ answersQuestionnaires: true }, true), [
    'get_state',
    'set_extension_ui_capabilities:true'
  ])
})
