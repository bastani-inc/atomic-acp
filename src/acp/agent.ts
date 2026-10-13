import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ModelInfo,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { SessionManager } from './session.js'
import { SessionStore } from './session-store.js'
import { getAtomicCommand, shouldUseShellForAtomicCommand } from '../atomic-rpc/command.js'
import { AtomicRpcProcess } from '../atomic-rpc/process.js'
import { listAtomicSessions, findAtomicSessionFile } from './atomic-sessions.js'
import { normalizeAtomicAssistantText, normalizeAtomicMessageText } from './translate/atomic-messages.js'
import { toolResultToText } from './translate/atomic-tools.js'
import { promptToAtomicMessage } from './translate/prompt.js'
import {
  loadSlashCommands,
  loadSlashCommandsFromAtomicGetCommands,
  parseCommandArgs,
  toAvailableCommands
} from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './atomic-settings.js'
import { toAvailableCommandsFromAtomicGetCommands } from './atomic-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import {
  NO_CLIENT_ELICITATION_SUPPORT,
  readClientElicitationSupport,
  type ClientElicitationSupport
} from './elicitation/atomic-questionnaire.js'
import {
  detectAtomicQuestionnaireRpcSupport,
  type AtomicQuestionnaireRpcSupport
} from './elicitation/atomic-questionnaire-support.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set Atomic steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set Atomic follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show Atomic changelog'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}
import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class AtomicAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private clientElicitationSupport: ClientElicitationSupport = NO_CLIENT_ELICITATION_SUPPORT

  dispose(): void {
    this.sessions.disposeAll()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    void _config
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientElicitationSupport = readClientElicitationSupport(params)

    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'atomic-acp',
        title: 'Atomic ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)
    const atomicQuestionnaireRpcSupport = detectInstalledAtomicQuestionnaireRpcSupport()

    // Atomic doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      atomicCommand: process.env.ATOMIC_ACP_ATOMIC_COMMAND,
      clientElicitationSupport: this.clientElicitationSupport,
      atomicQuestionnaireRpcSupport
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let atomicCommands: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null
    let atomicCommandsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        }),
      typeof session.proc.getCommands === 'function'
        ? session.proc
            .getCommands()
            .then(c => {
              atomicCommands = c as any
            })
            .catch(err => {
              atomicCommandsErr = err
              atomicCommands = null
            })
        : Promise.resolve()
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If Atomic has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (!atomicCommandsErr && atomicCommands) {
      session.setFileCommands(loadSlashCommandsFromAtomicGetCommands(atomicCommands))
    }

    const models = await getModelState(session.proc, { state, availableModels })
    const thinking = await getThinkingState(session.proc, { state })

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice
        })

    if (preludeText)
      session.setStartupInfo(preludeText)

      // Policy: within a single ACP connection (one client window), keep only one live Atomic subprocess.
      // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
      // It does NOT affect other client windows because they run in separate agent processes.
      //
      // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    const response = {
      sessionId: session.sessionId,
      models,
      modes: thinking,
      _meta: {
        atomicAcp: {
          startupInfo: preludeText || null
        }
      }
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void (async () => {
        try {
          if (atomicCommandsErr || !atomicCommands) throw atomicCommandsErr
          const { commands } = toAvailableCommandsFromAtomicGetCommands(atomicCommands, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // Fall back to file-based prompt templates (legacy behavior).
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)

    const { message, images } = promptToAtomicMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        const res = await session.proc.compact(customInstructions)

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const stats = (await session.proc.getSessionStats()) as any

        const lines: string[] = []
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
        if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

        if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

        const t = stats?.tokens
        if (t && typeof t === 'object') {
          const parts: string[] = []
          if (typeof t.input === 'number') parts.push(`in ${t.input}`)
          if (typeof t.output === 'number') parts.push(`out ${t.output}`)
          if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
          if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
          if (typeof t.total === 'number') parts.push(`total ${t.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        // Fallback if stats shape changes.
        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer Atomic version that supports `set_session_name` in RPC mode.'
            : ''

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read Atomic's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed Atomic package by resolving the configured executable.
          // On Node installs, `atomic` typically resolves to .../@bastani/atomic/dist/cli.js
          try {
            const atomicPath = resolveAtomicExecutablePath()

            if (atomicPath) {
              const resolved = realpathSync(atomicPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@bastani', 'atomic', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate Atomic installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: Atomic's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, Atomic throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `atomic-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by Atomic.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `atomic-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }
    }

    const result = await session.prompt(message, images)

    // ACP StopReason does not include "error"; if Atomic fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === 'error' ? (session.wasCancelRequested() ? 'cancelled' : 'end_turn') : result

    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    await session.cancel()
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.listSessionsImpl(params)
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.listSessionsImpl(params)
  }

  private async listSessionsImpl(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate Atomic's `/resume` picker (project-scoped).
    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    const all = listAtomicSessions(effectiveCwd ?? undefined)
    const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // Atomic subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId)

    this.lastSessionCwd = params.cwd

    // MVP: ignore mcpServers.
    // Prefer ACP-created mapping first (fast path), otherwise scan Atomic sessions dir.
    const stored = this.store.get(params.sessionId)
    const sessionFile =
      stored?.cwd === params.cwd ? stored.sessionFile : findAtomicSessionFile(params.sessionId, params.cwd)

    if (!sessionFile) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    // Spawn Atomic and point it directly at the session file.
    let proc: AtomicRpcProcess
    try {
      proc = await AtomicRpcProcess.spawn({
        cwd: params.cwd,
        sessionPath: sessionFile,
        atomicCommand: process.env.ATOMIC_ACP_ATOMIC_COMMAND
      })
    } catch (e: any) {
      if (e?.name === 'AtomicRpcSpawnError') {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
      }
      throw e
    }

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)
    let atomicCommands: any = null
    let atomicCommandsErr: unknown = null
    let state: any = null

    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    try {
      if (typeof proc.getCommands === 'function') atomicCommands = (await proc.getCommands()) as any
    } catch (err) {
      atomicCommandsErr = err
    }

    const atomicQuestionnaireRpcSupport = detectInstalledAtomicQuestionnaireRpcSupport(state)

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands: atomicCommands ? loadSlashCommandsFromAtomicGetCommands(atomicCommands) : fileCommands,
      clientElicitationSupport: this.clientElicitationSupport,
      atomicQuestionnaireRpcSupport
    })

    // Policy: within a single ACP connection (one Zed window), keep only one live Atomic subprocess.
    // (Tests sometimes stub out `this.sessions`, so guard the call.)
    ;(this.sessions as any).closeAllExcept?.(session.sessionId)

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile
    })

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []

    for (const m of messages) {
      const role = String(m?.role ?? '')

      if (role === 'user') {
        const text = normalizeAtomicMessageText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'assistant') {
        const text = normalizeAtomicAssistantText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'toolResult') {
        const toolName = String((m as any)?.toolName ?? 'tool')
        const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean((m as any)?.isError)

        if (isBashTool(toolName)) {
          const text = bashResultText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: 'execute',
              status: 'in_progress',
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
            }
          })
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              _meta: {
                ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          })
          continue
        }

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
            status: 'completed',
            rawInput: null,
            rawOutput: m
          }
        })

        const text = toolResultToText(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
            rawOutput: m
          }
        })
      }
    }

    const models = await getModelState(proc, { state })
    const thinking = await getThinkingState(proc, { state })

    const response = {
      models,
      modes: thinking,
      _meta: {
        atomicAcp: {
          startupInfo: null
        }
      }
    }

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        try {
          if (atomicCommandsErr || !atomicCommands) throw atomicCommandsErr
          const { commands } = toAvailableCommandsFromAtomicGetCommands(atomicCommands, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // fall back
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId)

    // Accept either:
    //  - "provider/model" (preferred, matches how we advertise)
    //  - "model" (fallback, we try to resolve via available models)
    let provider: string | null = null
    let modelId: string | null = null

    if (params.modelId.includes('/')) {
      const [p, ...rest] = params.modelId.split('/')
      provider = p
      modelId = rest.join('/')
    } else {
      modelId = params.modelId
    }

    if (!provider) {
      const data = (await session.proc.getAvailableModels()) as any
      const models: any[] = Array.isArray(data?.models) ? data.models : []
      const found = models.find(m => String(m?.id) === modelId)
      if (found) {
        provider = String(found.provider)
        modelId = String(found.id)
      }
    }

    if (!provider || !modelId) {
      throw RequestError.invalidParams(`Unknown modelId: ${params.modelId}`)
    }

    await session.proc.setModel(provider, modelId)
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId)

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await session.proc.setThinkingLevel(mode)

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode
      }
    })

    return {}
  }
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh'
}

async function getThinkingState(
  proc: AtomicRpcProcess,
  pre?: { state?: any | null }
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  // Ask Atomic for current thinking level.
  let current: ThinkingLevel = 'medium'

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const tl = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
  if (tl && isThinkingLevel(tl)) current = tl

  const available: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

async function getModelState(
  proc: AtomicRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  availableModels: ModelInfo[]
  currentModelId: string
} | null> {
  // Ask Atomic for available models.
  let availableModels: ModelInfo[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch {
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies ModelInfo
    })
    .filter(Boolean) as ModelInfo[]

  // Ask Atomic what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId
  }
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function resolveAtomicExecutablePath(): string | null {
  const cmd = getAtomicCommand(process.env.ATOMIC_ACP_ATOMIC_COMMAND)

  if (cmd.includes('/') || (process.platform === 'win32' && /^[a-z]:[\\/]/i.test(cmd))) {
    return existsSync(cmd) ? cmd : null
  }

  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  const which = spawnSync(whichCmd, [cmd], { encoding: 'utf-8' })
  return (
    String(which.stdout ?? '')
      .split(/\r?\n/)[0]
      ?.trim() || null
  )
}

function getAtomicVersionOutput(): string {
  const cmd = getAtomicCommand(process.env.ATOMIC_ACP_ATOMIC_COMMAND)
  const atomicVersion = spawnSync(cmd, ['--version'], {
    encoding: 'utf-8',
    shell: shouldUseShellForAtomicCommand(cmd)
  })
  return String(atomicVersion.stdout ?? '').trim() || String(atomicVersion.stderr ?? '').trim()
}

function detectInstalledAtomicQuestionnaireRpcSupport(rpcCapabilities?: unknown): AtomicQuestionnaireRpcSupport {
  let versionOutput: string | null = null
  try {
    versionOutput = getAtomicVersionOutput()
  } catch {
    versionOutput = null
  }

  return detectAtomicQuestionnaireRpcSupport({ versionOutput, rpcCapabilities: rpcCapabilities ?? undefined })
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const installed = getAtomicVersionOutput().replace(/^v/i, '')

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@bastani/atomic', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @bastani/atomic\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // Atomic version header
  try {
    const installed = getAtomicVersionOutput().replace(/^v/i, '')
    if (installed) {
      md.push(`Atomic v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects ATOMIC_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (Atomic skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.atomic/skills)
  const projectSkillsDir = join(opts.cwd, '.atomic', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const agentDir = getAgentDir()
  const promptsDir = join(agentDir, 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(agentDir, 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  for (const settingsPath of [join(agentDir, 'settings.json'), join(opts.cwd, '.atomic', 'settings.json')]) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { packages?: unknown }
      const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : []
      for (const pkg of packages) {
        const source = typeof pkg === 'string' ? pkg : (pkg as { source?: unknown } | null)?.source
        if (typeof source !== 'string') continue
        extItems.push(source.startsWith('npm:') ? `${source}\n  - index.ts` : source)
      }
    } catch {
      // Ignore missing or invalid settings.
    }
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'atomic-acp', version: '0.0.0' }
}
