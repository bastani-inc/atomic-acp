import type {
  AgentSideConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  InitializeRequest
} from '@agentclientprotocol/sdk'

export type ClientElicitationSupport = { form: true } | { form: false; reason: 'missing_client_capability' }

export type AtomicQuestionnaireError =
  | 'no_ui'
  | 'no_questions'
  | 'empty_options'
  | 'too_many_questions'
  | 'duplicate_question'
  | 'duplicate_option_label'
  | 'reserved_label'

export type AtomicQuestionOption = {
  label: string
  description: string
  preview?: string
}

export type AtomicQuestion = {
  question: string
  header: string
  options: AtomicQuestionOption[]
  multiSelect: boolean
}

export type AtomicQuestionAnswer = {
  questionIndex: number
  question: string
  kind: 'option' | 'custom' | 'chat' | 'multi'
  answer: string | null
  selected?: string[]
  notes?: string
  preview?: string
}

export type AtomicQuestionnaireResult = {
  answers: AtomicQuestionAnswer[]
  cancelled: boolean
  error?: AtomicQuestionnaireError
}

export type AtomicAskUserQuestionEvent = {
  type: 'extension_ui_request'
  id: string
  method: 'ask_user_question'
  questions: unknown
}

type NormalizeAtomicQuestionnaireFailure = { ok: false; result: AtomicQuestionnaireResult; message: string }

type NormalizeAtomicQuestionResult = { ok: true; question: AtomicQuestion } | NormalizeAtomicQuestionnaireFailure

type NormalizeAtomicQuestionOptionsResult =
  | { ok: true; options: AtomicQuestionOption[] }
  | NormalizeAtomicQuestionnaireFailure

type NormalizeAtomicQuestionOptionResult =
  | { ok: true; option: AtomicQuestionOption }
  | NormalizeAtomicQuestionnaireFailure

export type NormalizeAtomicQuestionnaireResult =
  | { ok: true; questions: AtomicQuestion[] }
  | NormalizeAtomicQuestionnaireFailure

export type AtomicQuestionElicitationResponse = {
  result: AtomicQuestionnaireResult
  invalidAcceptContent: boolean
}

const MAX_QUESTIONS = 4
const MIN_OPTIONS = 2
const MAX_OPTIONS = 4
const RESERVED_LABELS = new Set(['Other', 'Type something.', 'Chat about this', 'Next'])

export const NO_CLIENT_ELICITATION_SUPPORT: ClientElicitationSupport = {
  form: false,
  reason: 'missing_client_capability'
}

export function readClientElicitationSupport(params: InitializeRequest): ClientElicitationSupport {
  const form = params.clientCapabilities?.elicitation?.form
  if (form !== null && typeof form === 'object' && !Array.isArray(form)) {
    return { form: true }
  }

  return NO_CLIENT_ELICITATION_SUPPORT
}

export function isAtomicAskUserQuestionEvent(ev: unknown): ev is AtomicAskUserQuestionEvent {
  const record = asRecord(ev)
  return (
    record !== null &&
    record.type === 'extension_ui_request' &&
    record.method === 'ask_user_question' &&
    typeof record.id === 'string'
  )
}

export function cancelledAtomicQuestionnaireResult(error?: AtomicQuestionnaireError): AtomicQuestionnaireResult {
  return error ? { answers: [], cancelled: true, error } : { answers: [], cancelled: true }
}

export function normalizeAtomicQuestionnairePayload(payload: unknown): NormalizeAtomicQuestionnaireResult {
  if (!Array.isArray(payload)) {
    return invalidQuestionnaire('Malformed Atomic questionnaire payload.')
  }

  if (payload.length === 0) {
    return invalidQuestionnaire('Atomic questionnaire contained no questions.', 'no_questions')
  }

  if (payload.length > MAX_QUESTIONS) {
    return invalidQuestionnaire('Atomic questionnaire contained too many questions.', 'too_many_questions')
  }

  const questions: AtomicQuestion[] = []
  const seenQuestions = new Set<string>()

  for (const rawQuestion of payload) {
    const normalizedQuestion = normalizeAtomicQuestion(rawQuestion, seenQuestions)
    if (!normalizedQuestion.ok) return normalizedQuestion
    questions.push(normalizedQuestion.question)
  }

  return { ok: true, questions }
}

