import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type AdapterExtensionFile = {
  path: string
  /** Delete the extension and its directory. Safe to call more than once. */
  dispose(): void
}

const liveDirs = new Set<string>()
let exitHookInstalled = false

function removeDir(dir: string): void {
  liveDirs.delete(dir)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const dir of [...liveDirs]) removeDir(dir)
  })
}

export type AdapterExtensionOptions = {
  /** MCP servers in Atomic's `mcpServers` shape, registered with `pi.registerMcpServer`. */
  mcpServers?: Record<string, object>
  /** When set, `ask_user_question` calls are blocked with this reason as their tool result. */
  askUserQuestionUnavailable?: string
}

/**
 * Write the Atomic extension the adapter loads with `-e`, or return undefined when there is nothing
 * to add. MCP servers can carry secrets in env and headers, so the file lives in a private 0700
 * directory, is 0600, and is removed on dispose or when the adapter exits.
 */
export function writeAdapterExtension(options: AdapterExtensionOptions): AdapterExtensionFile | undefined {
  const servers = options.mcpServers ?? {}
  const askReason = options.askUserQuestionUnavailable
  if (Object.keys(servers).length === 0 && askReason === undefined) return undefined
  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-ext-'))
  liveDirs.add(dir)
  installExitHook()
  try {
    chmodSync(dir, 0o700)
    const path = join(dir, 'atomic-acp.mjs')
    const source = [
      `const servers = ${JSON.stringify(servers)}`,
      `const askUserQuestionUnavailable = ${JSON.stringify(askReason ?? null)}`,
      'export default function (pi) {',
      '  for (const [name, config] of Object.entries(servers)) pi.registerMcpServer(name, config)',
      '  if (askUserQuestionUnavailable !== null) {',
      '    pi.on("tool_call", event => {',
      '      if (event.toolName === "ask_user_question") return { block: true, reason: askUserQuestionUnavailable }',
      '    })',
      '  }',
      '}',
      ''
    ].join('\n')
    writeFileSync(path, source, { mode: 0o600 })
    return { path, dispose: () => removeDir(dir) }
  } catch (error) {
    removeDir(dir)
    throw error
  }
}
