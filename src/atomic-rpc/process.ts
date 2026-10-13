import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { getAtomicCommand, parseAtomicExtraArgs, shouldUseShellForAtomicCommand } from './command.js'
import { writeAdapterExtension, type AdapterExtensionFile } from './adapter-extension.js'

export class AtomicRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'AtomicRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

export function splitLfJsonlChunk(buffer: string, chunk: string): { lines: string[]; buffer: string } {
  const combined = buffer + chunk
  const parts = combined.split('\n')
  return { lines: parts.slice(0, -1), buffer: parts.at(-1) ?? '' }
}

type AtomicRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[]; streamingBehavior?: 'followUp' }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'get_available_thinking_levels'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }
  | { type: 'list_workflow_runs'; id?: string; status?: string }
  | { type: 'get_workflow_run_summary'; id?: string; runId: string }

type AtomicRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export type AtomicExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | {
      type: 'extension_ui_response'
      id: string
      cancelled: true
    }

export type AtomicRpcEvent = Record<string, unknown>

export const NO_PERSON_FOR_ASK_USER_QUESTION =
  'No person is available to answer questions in this session: the ACP client is running headless. ' +
  'Do not ask again. In your final reply, state the question you needed answered and the assumption you made or would need, then stop.'

/** Maximum wait for an auxiliary context-usage update. */
export const SESSION_STATS_TIMEOUT_MS = 1_000

export type AtomicSessionStats = {
  sessionId?: string
  sessionFile?: string
  totalMessages?: number
  cost?: number
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
  contextUsage?: { tokens?: number | null; contextWindow?: number | null } | null
}

type SpawnParams = {
  cwd: string
  /** Optional override for `atomic` executable name/path */
  atomicCommand?: string
  /** If set, Atomic will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** MCP servers in Atomic's `mcpServers` shape, registered through a private per-process extension. */
  mcpServers?: Record<string, object>
  /** No person can answer questions: `ask_user_question` returns a clear "no person available" result. */
  headless?: boolean
  /** Extra Atomic arguments; defaults to ATOMIC_ACP_ATOMIC_ARGS plus the adapter's args after `--`. */
  extraArgs?: string[]
}