function normalizeAtomicQuestion(rawQuestion: unknown, seenQuestions: Set<string>): NormalizeAtomicQuestionResult {
  const questionRecord = asRecord(rawQuestion)
  if (!questionRecord) return invalidQuestionnaire('Malformed Atomic questionnaire question.')

  const question = questionRecord.question
  const header = questionRecord.header
  const rawOptions = questionRecord.options
  const rawMultiSelect = questionRecord.multiSelect

  if (typeof question !== 'string' || typeof header !== 'string' || !Array.isArray(rawOptions)) {
    return invalidQuestionnaire('Malformed Atomic questionnaire question.')
  }

  if (rawMultiSelect !== undefined && typeof rawMultiSelect !== 'boolean') {
    return invalidQuestionnaire('Malformed Atomic questionnaire multiSelect flag.')
  }

  if (seenQuestions.has(question)) {
    return invalidQuestionnaire('Atomic questionnaire contained duplicate question text.', 'duplicate_question')
  }
  seenQuestions.add(question)

  const normalizedOptions = normalizeAtomicQuestionOptions(rawOptions)
  if (!normalizedOptions.ok) return normalizedOptions

  return {
    ok: true,
    question: {
      question,
      header,
      options: normalizedOptions.options,
      multiSelect: rawMultiSelect === true
    }
  }
}

function normalizeAtomicQuestionOptions(rawOptions: unknown[]): NormalizeAtomicQuestionOptionsResult {
  if (rawOptions.length < MIN_OPTIONS) {
    return invalidQuestionnaire('Atomic questionnaire question contained too few options.', 'empty_options')
  }

  if (rawOptions.length > MAX_OPTIONS) {
    return invalidQuestionnaire('Atomic questionnaire question contained too many options.')
  }

  const options: AtomicQuestionOption[] = []
  const seenLabels = new Set<string>()

  for (const rawOption of rawOptions) {
    const normalizedOption = normalizeAtomicQuestionOption(rawOption, seenLabels)
    if (!normalizedOption.ok) return normalizedOption
    options.push(normalizedOption.option)
  }

  return { ok: true, options }
}

function normalizeAtomicQuestionOption(
  rawOption: unknown,
  seenLabels: Set<string>
): NormalizeAtomicQuestionOptionResult {
  const optionRecord = asRecord(rawOption)
  if (!optionRecord) return invalidQuestionnaire('Malformed Atomic questionnaire option.')

  const label = optionRecord.label
  const description = optionRecord.description
  const preview = optionRecord.preview

  if (typeof label !== 'string' || typeof description !== 'string') {
    return invalidQuestionnaire('Malformed Atomic questionnaire option.')
  }

  if (preview !== undefined && typeof preview !== 'string') {
    return invalidQuestionnaire('Malformed Atomic questionnaire option preview.')
  }

  if (RESERVED_LABELS.has(label)) {
    return invalidQuestionnaire('Atomic questionnaire option used a reserved label.', 'reserved_label')
  }

  if (seenLabels.has(label)) {
    return invalidQuestionnaire('Atomic questionnaire contained duplicate option labels.', 'duplicate_option_label')
  }
  seenLabels.add(label)

  return {
    ok: true,
    option: preview === undefined ? { label, description } : { label, description, preview }
  }
}

export function buildAtomicQuestionElicitationRequest(params: {
  sessionId: string
  atomicRequestId: string
  questions: AtomicQuestion[]
}): CreateElicitationRequest {
  const properties: Record<string, ElicitationPropertySchema> = {}
  const required: string[] = []

  params.questions.forEach((question, index) => {
    const key = questionPropertyKey(index)
    required.push(key)
    properties[key] = buildQuestionProperty(question)
  })

  return {
    mode: 'form',
    sessionId: params.sessionId,
    message: buildElicitationMessage(params.questions),
    requestedSchema: {
      type: 'object',
      title: 'Atomic question',
      description: 'Atomic is requesting structured user input to continue this turn.',
      properties,
      required
    },
    _meta: {
      atomicAcp: {
        kind: 'ask_user_question',
        atomicRequestId: params.atomicRequestId,
        questions: params.questions.map(toAtomicQuestionMetadata)
      }
    }
  }
}

