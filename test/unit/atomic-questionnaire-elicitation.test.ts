import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAtomicQuestionElicitationRequest,
  mapCreateElicitationResponseToAtomicQuestionnaireResult,
  normalizeAtomicQuestionnairePayload,
  readClientElicitationSupport
} from '../../src/acp/elicitation/atomic-questionnaire.js'

const validQuestions = [
  {
    question: 'Which package manager should we use?',
    header: 'Pkg mgr',
    options: [
      { label: 'npm', description: 'Use npm lockfiles.', preview: 'package-lock.json' },
      { label: 'pnpm', description: 'Use pnpm workspaces.' }
    ]
  }
]

test('Atomic questionnaire normalization builds single-select ACP form schema and preserves metadata', () => {
  const normalized = normalizeAtomicQuestionnairePayload(validQuestions)
  assert.equal(normalized.ok, true)
  if (!normalized.ok) throw new Error('expected valid questionnaire')

  const request = buildAtomicQuestionElicitationRequest({
    sessionId: 's1',
    atomicRequestId: 'ask-1',
    questions: normalized.questions
  })

  const formRequest = request as any
  assert.equal(formRequest.mode, 'form')
  assert.equal(formRequest.sessionId, 's1')
  assert.equal(formRequest.message, 'Which package manager should we use?')
  assert.deepEqual(formRequest.requestedSchema.required, ['q0'])

  const q0 = formRequest.requestedSchema.properties?.q0 as any
  assert.equal(q0.type, 'string')
  assert.equal(q0.title, 'Pkg mgr')
  assert.deepEqual(q0.oneOf, [
    { const: 'npm', title: 'npm' },
    { const: 'pnpm', title: 'pnpm' }
  ])
  assert.match(q0.description, /npm: Use npm lockfiles\./)
  assert.deepEqual((formRequest._meta as any).atomicAcp.questions[0].options[0], {
    label: 'npm',
    description: 'Use npm lockfiles.',
    preview: 'package-lock.json'
  })
})

test('Atomic questionnaire normalization builds multi-select ACP array schema', () => {
  const normalized = normalizeAtomicQuestionnairePayload([
    {
      question: 'Which features should we enable?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Auth', description: 'Add authentication.' },
        { label: 'Billing', description: 'Add payments.' },
        { label: 'Search', description: 'Add search.' }
      ]
    }
  ])
  assert.equal(normalized.ok, true)
  if (!normalized.ok) throw new Error('expected valid questionnaire')

  const request = buildAtomicQuestionElicitationRequest({
    sessionId: 's1',
    atomicRequestId: 'ask-2',
    questions: normalized.questions
  })
  const q0 = (request as any).requestedSchema.properties?.q0 as any

  assert.equal(q0.type, 'array')
  assert.equal(q0.minItems, 1)
  assert.equal(q0.maxItems, 3)
  assert.deepEqual(q0.items.anyOf, [
    { const: 'Auth', title: 'Auth' },
    { const: 'Billing', title: 'Billing' },
    { const: 'Search', title: 'Search' }
  ])
})

test('Atomic questionnaire normalization rejects invalid Atomic payloads with known errors when available', () => {
  assert.deepEqual(normalizeAtomicQuestionnairePayload([]), {
    ok: false,
    result: { answers: [], cancelled: true, error: 'no_questions' },
    message: 'Atomic questionnaire contained no questions.'
  })

  const duplicateQuestion = normalizeAtomicQuestionnairePayload([validQuestions[0], validQuestions[0]])
  assert.equal(duplicateQuestion.ok, false)
  if (duplicateQuestion.ok) throw new Error('expected invalid questionnaire')
  assert.equal(duplicateQuestion.result.error, 'duplicate_question')

  const duplicateOption = normalizeAtomicQuestionnairePayload([
    {
      question: 'Pick one?',
      header: 'Pick',
      options: [
        { label: 'Same', description: 'First.' },
        { label: 'Same', description: 'Second.' }
      ]
    }
  ])
  assert.equal(duplicateOption.ok, false)
  if (duplicateOption.ok) throw new Error('expected invalid questionnaire')
  assert.equal(duplicateOption.result.error, 'duplicate_option_label')

  const reserved = normalizeAtomicQuestionnairePayload([
    {
      question: 'Pick one?',
      header: 'Pick',
      options: [
        { label: 'Other', description: 'Reserved.' },
        { label: 'Specific', description: 'Allowed.' }
      ]
    }
  ])
  assert.equal(reserved.ok, false)
  if (reserved.ok) throw new Error('expected invalid questionnaire')
  assert.equal(reserved.result.error, 'reserved_label')
})

test('ACP elicitation responses map accept answers to Atomic QuestionnaireResult', () => {
  const normalized = normalizeAtomicQuestionnairePayload([
    validQuestions[0],
    {
      question: 'Which features should we enable?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Auth', description: 'Add authentication.' },
        { label: 'Billing', description: 'Add payments.' }
      ]
    }
  ])
  assert.equal(normalized.ok, true)
  if (!normalized.ok) throw new Error('expected valid questionnaire')

  const mapped = mapCreateElicitationResponseToAtomicQuestionnaireResult(normalized.questions, {
    action: 'accept',
    content: { q0: 'npm', q1: ['Auth', 'Billing'] }
  })

  assert.deepEqual(mapped, {
    answers: [
      {
        questionIndex: 0,
        question: 'Which package manager should we use?',
        kind: 'option',
        answer: 'npm',
        preview: 'package-lock.json'
      },
      {
        questionIndex: 1,
        question: 'Which features should we enable?',
        kind: 'multi',
        answer: null,
        selected: ['Auth', 'Billing']
      }
    ],
    cancelled: false
  })
})

test('ACP decline, cancel, and invalid accept content map to cancelled Atomic QuestionnaireResult', () => {
  const normalized = normalizeAtomicQuestionnairePayload(validQuestions)
  assert.equal(normalized.ok, true)
  if (!normalized.ok) throw new Error('expected valid questionnaire')

  assert.deepEqual(
    mapCreateElicitationResponseToAtomicQuestionnaireResult(normalized.questions, { action: 'decline' }),
    {
      answers: [],
      cancelled: true
    }
  )
  assert.deepEqual(
    mapCreateElicitationResponseToAtomicQuestionnaireResult(normalized.questions, { action: 'cancel' }),
    {
      answers: [],
      cancelled: true
    }
  )
  assert.deepEqual(
    mapCreateElicitationResponseToAtomicQuestionnaireResult(normalized.questions, {
      action: 'accept',
      content: { q0: 'not-an-option' }
    }),
    { answers: [], cancelled: true }
  )
})

test('client elicitation form capability is supported only when form object is present', () => {
  assert.deepEqual(readClientElicitationSupport({ protocolVersion: 1 } as any), {
    form: false,
    reason: 'missing_client_capability'
  })
  assert.deepEqual(
    readClientElicitationSupport({ protocolVersion: 1, clientCapabilities: { elicitation: { form: null } } } as any),
    { form: false, reason: 'missing_client_capability' }
  )
  assert.deepEqual(
    readClientElicitationSupport({ protocolVersion: 1, clientCapabilities: { elicitation: { form: [] } } } as any),
    { form: false, reason: 'missing_client_capability' }
  )
  assert.deepEqual(
    readClientElicitationSupport({ protocolVersion: 1, clientCapabilities: { elicitation: { form: true } } } as any),
    { form: false, reason: 'missing_client_capability' }
  )
  assert.deepEqual(
    readClientElicitationSupport({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } } as any),
    { form: true }
  )
})
