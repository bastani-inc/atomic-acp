import type { AvailableCommand } from '@agentclientprotocol/sdk'

export type AtomicRpcCommandInfo = {
  name?: unknown
  description?: unknown
  source?: unknown
  location?: unknown
  path?: unknown
}

function describeFallback(c: AtomicRpcCommandInfo): string {
  const source = typeof c.source === 'string' ? c.source : ''
  const location = typeof c.location === 'string' ? c.location : ''

  const parts: string[] = []
  if (source) parts.push(source)
  if (location) parts.push(location)

  return parts.length ? `(${parts.join(':')})` : '(command)'
}

export function toAvailableCommandsFromAtomicGetCommands(
  data: unknown,
  opts?: { enableSkillCommands?: boolean; includeExtensionCommands?: boolean }
): {
  commands: AvailableCommand[]
  raw: AtomicRpcCommandInfo[]
} {
  const enableSkillCommands = opts?.enableSkillCommands ?? true
  const includeExtensionCommands = opts?.includeExtensionCommands ?? true

  const root: any = data
  const commandsRaw: AtomicRpcCommandInfo[] = Array.isArray(root?.commands)
    ? root.commands
    : Array.isArray(root?.data?.commands)
      ? root.data.commands
      : []

  const out: AvailableCommand[] = []

  for (const c of commandsRaw) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name) continue

    const source = typeof c?.source === 'string' ? c.source : ''
    if (!includeExtensionCommands && source === 'extension') continue

    if (!enableSkillCommands && name.startsWith('skill:')) continue

    const desc = typeof c?.description === 'string' ? c.description.trim() : ''
    const usage = desc.match(/Usage:\s*\/\S+\s+(.+)$/i)?.[1]

    out.push({
      name,
      description: desc || describeFallback(c),
      ...(usage ? { input: { hint: usage } } : {})
    })
  }

  return { commands: out, raw: commandsRaw }
}
