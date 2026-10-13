import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type AdapterExtensionFile = {
  path: string
  /** Variables Atomic needs in its environment: the MCP env and header values the extension references. */
  env: Record<string, string>
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

/** An MCP server in Atomic's `mcpServers` shape. `env` and `headers` values are literal. */
export type AdapterMcpServer = { env?: Record<string, string>; headers?: Record<string, string> } & Record<
  string,
  unknown
>

export type AdapterExtensionOptions = {
  /** MCP servers registered with `pi.registerMcpServer`. */
  mcpServers?: Record<string, AdapterMcpServer>
  /** When set, `ask_user_question` calls are blocked with this reason as their tool result. */
  askUserQuestionUnavailable?: string
}

/**
 * Replace each env and header value with a `${NAME}` reference to a fresh environment variable that
 * holds the value. Atomic resolves the reference in memory and does not re-read the substituted
 * text, so values stay literal and never reach the extension source.
 */
function referenceSecretValues(servers: Record<string, AdapterMcpServer>): {
  servers: Record<string, AdapterMcpServer>
  env: Record<string, string>
} {
  const env: Record<string, string> = {}
  const reference = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        // Atomic treats an empty variable as unset, and an empty value holds no secret.
        if (value === '') return [key, '']
        const name = `ATOMIC_ACP_MCP_${randomBytes(12).toString('hex').toUpperCase()}`
        env[name] = value
        return [key, `\${${name}}`]
      })
    )
  const out = Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      {
        ...config,
        ...(config.env ? { env: reference(config.env) } : {}),
        ...(config.headers ? { headers: reference(config.headers) } : {})
      }
    ])
  )
  return { servers: out, env }
}

/**
 * Write the Atomic extension the adapter loads with `-e`, or return undefined when there is nothing
 * to add. MCP env and header values go into `env`, never into the file. The file still names
 * commands, args and URLs, so it lives in a private 0700 directory, is 0600, and is removed on
 * dispose or when the adapter exits.
 */
export function writeAdapterExtension(options: AdapterExtensionOptions): AdapterExtensionFile | undefined {
  const { servers, env } = referenceSecretValues(options.mcpServers ?? {})
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
    return { path, env, dispose: () => removeDir(dir) }
  } catch (error) {
    removeDir(dir)
    throw error
  }
}
