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
  type AtomicRpcEvent
} from '../atomic-rpc/process.js'
import { SessionStore } from './session-store.js'
import { toolResultToText } from './translate/atomic-tools.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  cancelledAtomicQuestionnaireResult,
  createAtomicQuestionElicitation,
  isAtomicAskUserQuestionEvent,
  NO_CLIENT_ELICITATION_SUPPORT,
  normalizeAtomicQuestionnairePayload,
  type AtomicAskUserQuestionEvent,
  type AtomicQuestionnaireResult,
  type ClientElicitationSupport
} from './elicitation/atomic-questionnaire.js'
import {
  detectAtomicQuestionnaireRpcSupport,
  NO_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT,
  type AtomicQuestionnaireRpcSupport
} from './elicitation/atomic-questionnaire-support.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  atomicCommand?: string
  clientElicitationSupport?: ClientElicitationSupport
  atomicQuestionnaireRpcSupport?: AtomicQuestionnaireRpcSupport
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

type PendingAtomicQuestion = {
  atomicRequestId: string
}

type TurnTerminalReason = 'agent_settled' | 'prompt_failure' | 'process_exit'

function resolveSessionAtomicQuestionnaireRpcSupport(
  base: AtomicQuestionnaireRpcSupport | undefined,
  rpcCapabilities: unknown
): AtomicQuestionnaireRpcSupport {
  if (base?.supported && base.source === 'atomic_rpc_capability') return base

  const detected = detectAtomicQuestionnaireRpcSupport({
    atomicVersion: base?.atomicVersion,
    rpcCapabilities: rpcCapabilities ?? undefined
  })

  if (detected.supported) return detected
  return base ?? detected
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

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path =
    typeof (args as { path?: unknown } | null | undefined)?.path === 'string'
      ? (args as { path: string }).path
      : undefined
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
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
        atomicCommand: params.atomicCommand
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
      clientElicitationSupport: params.clientElicitationSupport,
      atomicQuestionnaireRpcSupport: resolveSessionAtomicQuestionnaireRpcSupport(
        params.atomicQuestionnaireRpcSupport,
        state
      )
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
      clientElicitationSupport: params.clientElicitationSupport,
      atomicQuestionnaireRpcSupport: params.atomicQuestionnaireRpcSupport
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
  private readonly atomicQuestionnaireRpcSupport: AtomicQuestionnaireRpcSupport
  private fileCommands: FileSlashCommand[]

  private pendingAtomicQuestion: PendingAtomicQuestion | null = null
  private unsupportedAtomicQuestionMessageSent = false
  private activeTurnTerminalReason: TurnTerminalReason | null = null

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

  // For ACP diff support: capture file contents before edits, then emit ToolCallContent {type:"diff"}.
  // This is due to Atomic sending diff as a string as opposed to ACP expected diff format.
  // Compatible format may need to be implemented in Atomic in the future.
  private editSnapshots = new Map<string, { path: string; oldText: string }>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: AtomicRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    clientElicitationSupport?: ClientElicitationSupport
    atomicQuestionnaireRpcSupport?: AtomicQuestionnaireRpcSupport
    autoTitle?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.clientElicitationSupport = opts.clientElicitationSupport ?? NO_CLIENT_ELICITATION_SUPPORT
    this.atomicQuestionnaireRpcSupport = opts.atomicQuestionnaireRpcSupport ?? NO_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
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

    await this.cancelPendingAtomicQuestion()

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

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.activeTurnTerminalReason = null
    this.inAgentLoop = false

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }
    void this.maybeAutoTitle(t.title)

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { atomicAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off Atomic, but completion is determined by Atomic events, not the RPC response.
    // The full prompt is finished when we see `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(err => {
      void this.finishActiveAndQueuedFromFailure(err)
      void err
    })
  }

  private async finishActiveAndQueuedFromFailure(err: unknown): Promise<void> {
    this.activeTurnTerminalReason ??= 'prompt_failure'
    await this.cancelPendingAtomicQuestion()

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
    this.activeTurnTerminalReason ??= 'process_exit'
    void this.cancelPendingAtomicQuestion()

    if (!this.pendingTurn && this.turnQueue.length === 0) return
    void this.finishActiveAndQueuedFromFailure(err)
  }

  private shouldCancelIncomingAtomicQuestion(): boolean {
    return (
      !this.pendingTurn ||
      this.cancelRequested ||
      this.activeTurnTerminalReason !== null ||
      this.pendingAtomicQuestion !== null
    )
  }

  private async handleAtomicAskUserQuestionEvent(ev: AtomicAskUserQuestionEvent): Promise<void> {
    if (!this.atomicQuestionnaireRpcSupport.supported) {
      this.emitUnsupportedAtomicQuestionnaireMessageOnce()
      await this.writeUnsupportedAtomicQuestionnaireCancellation(ev.id)
      return
    }

    if (this.shouldCancelIncomingAtomicQuestion()) {
      await this.writeAtomicQuestionnaireResponse(ev.id, cancelledAtomicQuestionnaireResult())
      return
    }

    const normalized = normalizeAtomicQuestionnairePayload(ev.questions)
    if (!normalized.ok) {
      this.emitAgentText(`Atomic could not present a structured question: ${normalized.message}`)
      await this.writeAtomicQuestionnaireResponse(ev.id, normalized.result)
      return
    }

    if (!this.clientElicitationSupport.form) {
      this.emitAgentText(
        'Atomic asked a structured question, but this ACP client does not advertise form elicitation. Continuing without an answer.'
      )
      await this.writeAtomicQuestionnaireResponse(ev.id, cancelledAtomicQuestionnaireResult('no_ui'))
      return
    }

    const pending: PendingAtomicQuestion = {
      atomicRequestId: ev.id
    }
    this.pendingAtomicQuestion = pending

    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { atomicAcp: { askUserQuestionPending: true, questionCount: normalized.questions.length } }
    })

    const questionnaireResponse = await createAtomicQuestionElicitation({
      conn: this.conn,
      sessionId: this.sessionId,
      atomicRequestId: ev.id,
      questions: normalized.questions
    })

    if (questionnaireResponse.invalidAcceptContent) {
      this.emitAgentText(
        'Atomic received an invalid structured question answer from the client. Continuing without an answer.'
      )
    }

    await this.finishPendingAtomicQuestion(pending, questionnaireResponse.result)
  }

  private emitUnsupportedAtomicQuestionnaireMessageOnce(): void {
    if (this.unsupportedAtomicQuestionMessageSent) return
    this.unsupportedAtomicQuestionMessageSent = true

    const version = this.atomicQuestionnaireRpcSupport.atomicVersion
    const subject = version ? `Atomic v${version}` : 'This Atomic version'
    const minimum = this.atomicQuestionnaireRpcSupport.minimumVersion
      ? ` Atomic questionnaire RPC is only enabled for Atomic v${this.atomicQuestionnaireRpcSupport.minimumVersion}+ or an explicit RPC capability.`
      : ''

    this.emitAgentText(
      `${subject} does not support ask_user_question questionnaire RPC over Atomic RPC.${minimum} Continuing without an answer.`
    )
  }

  private async writeUnsupportedAtomicQuestionnaireCancellation(atomicRequestId: string): Promise<void> {
    await this.writeExtensionUiResponse({
      type: 'extension_ui_response',
      id: atomicRequestId,
      cancelled: true
    })
  }

  private async cancelPendingAtomicQuestion(): Promise<void> {
    const pendingQuestion = this.pendingAtomicQuestion
    if (!pendingQuestion) return

    await this.finishPendingAtomicQuestion(pendingQuestion, cancelledAtomicQuestionnaireResult())
  }

  private async finishPendingAtomicQuestion(
    pending: PendingAtomicQuestion,
    result: AtomicQuestionnaireResult
  ): Promise<void> {
    if (this.pendingAtomicQuestion !== pending) return

    this.pendingAtomicQuestion = null

    await this.writeAtomicQuestionnaireResponse(pending.atomicRequestId, result)

    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { atomicAcp: { askUserQuestionPending: false } }
    })
  }

  private async writeAtomicQuestionnaireResponse(
    atomicRequestId: string,
    questionnaireResult: AtomicQuestionnaireResult
  ): Promise<void> {
    await this.writeExtensionUiResponse({
      type: 'extension_ui_response',
      id: atomicRequestId,
      questionnaireResult
    })
  }

  private async writeExtensionUiResponse(response: AtomicExtensionUiResponse): Promise<void> {
    try {
      await this.proc.writeExtensionUiResponse(response)
    } catch {
      this.emitAgentText('Atomic could not receive a structured question response.')
    }
  }

  private handleAtomicEvent(ev: AtomicRpcEvent) {
    if (isAtomicAskUserQuestionEvent(ev)) {
      void this.handleAtomicAskUserQuestionEvent(ev).catch(() => {
        // Keep Atomic event handling best-effort; never expose answer content in diagnostics.
      })
      return
    }

    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'session_info_changed': {
        const name = (ev as { name?: unknown }).name
        if (typeof name === 'string' || name === undefined) void this.publishTitle(name ?? null)
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

            if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
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

        if (toolName === 'ask_user_question' && !this.atomicQuestionnaireRpcSupport.supported) {
          this.emitUnsupportedAtomicQuestionnaireMessageOnce()
        }

        // Capture pre-edit file contents so we can emit a structured ACP diff on completion.
        if (toolName === 'edit') {
          const p = typeof args?.path === 'string' ? args.path : undefined
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const oldText = readFileSync(abs, 'utf8')
              this.editSnapshots.set(toolCallId, { path: p, oldText })

              const needle = typeof args?.oldText === 'string' ? args.oldText : ''
              line = findUniqueLineNumber(oldText, needle)
            } catch {
              // Ignore snapshot failures; we'll fall back to plain text output.
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
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
        const text = toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          rawOutput: partial
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)

        // If this was an edit and we captured a snapshot, emit a structured ACP diff.
        // This enables clients like Zed to render an actual diff UI.
        const snapshot = this.editSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                },
                ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        // Fallback: just text content.
        if (!content && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: result
        })

        this.currentToolCalls.delete(toolCallId)
        this.editSnapshots.delete(toolCallId)
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

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
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
        this.activeTurnTerminalReason = 'agent_settled'

        // Cancel any pending Atomic questionnaire before resolving the ACP prompt.
        // Late ACP elicitation responses will then fail the pending-object identity guard.
        void (async () => {
          await this.cancelPendingAtomicQuestion()

          // Ensure all updates derived from Atomic events are delivered before we resolve
          // the ACP `session/prompt` request.
          await this.flushEmits()

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

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      // Many ACP clients render `execute` tool calls only via the terminal APIs.
      // Since this adapter lets Atomic execute locally (no client terminal delegation),
      // we report bash as `other` so clients show inline text output blocks.
      return 'other'
    default:
      return 'other'
  }
}
