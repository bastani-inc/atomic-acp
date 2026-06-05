import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from Atomic's own ~/.atomic/agent/* directory.
 */
export function getAtomicAcpDir(): string {
  return join(homedir(), '.atomic', 'atomic-acp')
}

export function getAtomicAcpSessionMapPath(): string {
  return join(getAtomicAcpDir(), 'session-map.json')
}
