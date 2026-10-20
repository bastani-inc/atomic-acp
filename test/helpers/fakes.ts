import type { AgentSideConnection, CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { AtomicExtensionUiResponse, AtomicRpcEvent } from '../../src/atomic-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly elicitationRequests: CreateElicitationRequest[] = []
  elicitationResponses: Array<CreateElicitationResponse | Promise<CreateElicitationResponse>> = []
  readonly permissionRequests: Parameters<AgentSideConnection['requestPermission']>[0][] = []
  nextPermissionResponse: Awaited<ReturnType<AgentSideConnection['requestPermission']>> = {
    outcome: { outcome: 'cancelled' }
  }

  async requestPermission(params: Parameters<AgentSideConnection['requestPermission']>[0]) {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    this.elicitationRequests.push(params)
    const response = this.elicitationResponses.shift()
    if (!response) return { action: 'cancel' }
    return response
  }
}

export class FakeAtomicRpcProcess {
  private handlers: Array<(ev: AtomicRpcEvent) => void> = []
  private exitHandlers: Array<(err: Error) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: AtomicExtensionUiResponse[] = []
  promptError: unknown = null
  promptPromise: Promise<void> | null = null
  promptDisposition: 'started' | 'queued' | 'handled' | undefined
  abortCount = 0

  onEvent(handler: (ev: AtomicRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: AtomicRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  onExit(handler: (err: Error) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  hasExited = false

  exit(err = new Error('Atomic process exited')) {
    this.hasExited = true
    for (const h of this.exitHandlers) h(err)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<'started' | 'queued' | 'handled' | undefined> {
    this.prompts.push({ message, attachments })
    if (this.promptPromise) await this.promptPromise
    if (this.promptError) throw this.promptError
    return this.promptDisposition
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async writeExtensionUiResponse(response: AtomicExtensionUiResponse): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  /** Reasons of each `start_pending_recovery`; set `recoveryError` to fail them like an Atomic without the command. */
  readonly recoveryRequests: string[] = []
  recoveryError: unknown = null

  async startPendingRecovery(reason: string): Promise<unknown> {
    this.recoveryRequests.push(reason)
    if (this.recoveryError) throw this.recoveryError
    return { replayed: 0, dropped: 0, completions: 0, notices: [] }
  }

  /** The project's saved sessions, as `list_sessions` reports them; fakes may share one list as their store. */
  sessions: Array<Record<string, unknown>> = []
  /** The session this Atomic has open, which `delete_session` refuses like Atomic does. */
  openSessionId: string | undefined

  async listSessions(): Promise<any> {
    return { sessions: this.sessions }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (sessionId === this.openSessionId) {
      throw new Error(`Atomic delete_session failed: Cannot delete the session that is currently open: ${sessionId}`)
    }
    const index = this.sessions.findIndex(session => session.id === sessionId)
    if (index !== -1) this.sessions.splice(index, 1)
  }

  disposeCount = 0

  async dispose(): Promise<void> {
    this.disposeCount += 1
    this.hasExited = true
  }
}

/** A saved session as Atomic's `list_sessions` reports it. */
export function listedSession(
  id: string,
  cwd: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    path: id,
    id,
    cwd,
    created: '2026-10-01T00:00:00.000Z',
    modified: '2026-10-01T00:00:02.000Z',
    messageCount: 2,
    firstMessage: 'Hello',
    allMessagesText: 'Hello Hi there!',
    ...overrides
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by AtomicAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
