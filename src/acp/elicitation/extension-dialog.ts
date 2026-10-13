import { createFormElicitation } from './atomic-questionnaire.js'
import type { AgentSideConnection, ElicitationPropertySchema } from '@agentclientprotocol/sdk'
import type { AtomicExtensionUiResponse, AtomicRpcEvent } from '../../atomic-rpc/process.js'

export async function requestExtensionDialog(
  conn: AgentSideConnection,
  sessionId: string,
  ev: AtomicRpcEvent,
  form: boolean
): Promise<AtomicExtensionUiResponse> {
  const id = String(ev.id)
  const cancelled: AtomicExtensionUiResponse = { type: 'extension_ui_response', id, cancelled: true }
  const method = ev.method
  const options = Array.isArray(ev.options) ? ev.options.map(String) : []
  if (method === 'select' && !options.length) return cancelled
  const title = typeof ev.title === 'string' ? ev.title : `Atomic ${method}`
  try {
    if (form) {
      let property: ElicitationPropertySchema
      if (method === 'confirm') property = { type: 'boolean', title }
      else if (method === 'select') property = { type: 'string', title, enum: options }
      else
        property = {
          type: 'string',
          title,
          ...(typeof ev.placeholder === 'string' ? { description: ev.placeholder } : {}),
          ...(typeof ev.prefill === 'string' ? { default: ev.prefill } : {})
        }
      const response = await createFormElicitation(conn, {
        sessionId,
        mode: 'form',
        message: typeof ev.message === 'string' ? `${title}\n\n${ev.message}` : title,
        requestedSchema: { type: 'object', properties: { value: property }, required: ['value'] },
        _meta: { atomicAcp: { kind: 'extension_ui', method: String(method), atomicRequestId: id } }
      })
      if (response.action !== 'accept') return cancelled
      const value = response.content?.value
      if (method === 'confirm')
        return typeof value === 'boolean' ? { type: 'extension_ui_response', id, confirmed: value } : cancelled
      if (typeof value !== 'string' || (method === 'select' && !options.includes(value))) return cancelled
      return { type: 'extension_ui_response', id, value }
    }
    if (method !== 'select' && method !== 'confirm') return cancelled
    const rawInput: Record<string, unknown> = { method }
    for (const key of ['title', 'message', 'options', 'placeholder', 'prefill']) {
      if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
    }
    const response = await conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: `atomic-ui-${id}`, title, kind: 'other', status: 'pending', rawInput },
      options:
        method === 'confirm'
          ? [
              { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
              { optionId: 'no', name: 'No', kind: 'reject_once' }
            ]
          : options.map((name, index) => ({ optionId: `choice-${index}`, name, kind: 'allow_once' }))
    })
    if (response.outcome.outcome !== 'selected') return cancelled
    const optionId = response.outcome.optionId
    if (method === 'confirm')
      return optionId === 'yes' || optionId === 'no'
        ? { type: 'extension_ui_response', id, confirmed: optionId === 'yes' }
        : cancelled
    const index = options.findIndex((_, index) => optionId === `choice-${index}`)
    return index < 0 ? cancelled : { type: 'extension_ui_response', id, value: options[index]! }
  } catch {
    return cancelled
  }
}
