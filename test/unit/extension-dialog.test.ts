import test from 'node:test'
import assert from 'node:assert/strict'
import { requestExtensionDialog } from '../../src/acp/elicitation/extension-dialog.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

for (const form of [false, true]) {
  test(`extension dialog settles on abort without waiting for the client (form=${form})`, async () => {
    const conn = new FakeAgentSideConnection()
    if (form) conn.elicitationResponses.push(new Promise(() => {}))
    else conn.requestPermission = () => new Promise(() => {})
    const controller = new AbortController()
    const response = requestExtensionDialog(
      asAgentConn(conn),
      's1',
      { type: 'extension_ui_request', id: 'pending', method: 'confirm' },
      form,
      controller.signal
    )
    controller.abort()
    assert.deepEqual(await response, { type: 'extension_ui_response', id: 'pending', cancelled: true })
  })
}