export function mapCreateElicitationResponseToAtomicQuestionnaireResult(
  questions: AtomicQuestion[],
  response: CreateElicitationResponse
): AtomicQuestionnaireResult {
  if (response.action !== 'accept') return cancelledAtomicQuestionnaireResult()

  const content = asRecord(response.content)
  if (!content) return cancelledAtomicQuestionnaireResult()

  const answers: AtomicQuestionAnswer[] = []

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!
    const value = content[questionPropertyKey(index)]

    if (question.multiSelect) {
      const selected = validateMultiSelectAnswer(question, value)
      if (!selected) return cancelledAtomicQuestionnaireResult()

      answers.push({
        questionIndex: index,
        question: question.question,
        kind: 'multi',
        answer: null,
        selected
      })
      continue
    }

    const selected = validateSingleSelectAnswer(question, value)
    if (!selected) return cancelledAtomicQuestionnaireResult()

    answers.push({
      questionIndex: index,
      question: question.question,
      kind: 'option',
      answer: selected.label,
      ...(selected.preview !== undefined ? { preview: selected.preview } : {})
    })
  }

  return { answers, cancelled: false }
}

export function createFormElicitation(
  conn: Pick<AgentSideConnection, 'unstable_createElicitation'>,
  request: CreateElicitationRequest
): Promise<CreateElicitationResponse> {
  return conn.unstable_createElicitation(request)
}

export async function createAtomicQuestionElicitation(params: {
  conn: Pick<AgentSideConnection, 'unstable_createElicitation'>
  sessionId: string
  atomicRequestId: string
  questions: AtomicQuestion[]
}): Promise<AtomicQuestionElicitationResponse> {
  try {
    const response = await createFormElicitation(
      params.conn,
      buildAtomicQuestionElicitationRequest({
        sessionId: params.sessionId,
        atomicRequestId: params.atomicRequestId,
        questions: params.questions
      })
    )
    const result = mapCreateElicitationResponseToAtomicQuestionnaireResult(params.questions, response)
    return { result, invalidAcceptContent: response.action === 'accept' && result.cancelled }
  } catch {
    return { result: cancelledAtomicQuestionnaireResult('no_ui'), invalidAcceptContent: false }
  }
}

function buildQuestionProperty(question: AtomicQuestion): ElicitationPropertySchema {
  const optionSchemas = question.options.map(option => ({ const: option.label, title: option.label }))

  if (question.multiSelect) {
    return {
      type: 'array',
      title: question.header,
      description: describeQuestion(question),
      items: { anyOf: optionSchemas },
      minItems: 1,
      maxItems: question.options.length
    }
  }

  return {
    type: 'string',
    title: question.header,
    description: describeQuestion(question),
    oneOf: optionSchemas
  }
}

function toAtomicQuestionMetadata(question: AtomicQuestion): AtomicQuestion {
  return {
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map(option => ({
      label: option.label,
      description: option.description,
      ...(option.preview !== undefined ? { preview: option.preview } : {})
    }))
  }
}

function buildElicitationMessage(questions: AtomicQuestion[]): string {
  if (questions.length === 1) return questions[0]!.question
  return `Atomic is asking ${questions.length} questions before continuing.`
}

function describeQuestion(question: AtomicQuestion): string {
  const lines = [question.question]
  if (question.multiSelect) lines.push('Select one or more options.')
  lines.push('', 'Options:', ...question.options.map(option => `${option.label}: ${option.description}`))
  return lines.join('\n')
}

function validateSingleSelectAnswer(question: AtomicQuestion, value: unknown): AtomicQuestionOption | null {
  if (typeof value !== 'string') return null
  return question.options.find(option => option.label === value) ?? null
}

function validateMultiSelectAnswer(question: AtomicQuestion, value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (value.length < 1 || value.length > question.options.length) return null

  const validLabels = new Set(question.options.map(option => option.label))
  const seenLabels = new Set<string>()
  const selected: string[] = []

  for (const item of value) {
    if (typeof item !== 'string') return null
    if (!validLabels.has(item)) return null
    if (seenLabels.has(item)) return null
    seenLabels.add(item)
    selected.push(item)
  }

  return selected
}

function questionPropertyKey(index: number): string {
  return `q${index}`
}

function invalidQuestionnaire(message: string, error?: AtomicQuestionnaireError): NormalizeAtomicQuestionnaireFailure {
  return { ok: false, result: cancelledAtomicQuestionnaireResult(error), message }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