export class AtomicRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    string,
    { resolve: (v: AtomicRpcResponse) => void; reject: (e: unknown) => void }
  >()
  private eventHandlers: Array<(ev: AtomicRpcEvent) => void> = []
  private exitHandlers: Array<(err: Error) => void> = []
  private readonly preludeLines: string[] = []
  private readonly adapterExtension: AdapterExtensionFile | undefined

  private constructor(child: ChildProcessWithoutNullStreams, adapterExtension?: AdapterExtensionFile) {
    this.child = child
    this.adapterExtension = adapterExtension

    let stdoutBuffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      const split = splitLfJsonlChunk(stdoutBuffer, String(chunk))
      stdoutBuffer = split.buffer

      for (const line of split.lines) {
        if (!line.trim()) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          // Atomic may emit a human-readable prelude on stdout before NDJSON starts.
          // Capture it so the ACP adapter can surface it on session start.
          const cleaned = stripAnsi(String(line)).trimEnd()
          if (cleaned) this.preludeLines.push(cleaned)
          continue
        }

        if (msg?.type === 'response') {
          const id = typeof msg.id === 'string' ? msg.id : undefined
          if (id !== undefined) this.pending.get(id)?.resolve(msg as AtomicRpcResponse)
          continue
        }

        for (const h of this.eventHandlers) h(msg as AtomicRpcEvent)
      }
    })

    child.on('exit', (code, signal) => {
      this.adapterExtension?.dispose()
      const err = new Error(`Atomic process exited (code=${code}, signal=${signal})`)
      this.rejectPendingAndNotifyExit(err)
    })

    child.on('error', err => {
      this.rejectPendingAndNotifyExit(err instanceof Error ? err : new Error(String(err)))
    })
  }

  static async spawn(params: SpawnParams): Promise<AtomicRpcProcess> {
    // On Windows, npm commonly creates Atomic.cmd / Atomic.bat launcher scripts.
    const cmd = getAtomicCommand(params.atomicCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    let extraArgs: string[]
    try {
      extraArgs = params.extraArgs ?? parseAtomicExtraArgs(process.argv, process.env)
    } catch (e) {
      throw new AtomicRpcSpawnError(`Could not start Atomic: ${(e as Error).message}`, { cause: e })
    }
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)
    const adapterExtension = writeAdapterExtension({
      mcpServers: params.mcpServers,
      ...(params.headless ? { askUserQuestionUnavailable: NO_PERSON_FOR_ASK_USER_QUESTION } : {})
    })
    if (adapterExtension) args.push('-e', adapterExtension.path)
    args.push(...extraArgs)

    const start = shouldUseShellForAtomicCommand(cmd) ? crossSpawn : spawn
    let child: ChildProcessWithoutNullStreams
    try {
      child = start(cmd, args, {
        cwd: params.cwd,
        stdio: 'pipe',
        env: process.env
      }) as ChildProcessWithoutNullStreams
    } catch (e) {
      adapterExtension?.dispose()
      throw e
    }

    // Ensure spawn failures (e.g. ENOENT when Atomic isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      adapterExtension?.dispose()
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new AtomicRpcSpawnError(
          `Could not start Atomic: executable not found (command: ${cmd}). Atomic needs to be installed before it can run in ACP clients. Install it via \`npm install -g @bastani/atomic\` or ensure \`atomic\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new AtomicRpcSpawnError(`Could not start Atomic: permission denied (command: ${cmd}).`, {
          code,
          cause: e
        })
      }

      throw new AtomicRpcSpawnError(`Could not start Atomic (command: ${cmd}).`, { code, cause: e })
    }

    child.stderr.on('data', () => {
      // leave stderr untouched; ACP clients may capture it.
    })

    const proc = new AtomicRpcProcess(child, adapterExtension)

    // Best-effort handshake.
    // Important: Atomic may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch {
      // ignore for now
    }

    return proc
  }

  onEvent(handler: (ev: AtomicRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  onExit(handler: (err: Error) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  private rejectPendingAndNotifyExit(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
    for (const h of this.exitHandlers) h(err)
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    this.adapterExtension?.dispose()
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(
    message: string,
    images: unknown[] = [],
    streamingBehavior?: 'followUp'
  ): Promise<'started' | 'queued' | 'handled' | undefined> {
    const res = await this.request({
      type: 'prompt',
      message,
      images,
      ...(streamingBehavior ? { streamingBehavior } : {})
    })
    if (!res.success) throw new Error(`Atomic prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
    const disposition = (res.data as { disposition?: unknown } | undefined)?.disposition
    return disposition === 'started' || disposition === 'queued' || disposition === 'handled' ? disposition : undefined
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`Atomic abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  writeExtensionUiResponse(response: AtomicExtensionUiResponse): Promise<void> {
    return this.writeJsonLine(response)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`Atomic get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`Atomic get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`Atomic set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success)
      throw new Error(`Atomic get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data
    const levels = data && typeof data === 'object' && 'levels' in data ? data.levels : undefined
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      !levels.every(level => typeof level === 'string' && level.length > 0)
    ) {
      throw new Error('Atomic get_available_thinking_levels returned invalid levels')
    }
    return levels
  }

  async setThinkingLevel(level: string): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`Atomic set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`Atomic set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`Atomic set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`Atomic compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`Atomic set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(timeoutMs?: number): Promise<AtomicSessionStats> {
    const res = await this.request({ type: 'get_session_stats' }, { timeoutMs })
    if (!res.success) throw new Error(`Atomic get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return (res.data ?? {}) as AtomicSessionStats
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`Atomic set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`Atomic export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`Atomic switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`Atomic get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`Atomic get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  private writeJsonLine(value: unknown): Promise<void> {
    const line = JSON.stringify(value) + '\n'

    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, err => {
          if (err) reject(err)
          else resolve()
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  async listWorkflowRuns(status?: string): Promise<unknown> {
    const res = await this.request({ type: 'list_workflow_runs', ...(status ? { status } : {}) })
    if (!res.success) throw new Error(`Atomic list_workflow_runs failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getWorkflowRunSummary(runId: string): Promise<unknown> {
    const res = await this.request({ type: 'get_workflow_run_summary', runId })
    if (!res.success)
      throw new Error(`Atomic get_workflow_run_summary failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  private request(cmd: AtomicRpcCommand, opts?: { timeoutMs?: number }): Promise<AtomicRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }
    const timeoutMs = opts?.timeoutMs

    return new Promise<AtomicRpcResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const drop = (): boolean => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return this.pending.delete(id)
      }
      this.pending.set(id, {
        resolve: res => {
          drop()
          resolve(res)
        },
        reject: error => {
          drop()
          reject(error)
        }
      })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timer = undefined
          if (!this.pending.delete(id)) return
          reject(new Error(`Atomic ${cmd.type} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }
      this.writeJsonLine(withId).catch(err => {
        if (!drop()) return
        reject(err)
      })
    })
  }
}
