import type { AtomicRpcEvent } from '../../atomic-rpc/process.js'

/**
 * Workflow lifecycle as Atomic reports it over RPC: the workflows extension appends
 * `workflow.run.*` / `workflow.stage.*` session entries (forwarded as `entry_appended`) and posts
 * `workflows:lifecycle-notice` custom messages whose `details` carry the run outcome.
 */
export type WorkflowEvent =
  | { kind: 'run_start'; runId: string; name?: string }
  | { kind: 'run_end'; runId: string; status: string; result?: unknown; error?: string }
  | { kind: 'stage_start'; runId: string; stageId?: string; name?: string; humanInput: boolean }
  | { kind: 'stage_end'; runId: string; stageId?: string; status?: string }

const TERMINAL_NOTICE_KINDS = new Set(['completed', 'failed', 'blocked', 'quit', 'cancelled', 'killed', 'skipped'])

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseWorkflowEvent(ev: AtomicRpcEvent): WorkflowEvent | null {
  if (ev.type === 'entry_appended') {
    const entry = record(ev.entry)
    const data = record(entry?.data)
    const runId = str(data?.runId)
    if (!entry || !data || !runId) return null
    switch (entry.customType) {
      case 'workflow.run.start':
        return { kind: 'run_start', runId, name: str(data.name) }
      case 'workflow.run.end':
        return {
          kind: 'run_end',
          runId,
          status: str(data.status) ?? 'completed',
          ...(data.result !== undefined ? { result: data.result } : {}),
          ...(str(data.error) ? { error: str(data.error) } : {})
        }
      case 'workflow.run.blocked':
        return { kind: 'run_end', runId, status: 'blocked', ...(str(data.error) ? { error: str(data.error) } : {}) }
      case 'workflow.stage.start':
        return {
          kind: 'stage_start',
          runId,
          stageId: str(data.stageId),
          name: str(data.name),
          // Human-input prompt nodes (ctx.ui.input/confirm/select/editor/custom) use `prompt:` replay keys.
          humanInput: str(data.replayKey)?.startsWith('prompt:') ?? false
        }
      case 'workflow.stage.end':
        return { kind: 'stage_end', runId, stageId: str(data.stageId), status: str(data.status) }
      default:
        return null
    }
  }
  if (ev.type === 'message_end') {
    const message = record(ev.message)
    if (message?.role !== 'custom' || message.customType !== 'workflows:lifecycle-notice') return null
    const details = record(message.details)
    const runId = str(details?.runId)
    const kind = str(details?.kind)
    if (!runId || !kind || details?.scope === 'stage') return null
    if (kind === 'started') return { kind: 'run_start', runId, name: str(details?.workflowName) }
    if (TERMINAL_NOTICE_KINDS.has(kind)) return { kind: 'run_end', runId, status: kind }
  }
  return null
}
