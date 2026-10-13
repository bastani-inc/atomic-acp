import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type AdapterExtensionFile = {
  path: string
  /** Variables Atomic needs in its environment: the MCP env and header values the extension references. */
  env: Record<string, string>
  /**
   * Delete the extension and its directory once Atomic has exited. Retries while the directory is
   * busy (Windows) and never rejects. Safe to call more than once.
   */
  dispose(): Promise<void>
}

export type AdapterExtensionCleanup = {
  /** Removes a directory tree; defaults to `fs.promises.rm` with `recursive` and `force`. */
  rm?: (dir: string) => Promise<void>
  /** Waits between removal attempts; one attempt more than there are delays. */
  retryDelaysMs?: readonly number[]
}

/** Windows refuses to remove a directory while a process still holds a file in it. */
const RETRYABLE_RM_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])
const RM_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600]

const liveDirs = new Set<string>()
let exitHookInstalled = false

function removeDirNow(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
    liveDirs.delete(dir)
  } catch {
    // best effort
  }
}

async function removeDir(dir: string, cleanup: AdapterExtensionCleanup): Promise<void> {
  const removeTree = cleanup.rm ?? ((path: string) => rm(path, { recursive: true, force: true }))
  const delays = cleanup.retryDelaysMs ?? RM_RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt++) {
    try {
      await removeTree(dir)
      liveDirs.delete(dir)
      return
    } catch (error) {
      const delay = delays[attempt]
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      // Give up quietly; the exit hook tries once more when the adapter exits.
      if (delay === undefined || code === undefined || !RETRYABLE_RM_CODES.has(code)) return
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const dir of [...liveDirs]) removeDirNow(dir)
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
export function writeAdapterExtension(
  options: AdapterExtensionOptions,
  cleanup: AdapterExtensionCleanup = {}
): AdapterExtensionFile | undefined {
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
    let removal: Promise<void> | undefined
    return { path, env, dispose: () => (removal ??= removeDir(dir, cleanup)) }
  } catch (error) {
    removeDirNow(dir)
    throw error
  }
}
