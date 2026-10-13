import test from 'node:test'
import assert from 'node:assert/strict'
import { AtomicAcpSession } from '../../src/acp/session.js'
import { AtomicRpcProcess } from '../../src/atomic-rpc/process.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

function setup(form = false) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const session = new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as AtomicRpcProcess,
    conn: asAgentConn(conn),
    ...(form ? { clientElicitationSupport: { form: true } as const } : {})
  })
  return { conn, proc, session }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('extension select offers indexed ACP choices and returns the selected text', async () => {
  const { conn, proc } = setup()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }
  proc.emit({
    type: 'extension_ui_request',
    id: 'select',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })
  await flush()
  assert.deepEqual(conn.permissionRequests[0], {
    sessionId: 's1',
    toolCall: {
      toolCallId: 'atomic-ui-select',
      title: 'Pick one',
      kind: 'other',
      status: 'pending',
      rawInput: { method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] }
    },
    options: [
      { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
      { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ type: 'extension_ui_response', id: 'select', value: 'Beta' }])
  assert.equal(conn.elicitationRequests.length, 0)
})

for (const optionId of ['yes', 'no', 'invalid', null]) {
  test(`extension confirm handles ${optionId ?? 'cancellation'}`, async () => {
    const { conn, proc } = setup()
    conn.nextPermissionResponse = {
      outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId }
    }
    proc.emit({ type: 'extension_ui_request', id: 'confirm', method: 'confirm', title: 'Continue?' })
    await flush()
    assert.deepEqual(conn.permissionRequests[0]?.options, [
      { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
      { optionId: 'no', name: 'No', kind: 'reject_once' }
    ])
    assert.deepEqual(proc.extensionUiResponses, [
      {
        type: 'extension_ui_response',
        id: 'confirm',
        ...(optionId === 'yes' || optionId === 'no' ? { confirmed: optionId === 'yes' } : { cancelled: true })
      }
    ])
  })
}

test('extension dialogs, notification severity, status and widgets coexist without extra replies', async () => {
  const { conn, proc } = setup()
  for (const method of ['input', 'editor']) proc.emit({ type: 'extension_ui_request', id: method, method })
  for (const level of ['info', 'warning', 'error'])
    proc.emit({ type: 'extension_ui_request', id: level, method: 'notify', message: level, notifyType: level })
  proc.emit({ type: 'extension_ui_request', id: 'status', method: 'setStatus', statusText: 'working' })
  proc.emit({ type: 'extension_ui_request', id: 'widget', method: 'setWidget', widgetLines: ['progress'] })
  await flush()
  assert.deepEqual(
    proc.extensionUiResponses,
    ['input', 'editor'].map(id => ({ type: 'extension_ui_response', id, cancelled: true }))
  )
  assert.equal(conn.updates.length, 7)
  assert.deepEqual(
    conn.updates.slice(2, 5).map(update => update.update._meta),
    ['info', 'warning', 'error'].map(level => ({ atomicAcp: { notify: { level } } }))
  )
  assert.deepEqual(
    conn.updates.slice(5).map(({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content),
    [
      { type: 'text', text: 'working' },
      { type: 'text', text: 'progress' }
    ]
  )
})

for (const [method, value] of [
  ['select', 'Beta'],
  ['confirm', false],
  ['input', 'entered'],
  ['editor', 'edited\ntext']
] as const) {
  test(`extension ${method} uses form elicitation when advertised`, async () => {
    const { conn, proc } = setup(true)
    conn.elicitationResponses.push({ action: 'accept', content: { value } })
    proc.emit({
      type: 'extension_ui_request',
      id: method,
      method,
      title: 'Prompt',
      message: 'Explain',
      options: ['Alpha', 'Beta'],
      placeholder: 'hint',
      prefill: 'initial'
    })
    await flush()
    assert.equal(conn.permissionRequests.length, 0)
    const request = conn.elicitationRequests[0]!
    assert.equal(request.mode, 'form')
    if (request.mode !== 'form') return
    assert.ok('sessionId' in request)
    assert.equal(request.sessionId, 's1')
    assert.equal(request.message, 'Prompt\n\nExplain')
    assert.deepEqual(request.requestedSchema.required, ['value'])
    const property = request.requestedSchema.properties!.value
    assert.equal(property.type, method === 'confirm' ? 'boolean' : 'string')
    if (method === 'select') assert.deepEqual(property, { type: 'string', title: 'Prompt', enum: ['Alpha', 'Beta'] })
    if (method === 'input' || method === 'editor')
      assert.deepEqual(property, { type: 'string', title: 'Prompt', description: 'hint', default: 'initial' })
    assert.deepEqual(proc.extensionUiResponses, [
      { type: 'extension_ui_response', id: method, ...(method === 'confirm' ? { confirmed: value } : { value }) }
    ])
  })
}

for (const form of [false, true]) {
  test(`extension dialogs cancel on session cancellation and ignore late replies (form=${form})`, async () => {
    const { conn, proc, session } = setup(form)
    let answer: (() => void) | undefined
    if (form)
      conn.elicitationResponses.push(
        new Promise(resolve => {
          answer = () => resolve({ action: 'accept', content: { value: true } })
        })
      )
    else
      conn.requestPermission = async params => {
        conn.permissionRequests.push(params)
        return new Promise(resolve => {
          answer = () => resolve({ outcome: { outcome: 'selected', optionId: 'yes' } })
        })
      }
    proc.emit({ type: 'extension_ui_request', id: 'cancel', method: 'confirm' })
    await session.cancel()
    answer?.()
    await flush()
    assert.deepEqual(proc.extensionUiResponses, [{ type: 'extension_ui_response', id: 'cancel', cancelled: true }])
  })

  test(`extension dialogs time out and ignore late replies (form=${form})`, async () => {
    const { conn, proc } = setup(form)
    let answer: (() => void) | undefined
    if (form)
      conn.elicitationResponses.push(
        new Promise(resolve => {
          answer = () => resolve({ action: 'accept', content: { value: true } })
        })
      )
    else
      conn.requestPermission = async () =>
        new Promise(resolve => {
          answer = () => resolve({ outcome: { outcome: 'selected', optionId: 'yes' } })
        })
    proc.emit({ type: 'extension_ui_request', id: 'timeout', method: 'confirm', timeout: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    answer?.()
    await flush()
    assert.deepEqual(proc.extensionUiResponses, [{ type: 'extension_ui_response', id: 'timeout', cancelled: true }])
  })
}

for (const action of ['cancel', 'decline'] as const) {
  test(`extension forms return cancelled for ${action}`, async () => {
    const { conn, proc } = setup(true)
    conn.elicitationResponses.push({ action })
    proc.emit({ type: 'extension_ui_request', id: action, method: 'input' })
    await flush()
    assert.deepEqual(proc.extensionUiResponses, [{ type: 'extension_ui_response', id: action, cancelled: true }])
  })
}
