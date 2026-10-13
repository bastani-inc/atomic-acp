import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakeAtomicReport = {
  pid: number
  args: string[]
  modes: Array<{ path: string; file: number; dir: number }>
  registered: Record<string, unknown>
  /** Result of each extension `tool_call` handler for a probe call to the named tool. */
  toolCallResults: Record<string, unknown[]>
}

/**
 * Write a fake `atomic --mode rpc` that loads every `-e` extension with a stub extension API,
 * probes its `tool_call` handlers and records what it saw, so tests observe what real Atomic
 * would receive. Returns the launcher path to use as `atomicCommand`.
 */
export function writeFakeAtomicCli(root: string): string {
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
      'const handlers = []',
      'const modes = []',
      'for (const path of extensions) {',
      '  modes.push({ path, file: statSync(path).mode & 0o777, dir: statSync(dirname(path)).mode & 0o777 })',
      '  const mod = await import(pathToFileURL(path).href)',
      '  mod.default({',
      '    registerMcpServer: (name, config) => { registered[name] = config },',
      '    on: (event, handler) => { if (event === "tool_call") handlers.push(handler) }',
      '  })',
      '}',
      'const toolCallResults = {}',
      'for (const toolName of ["ask_user_question", "bash"]) {',
      '  toolCallResults[toolName] = []',
      '  for (const handler of handlers) toolCallResults[toolName].push((await handler({ toolName, toolCallId: "probe", input: {} }, {})) ?? null)',
      '}',
      `writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, args, modes, registered, toolCallResults }))`,
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

export function readFakeAtomicReport(root: string): FakeAtomicReport {
  return JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as FakeAtomicReport
}
