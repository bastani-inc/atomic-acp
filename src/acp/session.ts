import {
  requestExtensionDialog,
  NO_CLIENT_ELICITATION_SUPPORT,
  type ClientElicitationSupport
} from './elicitation/extension-dialog.js'
import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { maybeAuthRequiredError } from './auth-required.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import {
  AtomicRpcProcess,
  AtomicRpcSpawnError,
  type AtomicExtensionUiResponse,
  type AtomicRpcEvent,
  type AtomicSessionStats,
  SESSION_STATS_TIMEOUT_MS
} from '../atomic-rpc/process.js'
import { SessionStore } from './session-store.js'
import { toolResultToText } from './translate/atomic-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import { atomicMcpServersForSpawn } from './mcp-servers.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  atomicCommand?: string
  clientElicitationSupport?: ClientElicitationSupport
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  title?: string
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

function toUsageUpdate(stats: AtomicSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null
  return { sessionUpdate: 'usage_update', used, size }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getMutationPaths(args: unknown): string[] {
  const record = args as { path?: unknown; file_path?: unknown; input?: unknown } | null
  const path = record?.path ?? record?.file_path
  if (typeof path === 'string') return [path]
  if (typeof record?.input !== 'string') return []
  return [...record.input.matchAll(/^\[(.+)#[0-9a-fA-F]{4}\]\s*$/gm)].map(match => match[1]!)
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const paths = getMutationPaths(args)
  if (!paths.length) return undefined
  return paths.map(path => ({
    path: isAbsolute(path) ? path : resolvePath(cwd, path),
    ...(typeof line === 'number' ? { line } : {})
  }))
}

export class SessionManager {
  private sessions = new Map<string, AtomicAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying Atomic subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): AtomicAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying Atomic process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh Atomic subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<AtomicAcpSession> {
    // Let Atomic manage session persistence in its default location (~/.atomic/agent/sessions/...)
    // so sessions are visible to the regular `atomic` CLI.
    let proc: AtomicRpcProcess
    try {
      proc = await AtomicRpcProcess.spawn({
        cwd: params.cwd,
        atomicCommand: params.atomicCommand,
        mcpServers: atomicMcpServersForSpawn(params.mcpServers)
      })
    } catch (e) {
      if (e instanceof AtomicRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new AtomicAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      autoTitle: true,
      clientElicitationSupport: params.clientElicitationSupport
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): AtomicAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: AtomicRpcProcess }): AtomicAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new AtomicAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      clientElicitationSupport: params.clientElicitationSupport
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class AtomicAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false
  private initialTitlePending: boolean
  private lastPublishedTitle: string | null | undefined
  private titleUpdateQueue: Promise<void> = Promise.resolve()

  readonly proc: AtomicRpcProcess
  private readonly conn: AgentSideConnection
  private readonly clientElicitationSupport: ClientElicitationSupport
  private fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some Atomic events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // Retries and queued continuations may emit multiple agent_end events before settlement.
  private inAgentLoop = false
  private backgroundTurn = false

  private fileSnapshots = new Map<string, Array<{ path: string; oldText: string | null }>>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  private pendingExtensionDialogs = new Map<string, () => Promise<void>>()
  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: AtomicRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    clientElicitationSupport?: ClientElicitationSupport
    autoTitle?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.clientElicitationSupport = opts.clientElicitationSupport ?? NO_CLIENT_ELICITATION_SUPPORT
    this.fileCommands = opts.fileCommands ?? []

    this.initialTitlePending = opts.autoTitle ?? false
    this.proc.onEvent(ev => this.handleAtomicEvent(ev))
    this.proc.onExit?.(err => this.handleAtomicExit(err))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  setFileCommands(fileCommands: FileSlashCommand[]) {
    this.fileCommands = fileCommands
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  private sendStartupInfoOnFirstPromptIfPending(): void {
    this.sendStartupInfoIfPending()
  }

  async prompt(message: string, images: unknown[] = [], title?: string): Promise<StopReason> {
    // Keep a prompt-path fallback because some clients may ignore the best-effort
    // pre-prompt notification sent right after session/new.
    this.sendStartupInfoOnFirstPromptIfPending()

    // Atomic RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, title, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { atomicAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { atomicAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    await this.cancelPendingExtensionDialogs()

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  async setSessionName(name: string): Promise<void> {
    return this.enqueueTitleUpdate(async () => {
      await this.proc.setSessionName(name)
      await this.publishTitle(name)
    })
  }

  private enqueueTitleUpdate(update: () => Promise<void>): Promise<void> {
    const result = this.titleUpdateQueue.then(update)
    this.titleUpdateQueue = result.catch(() => {})
    return result
  }

  publishTitle(title: string | null, updatedAt: string | null = new Date().toISOString()): Promise<void> {
    if (this.lastPublishedTitle === title) return this.lastEmit
    this.lastPublishedTitle = title
    this.emit({
      sessionUpdate: 'session_info_update',
      title,
      ...(updatedAt ? { updatedAt } : {})
    })
    return this.lastEmit
  }

  private async maybeAutoTitle(title?: string): Promise<void> {
    if (!this.initialTitlePending || !title) return
    this.initialTitlePending = false
    try {
      await this.enqueueTitleUpdate(async () => {
        const state = (await this.proc.getState()) as { sessionName?: unknown } | null
        const currentTitle = typeof state?.sessionName === 'string' ? state.sessionName.trim() : ''
        if (currentTitle) {
          await this.publishTitle(currentTitle)
          return
        }
        if (this.lastPublishedTitle !== undefined) return
        await this.proc.setSessionName(title)
        await this.publishTitle(title)
      })
    } catch {
      // Naming is best-effort and must not fail the prompt.
    }
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private emitAgentText(text: string): void {
    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text }
    })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  async publishContextUsage(): Promise<void> {
    try {
      if (typeof this.proc.getSessionStats === 'function') {
        const update = toUsageUpdate(await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS))
        if (update) this.emit(update)
      }
    } catch {
      // Context usage is auxiliary; it must not fail a prompt.
    }
    await this.flushEmits()
  }

  private emitBashToolCall(id: string, name: string, args: unknown, status: 'pending' | 'in_progress'): void {
    const exists = this.currentToolCalls.has(id)
    this.currentToolCalls.set(id, status)
    this.bashToolCallIds.add(id)
    this.emit({
      sessionUpdate: exists ? 'tool_call_update' : 'tool_call',
      toolCallId: id,
      title: bashCommand(args) ?? name,
      kind: 'execute',
      status,
      ...(!exists ? { content: bashTerminalContent(id), _meta: bashTerminalInfoMeta(id, this.cwd) } : {})
    })
  }

  private emitBashOutput(
    id: string,
    result: unknown,
    status: 'in_progress' | 'completed' | 'failed',
    isError = false
  ): void {
    const text = bashResultText(result)
    const delta = bashOutputDelta(this.bashOutputSnapshots.get(id) ?? '', text)
    this.bashOutputSnapshots.set(id, text)
    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(id, delta) : {}),
        ...(status !== 'in_progress' ? bashTerminalExitMeta(id, bashExitCode(result, isError)) : {})
      }
    })
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    // Independent workflow runs may still be streaming when a new prompt arrives.

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }
    void this.maybeAutoTitle(t.title)

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { atomicAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off Atomic, but completion is determined by Atomic events, not the RPC response.
    // Started or queued prompts finish at agent_settled; handled commands start no turn.
    const pending = this.pendingTurn
    this.proc
      .prompt(t.message, t.images, 'followUp')
      .then(async disposition => {
        if (disposition !== 'handled' || this.pendingTurn !== pending) return
        if (this.inAgentLoop) this.backgroundTurn = true
        await this.publishContextUsage()
        if (this.pendingTurn !== pending) return
        pending.resolve(this.cancelRequested ? 'cancelled' : 'end_turn')
        this.pendingTurn = null
        const next = this.turnQueue.shift()
        if (next) this.startTurn(next)
        else {
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { atomicAcp: { queueDepth: 0, running: false } }
          })
        }
      })
      .catch(err => {
        void this.finishActiveAndQueuedFromFailure(err)
      })
  }

  private async finishActiveAndQueuedFromFailure(err: unknown): Promise<void> {
    await this.cancelPendingExtensionDialogs()

    await this.flushEmits()
    if (!this.pendingTurn && this.turnQueue.length === 0) return

    const authErr = maybeAuthRequiredError(err)
    const queued = this.turnQueue.splice(0)
    if (authErr) {
      this.pendingTurn?.reject(authErr)
      for (const queuedTurn of queued) queuedTurn.reject(authErr)
    } else {
      const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
      this.pendingTurn?.resolve(reason)
      for (const queuedTurn of queued) queuedTurn.resolve(reason)
    }

    this.pendingTurn = null
    this.inAgentLoop = false

    // If the prompt failed, do not automatically proceed—Atomic may be unhealthy.
    // Drain any queued requests so no client request is left hanging.
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { atomicAcp: { queueDepth: 0, running: false } }
    })
  }

  private handleAtomicExit(err: Error): void {
    void this.cancelPendingExtensionDialogs()

    if (!this.pendingTurn && this.turnQueue.length === 0) return
    void this.finishActiveAndQueuedFromFailure(err)
  }

  private async cancelPendingExtensionDialogs(): Promise<void> {
    await Promise.all([...this.pendingExtensionDialogs.values()].map(cancel => cancel()))
  }

  private async writeExtensionUiResponse(response: AtomicExtensionUiResponse): Promise<void> {
    try {
      await this.proc.writeExtensionUiResponse(response)
    } catch {
      this.emitAgentText('Atomic could not receive a structured question response.')
    }
  }

  private async handleExtensionUiRequest(ev: AtomicRpcEvent): Promise<void> {
    const id = typeof ev.id === 'string' ? ev.id : null
    if (!id) return
    const method = ev.method
    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: typeof ev.message === 'string' ? ev.message : 'Atomic notification' },
        _meta: {
          atomicAcp: {
            notify: {
              level: ev.notifyType === 'warning' || ev.notifyType === 'error' ? ev.notifyType : 'info'
            }
          }
        }
      })
      return
    }
    if (!['select', 'confirm', 'input', 'editor'].includes(String(method))) return
    if (this.pendingExtensionDialogs.has(id)) return
    if (!this.clientElicitationSupport.form && (method === 'input' || method === 'editor')) {
      this.emitAgentText(`Atomic ${method} UI request is not supported in ACP yet; cancelling it.`)
    }
    if (this.cancelRequested) {
      await this.writeExtensionUiResponse({ type: 'extension_ui_response', id, cancelled: true })
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const completion = Promise.resolve().then(async () => {
      try {
        const response = await requestExtensionDialog(
          this.conn,
          this.sessionId,
          ev,
          this.clientElicitationSupport.form,
          controller.signal
        )
        if (timer) clearTimeout(timer)
        await this.writeExtensionUiResponse(response)
      } finally {
        if (timer) clearTimeout(timer)
        this.pendingExtensionDialogs.delete(id)
      }
    })
    const cancel = async () => {
      controller.abort()
      await completion
    }
    this.pendingExtensionDialogs.set(id, cancel)
    if (typeof ev.timeout === 'number' && Number.isFinite(ev.timeout) && ev.timeout >= 0) {
      timer = setTimeout(() => controller.abort(), ev.timeout)
    }
    await completion
  }

  private handleAtomicEvent(ev: AtomicRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'session_info_changed': {
        const name = (ev as { name?: unknown }).name
        if (typeof name === 'string' || name === undefined) void this.publishTitle(name ?? null)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev)
        if (ev.method === 'setStatus' && typeof ev.statusText === 'string' && ev.statusText) {
          this.emitAgentText(ev.statusText)
        } else if (ev.method === 'setWidget' && Array.isArray(ev.widgetLines)) {
          const text = ev.widgetLines.filter((line): line is string => typeof line === 'string').join('\n')
          if (text) this.emitAgentText(text)
        }
        break
      }
      case 'message_end': {
        const message = ev.message as { role?: string; display?: boolean; content?: unknown } | undefined
        if (message?.role === 'custom' && message.display === true) {
          const text = typeof message.content === 'string' ? message.content : toolResultToText(message)
          if (text) this.emitAgentText(text)
        }
        break
      }
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // Atomic sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              this.emitBashToolCall(toolCallId, toolName, rawInput, status)
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolTitle(toolName, rawInput),
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                ...(toolName === 'workflow'
                  ? { title: toolTitle(toolName, rawInput), kind: toToolKind(toolName) }
                  : {}),
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          this.emitBashToolCall(toolCallId, toolName, args, 'in_progress')
          break
        }

        if (toolName === 'edit' || toolName === 'write') {
          this.fileMutationToolCallIds.add(toolCallId)
          const snapshots = getMutationPaths(args)
            .map(path => {
              try {
                const oldText = readFileSync(resolvePath(this.cwd, path), 'utf8')
                if (typeof args?.oldText === 'string') line = findUniqueLineNumber(oldText, args.oldText)
                return { path, oldText }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, oldText: null }
                return null
              }
            })
            .filter((snapshot): snapshot is { path: string; oldText: string | null } => snapshot !== null)
          this.fileSnapshots.set(toolCallId, snapshots)
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolTitle(toolName, args),
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            ...(toolName === 'workflow' ? { title: toolTitle(toolName, args), kind: toToolKind(toolName) } : {}),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutput(toolCallId, partial, 'in_progress')
          break
        }
        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutput(toolCallId, result, isError ? 'failed' : 'completed', isError)
          this.currentToolCalls.delete(toolCallId)
          this.bashToolCallIds.delete(toolCallId)
          this.bashOutputSnapshots.delete(toolCallId)
          break
        }
        const text = toolResultToText(result)

        const snapshots = this.fileSnapshots.get(toolCallId) ?? []
        let content: ToolCallContent[] | undefined
        if (!isError) {
          for (const snapshot of snapshots) {
            try {
              const path = resolvePath(this.cwd, snapshot.path)
              const newText = readFileSync(path, 'utf8')
              if (newText !== snapshot.oldText) {
                content ??= []
                content.push({ type: 'diff', path, oldText: snapshot.oldText, newText })
              }
            } catch {
              // Fall back to the tool's text when the file cannot be read.
            }
          }
        }
        const hasStructuredDiff = Boolean(content?.length)

        // Fallback: just text content.
        if (!content && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.currentToolCalls.delete(toolCallId)
        this.fileSnapshots.delete(toolCallId)
        this.fileMutationToolCallIds.delete(toolCallId)
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'compaction_start':
      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Compacting context...'
          } satisfies ContentBlock
        })
        break
      }

      case 'compaction_end':
      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context compaction finished.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        this.backgroundTurn = !this.pendingTurn
        break
      }

      case 'turn_end': {
        // Atomic uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP prompt here; wait for agent_settled.
        break
      }

      case 'agent_end': {
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        if (this.backgroundTurn || !this.pendingTurn) {
          this.backgroundTurn = false
          this.inAgentLoop = false
          break
        }
        void (async () => {
          await this.cancelPendingExtensionDialogs()

          // Ensure all updates derived from Atomic events are delivered before we resolve
          // the ACP `session/prompt` request.
          await this.publishContextUsage()

          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
          this.pendingTurn?.resolve(reason)
          this.pendingTurn = null
          this.inAgentLoop = false

          // Start next queued prompt, if any.
          const next = this.turnQueue.shift()
          if (next) {
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
            })
            this.startTurn(next)
          } else {
            this.emit({
              sessionUpdate: 'session_info_update',
              _meta: { atomicAcp: { queueDepth: 0, running: false } }
            })
          }
        })()
        break
      }

      default:
        break
    }
  }
}

function formatAutoRetryMessage(ev: AtomicRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toolTitle(name: string, input: unknown): string {
  if (name !== 'workflow') return name
  const args = input as { action?: unknown; workflow?: unknown; runId?: unknown } | undefined
  const details = [args?.action ?? (args?.workflow ? 'run' : undefined), args?.workflow ?? args?.runId].filter(
    value => typeof value === 'string' && value
  )
  return details.length ? `workflow: ${details.join(' ')}` : name
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
