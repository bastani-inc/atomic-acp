import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getAtomicAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  updatedAt: string
}

export type SessionMapping = { sessionId: string; cwd: string }

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      return { version: 1, sessions: {} }
    }
    return parsed
  } catch {
    return { version: 1, sessions: {} }
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path)
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export class SessionStore {
  private readonly path: string

  constructor(path = getAtomicAcpSessionMapPath()) {
    this.path = path
  }

  get(sessionId: string): StoredSession | null {
    const db = loadFile(this.path)
    return db.sessions[sessionId] ?? null
  }

  upsert(entry: SessionMapping): void {
    this.upsertMany([entry])
  }

  /** Record which project each session belongs to; the map is rewritten only when an entry changes. */
  upsertMany(entries: readonly SessionMapping[]): void {
    const db = loadFile(this.path)
    let changed = false
    for (const { sessionId, cwd } of entries) {
      if (db.sessions[sessionId]?.cwd === cwd) continue
      db.sessions[sessionId] = { sessionId, cwd, updatedAt: new Date().toISOString() }
      changed = true
    }
    if (changed) saveFile(this.path, db)
  }

  delete(sessionId: string): void {
    const db = loadFile(this.path)
    if (!db.sessions[sessionId]) return
    delete db.sessions[sessionId]
    saveFile(this.path, db)
  }
}
