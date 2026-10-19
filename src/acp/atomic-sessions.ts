import { promptToSessionTitle } from './translate/prompt.js'

export type AtomicSessionListItem = {
  sessionId: string
  cwd: string
  /** The session name, `''` once a name was cleared, else a title from the first message. */
  title: string | null
  updatedAt: string | null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isoDate(value: unknown): string | null {
  const date = typeof value === 'string' ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function sessionTitle(info: Record<string, unknown>, messageCount: number): string | null {
  const name = str(info.name)?.trim()
  if (name || info.hasName === true) return name ?? ''
  const firstMessage = messageCount > 0 ? str(info.firstMessage) : undefined
  return firstMessage ? promptToSessionTitle([{ type: 'text', text: firstMessage }]) : null
}

/**
 * Sessions from Atomic's `list_sessions` response, most recently modified first. Like Atomic's
 * `/resume` picker, sessions with no messages, name or summary are left out: every Atomic start
 * saves a session before its first prompt.
 */
export function parseAtomicSessionList(data: unknown): AtomicSessionListItem[] {
  const sessions = (data as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(sessions)) return []
  const items: AtomicSessionListItem[] = []
  for (const raw of sessions) {
    const info = (raw ?? {}) as Record<string, unknown>
    const sessionId = str(info.id)
    const cwd = str(info.cwd)
    if (sessionId === undefined || !cwd) continue
    const messageCount = typeof info.messageCount === 'number' ? info.messageCount : 0
    const title = sessionTitle(info, messageCount)
    if (messageCount === 0 && title === null && info.summary === undefined) continue
    items.push({ sessionId, cwd, title, updatedAt: isoDate(info.modified) })
  }
  return items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}
