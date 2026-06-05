import { platform } from 'node:os'

export function defaultAtomicCommand(): string {
  return platform() === 'win32' ? 'atomic.cmd' : 'atomic'
}

export function getAtomicCommand(override?: string): string {
  return override ?? defaultAtomicCommand()
}

export function shouldUseShellForAtomicCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}
