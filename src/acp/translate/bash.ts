import type { ToolCallContent } from '@agentclientprotocol/sdk'

type BashRecord = {
  command?: unknown
  cmd?: unknown
  args?: BashRecord
  input?: BashRecord
  rawInput?: BashRecord
  toolInput?: BashRecord
  details?: BashRecord
  content?: unknown
  stdout?: unknown
  stderr?: unknown
  output?: unknown
  exitCode?: unknown
  code?: unknown
}

export function isBashTool(name: string): boolean {
  return name.toLowerCase() === 'bash'
}

export function bashCommand(value: unknown): string | undefined {
  const record = value as BashRecord | null | undefined
  for (const source of [record, record?.args, record?.input, record?.rawInput, record?.toolInput, record?.details]) {
    const command = source?.command ?? source?.cmd
    if (typeof command === 'string' && command.trim()) return command
  }
  return undefined
}

export function bashResultText(value: unknown): string {
  const record = value as BashRecord | null | undefined
  if (Array.isArray(record?.content)) {
    const text = record.content
      .map((block: { type?: unknown; text?: unknown }) =>
        block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      )
      .join('')
    if (text) return text
  }
  const details = record?.details
  const stdout = details?.stdout ?? record?.stdout ?? details?.output ?? record?.output
  const stderr = details?.stderr ?? record?.stderr
  return [stdout, stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n')
}

export function bashExitCode(value: unknown, isError: boolean): number {
  const record = value as BashRecord | null | undefined
  const code = record?.details?.exitCode ?? record?.exitCode ?? record?.details?.code ?? record?.code
  return typeof code === 'number' ? code : isError ? 1 : 0
}

export function bashOutputDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next
}

export function bashTerminalContent(id: string): ToolCallContent[] {
  return [{ type: 'terminal', terminalId: id }]
}

// Display-only terminal metadata is a Zed extension, not client-side execution.
export function bashTerminalInfoMeta(id: string, cwd: string) {
  return { terminal_info: { terminal_id: id, cwd } }
}

export function bashTerminalOutputMeta(id: string, data: string) {
  return { terminal_output: { terminal_id: id, data } }
}

export function bashTerminalExitMeta(id: string, exitCode: number) {
  return { terminal_exit: { terminal_id: id, exit_code: exitCode, signal: null } }
}
