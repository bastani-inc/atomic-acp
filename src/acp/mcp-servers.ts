import { RequestError, type McpServer } from '@agentclientprotocol/sdk'

/** One entry in Atomic's `mcpServers` configuration shape (see Atomic docs/mcp-servers.md). */
export type AtomicMcpServerConfig =
  | { command: string; args: string[]; env: Record<string, string>; exposure: 'direct' }
  | { url: string; headers: Record<string, string>; exposure: 'direct' }

export type AtomicMcpServers = Record<string, AtomicMcpServerConfig>

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Values stay literal: `AtomicRpcProcess` hands env and header values to Atomic so it never interprets them. */
function toRecord(entries: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(entries.map(entry => [entry.name, entry.value]))
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HEADER_VALUE_BREAK = /[\r\n\0]/
// Atomic expands these in MCP URLs with no escape, so a client URL could pull in the host's variables.
const URL_ENV_REFERENCE = /\$\{|\$env:/i

/**
 * Refuse what Atomic cannot use safely: header names that aren't HTTP tokens, header values with
 * CR, LF or NUL (Atomic's error would echo them), URLs with env references, and env values with NUL.
 * Errors name the server and the header or variable, never a value.
 */
function assertUsable(server: McpServer): void {
  const refuse = (reason: string): never => {
    throw RequestError.invalidParams(undefined, `MCP server ${JSON.stringify(server.name)} refused: ${reason}`)
  }
  if ('type' in server && server.type === 'http') {
    if (URL_ENV_REFERENCE.test(server.url)) refuse('its URL contains an environment reference (${...} or $env:)')
    for (const { name, value } of server.headers ?? []) {
      if (!HEADER_NAME.test(name)) refuse(`header name ${JSON.stringify(name)} is not a valid HTTP header name`)
      if (HEADER_VALUE_BREAK.test(value)) refuse(`header ${JSON.stringify(name)} has a CR, LF or NUL in its value`)
    }
  } else if ('command' in server) {
    for (const { name, value } of server.env ?? []) {
      if (value.includes('\0')) refuse(`env ${JSON.stringify(name)} has a NUL in its value`)
    }
  }
}

function namespaceOf(name: string): string {
  return name.replace(/-/g, '_')
}

function uniqueServerName(requested: string, taken: Set<string>): string {
  let base = requested.replace(/[^A-Za-z0-9_-]/g, '_') || 'mcp'
  if (RESERVED_NAMES.has(base)) base = `${base}_`
  let name = base
  for (let n = 2; taken.has(namespaceOf(name)); n += 1) name = `${base}_${n}`
  taken.add(namespaceOf(name))
  return name
}

/**
 * Map ACP `mcpServers` to Atomic MCP server registrations. Tools use `direct` exposure so the
 * model can call them by name. Transports Atomic lacks (SSE, ACP) are skipped with a warning that
 * names the server but never its env or headers. Throws invalidParams for a server that
 * `assertUsable` refuses, before anything is built.
 */
export function toAtomicMcpServers(servers: readonly McpServer[]): {
  servers: AtomicMcpServers
  warnings: string[]
} {
  const out = new Map<string, AtomicMcpServerConfig>()
  const warnings: string[] = []
  const taken = new Set<string>()
  for (const server of servers) assertUsable(server)

  for (const server of servers) {
    if ('type' in server && server.type === 'http') {
      out.set(uniqueServerName(server.name, taken), {
        url: server.url,
        headers: toRecord(server.headers ?? []),
        exposure: 'direct'
      })
    } else if ('type' in server && server.type === 'sse') {
      warnings.push(`MCP server "${server.name}" skipped: Atomic does not support the SSE transport`)
    } else if ('command' in server) {
      out.set(uniqueServerName(server.name, taken), {
        command: server.command,
        args: [...(server.args ?? [])],
        env: toRecord(server.env ?? []),
        exposure: 'direct'
      })
    } else {
      const type = 'type' in server ? String(server.type) : 'unknown'
      warnings.push(`MCP server "${server.name}" skipped: Atomic does not support the ${type} transport`)
    }
  }

  return { servers: Object.fromEntries(out), warnings }
}

/** Map ACP servers for `AtomicRpcProcess.spawn`, reporting skipped servers on stderr. */
export function atomicMcpServersForSpawn(servers: readonly McpServer[] | undefined): AtomicMcpServers {
  const { servers: mapped, warnings } = toAtomicMcpServers(servers ?? [])
  for (const warning of warnings) process.stderr.write(`atomic-acp: ${warning}\n`)
  return mapped
}

/** Whether two ACP server lists configure the same Atomic MCP servers. */
export function sameMcpServers(a: readonly McpServer[] | undefined, b: readonly McpServer[] | undefined): boolean {
  return JSON.stringify(toAtomicMcpServers(a ?? []).servers) === JSON.stringify(toAtomicMcpServers(b ?? []).servers)
}
