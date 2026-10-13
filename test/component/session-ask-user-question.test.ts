import test from 'node:test'
import assert from 'node:assert/strict'
import { type CreateElicitationResponse } from '@agentclientprotocol/sdk'
import { AtomicAcpSession } from '../../src/acp/session.js'
import {
  MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION,
  type AtomicQuestionnaireRpcSupport
} from '../../src/acp/elicitation/atomic-questionnaire-support.js'
import { FakeAgentSideConnection, FakeAtomicRpcProcess, asAgentConn } from '../helpers/fakes.js'

const SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT: AtomicQuestionnaireRpcSupport = {
  supported: true,
  source: 'atomic_version',
  atomicVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION,
  minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
}

const UNSUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT: AtomicQuestionnaireRpcSupport = {
  supported: false,
  reason: 'atomic_version_too_old',
  atomicVersion: '0.8.25',
  minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
}

const questions = [
  {
    question: 'Which package manager should we use?',
    header: 'Pkg mgr',
    options: [
      { label: 'npm', description: 'Use npm lockfiles.', preview: 'package-lock.json' },
      { label: 'pnpm', description: 'Use pnpm workspaces.' }
    ]
  }
]

function createSession(params: {
  conn: FakeAgentSideConnection
  proc: FakeAtomicRpcProcess
  clientElicitationSupport?: { form: true }
  atomicQuestionnaireRpcSupport?: AtomicQuestionnaireRpcSupport
}): AtomicAcpSession {
  return new AtomicAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: params.proc as any,
    conn: asAgentConn(params.conn),
    fileCommands: [],
    clientElicitationSupport: params.clientElicitationSupport,
    atomicQuestionnaireRpcSupport: params.atomicQuestionnaireRpcSupport
  })
}

test('AtomicAcpSession: bridges Atomic ask_user_question accept to exactly one extension_ui_response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  conn.elicitationResponses.push({ action: 'accept', content: { q0: 'npm' } })

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions })

  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.equal(conn.elicitationRequests.length, 1)
  assert.equal(conn.elicitationRequests[0]!.mode, 'form')
  assert.equal(proc.extensionUiResponses.length, 1)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: {
      answers: [
        {
          questionIndex: 0,
          question: 'Which package manager should we use?',
          kind: 'option',
          answer: 'npm',
          preview: 'package-lock.json'
        }
      ],
      cancelled: false
    }
  })

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('AtomicAcpSession: bridges ACP decline to exactly one cancelled extension_ui_response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  conn.elicitationResponses.push({ action: 'decline' })

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions })

  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.equal(conn.elicitationRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true }
  })

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('AtomicAcpSession: bridges ACP cancel to exactly one cancelled extension_ui_response', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  conn.elicitationResponses.push({ action: 'cancel' })

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions })

  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.equal(conn.elicitationRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true }
  })

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('AtomicAcpSession: unsupported form capability cancels Atomic question without elicitation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const session = createSession({
    conn,
    proc,
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions })

  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true, error: 'no_ui' }
  })
  await waitFor(() =>
    conn.updates.some(update =>
      String((update.update as any).content?.text ?? '').includes('does not advertise form elicitation')
    )
  )

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('AtomicAcpSession: unsupported Atomic extension_ui_request cancels generically without elicitation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: UNSUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-unsupported', method: 'ask_user_question', questions })

  await waitFor(() => proc.extensionUiResponses.length === 1)
  await waitFor(() => unsupportedAtomicMessages(conn).length === 1)

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-unsupported',
    cancelled: true
  })
  assert.equal(unsupportedAtomicMessages(conn).length, 1)

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('AtomicAcpSession: unsupported Atomic ask_user_question tool start emits one-shot message only', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: UNSUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'ask-tool-1', toolName: 'ask_user_question', args: {} })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'ask-tool-2', toolName: 'ask_user_question', args: {} })

  await waitFor(() => unsupportedAtomicMessages(conn).length === 1)

  assert.equal(conn.elicitationRequests.length, 0)
  assert.equal(proc.extensionUiResponses.length, 0)
  assert.equal(unsupportedAtomicMessages(conn).length, 1)

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('AtomicAcpSession: invalid Atomic question payload sends cancelled response without elicitation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions: [] })

  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true, error: 'no_questions' }
  })

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('AtomicAcpSession: session cancel while elicitation is pending writes one cancelled response and aborts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const deferred = createDeferred<CreateElicitationResponse>()
  conn.elicitationResponses.push(deferred.promise)

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions })

  await waitFor(() => conn.elicitationRequests.length === 1)
  await session.cancel()

  assert.equal(proc.abortCount, 1)
  assert.equal(proc.extensionUiResponses.length, 1)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true }
  })

  deferred.resolve({ action: 'accept', content: { q0: 'npm' } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(proc.extensionUiResponses.length, 1)

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
})

