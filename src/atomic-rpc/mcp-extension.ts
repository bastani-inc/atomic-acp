import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type McpExtensionFile = {
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

/**
 * Write an Atomic extension that registers `servers` with `pi.registerMcpServer`. The servers can
 * carry secrets in env and headers, so the file lives in a private 0700 directory, is 0600, and is
 * removed on dispose or when the adapter exits.
 */
export function writeMcpServersExtension(servers: Record<string, object>): McpExtensionFile {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-acp-mcp-'))
  liveDirs.add(dir)
  installExitHook()
  try {
    chmodSync(dir, 0o700)
    const path = join(dir, 'acp-mcp-servers.mjs')
    const source = [
      `const servers = ${JSON.stringify(servers)}`,
      'export default function (pi) {',
      '  for (const [name, config] of Object.entries(servers)) pi.registerMcpServer(name, config)',
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