test('AtomicAcpSession: settlement while elicitation is pending cancels Atomic question and ignores late accept', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const elicitation = createDeferred<CreateElicitationResponse>()
  conn.elicitationResponses.push(elicitation.promise)

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions })

  await waitFor(() => conn.elicitationRequests.length === 1)
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await prompt, 'end_turn')
  assert.equal(proc.extensionUiResponses.length, 1)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true }
  })

  elicitation.resolve({ action: 'accept', content: { q0: 'npm' } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(proc.extensionUiResponses.length, 1)
  assert.equal(
    proc.extensionUiResponses.some(response => (response as any).questionnaireResult?.cancelled === false),
    false
  )
})

test('AtomicAcpSession: prompt failure while elicitation is pending cancels and ignores late accept', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()
  const elicitation = createDeferred<CreateElicitationResponse>()
  const promptFailure = createDeferred<void>()
  proc.promptPromise = promptFailure.promise
  conn.elicitationResponses.push(elicitation.promise)

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'ask_user_question', questions })

  await waitFor(() => conn.elicitationRequests.length === 1)
  promptFailure.reject(new Error('Atomic prompt failed'))
  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true }
  })
  assert.equal(await prompt, 'error')

  elicitation.resolve({ action: 'accept', content: { q0: 'npm' } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(proc.extensionUiResponses.length, 1)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-1',
    questionnaireResult: { answers: [], cancelled: true }
  })
})

test('AtomicAcpSession: prompt failure cleanup terminal guard cancels late ask_user_question without elicitation', async () => {
  const conn = new BlockingFirstSessionUpdateConnection()
  const proc = new FakeAtomicRpcProcess()
  proc.promptError = new Error('Atomic prompt failed')

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  await conn.firstUpdateStarted.promise
  await Promise.resolve()

  proc.emit({ type: 'extension_ui_request', id: 'ask-late', method: 'ask_user_question', questions })

  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-late',
    questionnaireResult: { answers: [], cancelled: true }
  })

  conn.releaseFirstUpdate.resolve()
  assert.equal(await prompt, 'error')
  assert.equal(conn.elicitationRequests.length, 0)
  assert.equal(proc.extensionUiResponses.length, 1)
})

test('AtomicAcpSession: session cancel before late ask_user_question cancels without elicitation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakeAtomicRpcProcess()

  const session = createSession({
    conn,
    proc,
    clientElicitationSupport: { form: true },
    atomicQuestionnaireRpcSupport: SUPPORTED_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT
  })

  const prompt = session.prompt('go')
  proc.emit({ type: 'agent_start' })
  await session.cancel()
  proc.emit({ type: 'extension_ui_request', id: 'ask-late', method: 'ask_user_question', questions })

  await waitFor(() => proc.extensionUiResponses.length === 1)

  assert.equal(conn.elicitationRequests.length, 0)
  assert.equal(proc.extensionUiResponses.length, 1)
  assert.equal(proc.abortCount, 1)
  assert.deepEqual(proc.extensionUiResponses[0], {
    type: 'extension_ui_response',
    id: 'ask-late',
    questionnaireResult: { answers: [], cancelled: true }
  })

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.extensionUiResponses.length, 1)
})

class BlockingFirstSessionUpdateConnection extends FakeAgentSideConnection {
  readonly firstUpdateStarted = createDeferred<void>()
  readonly releaseFirstUpdate = createDeferred<void>()
  private blockNextUpdate = true

  override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
    if (this.blockNextUpdate) {
      this.blockNextUpdate = false
      this.firstUpdateStarted.resolve()
      await this.releaseFirstUpdate.promise
    }

    await super.sessionUpdate(msg)
  }
}

function unsupportedAtomicMessages(conn: FakeAgentSideConnection): string[] {
  return conn.updates
    .map(update => String((update.update as any).content?.text ?? ''))
    .filter(text => text.includes('does not support ask_user_question questionnaire RPC'))
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
