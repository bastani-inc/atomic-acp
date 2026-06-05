export const MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION = '1.0.0'

export type AtomicQuestionnaireRpcSupport =
  | {
      supported: true
      source: 'atomic_version' | 'atomic_rpc_capability'
      atomicVersion?: string
      minimumVersion?: string
    }
  | {
      supported: false
      reason: 'atomic_version_too_old' | 'atomic_version_unknown' | 'atomic_rpc_capability_missing'
      atomicVersion?: string
      minimumVersion?: string
    }

export type AtomicQuestionnaireRpcSupportDetectionInput = {
  atomicVersion?: string | null
  versionOutput?: string | null
  rpcCapabilities?: unknown
}

export const NO_ATOMIC_QUESTIONNAIRE_RPC_SUPPORT: AtomicQuestionnaireRpcSupport = {
  supported: false,
  reason: 'atomic_version_unknown',
  minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
}

type SemverParts = {
  major: number
  minor: number
  patch: number
  prerelease: string | null
  normalized: string
}

const VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?(?:\s|$)/
const MAX_CAPABILITY_DEPTH = 4

export function detectAtomicQuestionnaireRpcSupport(
  input: AtomicQuestionnaireRpcSupportDetectionInput = {}
): AtomicQuestionnaireRpcSupport {
  const atomicVersion = normalizeAtomicVersion(input.atomicVersion ?? input.versionOutput)

  if (hasExplicitAtomicQuestionnaireRpcCapability(input.rpcCapabilities)) {
    return {
      supported: true,
      source: 'atomic_rpc_capability',
      ...(atomicVersion ? { atomicVersion } : {})
    }
  }

  if (!atomicVersion) {
    return {
      supported: false,
      reason: input.rpcCapabilities === undefined ? 'atomic_version_unknown' : 'atomic_rpc_capability_missing',
      minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
    }
  }

  const parsedVersion = parseSemver(atomicVersion)
  const minimumVersion = parseSemver(MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION)

  if (!parsedVersion || !minimumVersion) {
    return {
      supported: false,
      reason: 'atomic_version_unknown',
      atomicVersion,
      minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
    }
  }

  if (parsedVersion.prerelease || compareSemverParts(parsedVersion, minimumVersion) < 0) {
    return {
      supported: false,
      reason: 'atomic_version_too_old',
      atomicVersion: parsedVersion.normalized,
      minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
    }
  }

  return {
    supported: true,
    source: 'atomic_version',
    atomicVersion: parsedVersion.normalized,
    minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
  }
}

export function normalizeAtomicVersion(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null

  const match = VERSION_PATTERN.exec(raw)
  return match?.[1] ?? null
}

export function hasExplicitAtomicQuestionnaireRpcCapability(value: unknown): boolean {
  return hasExplicitAtomicQuestionnaireRpcCapabilityAtDepth(value, 0)
}

function hasExplicitAtomicQuestionnaireRpcCapabilityAtDepth(value: unknown, depth: number): boolean {
  const record = asRecord(value)
  if (!record || depth > MAX_CAPABILITY_DEPTH) return false

  if (
    record.askUserQuestion === true ||
    record.ask_user_question === true ||
    record.questionnaireRpc === true ||
    record.questionnaire_rpc === true
  ) {
    return true
  }

  const extensionUi = asRecord(record.extensionUi) ?? asRecord(record.extension_ui)
  if (extensionUi?.askUserQuestion === true || extensionUi?.ask_user_question === true) return true

  const questionnaireRpc = asRecord(record.questionnaireRpc) ?? asRecord(record.questionnaire_rpc)
  if (questionnaireRpc?.askUserQuestion === true || questionnaireRpc?.ask_user_question === true) return true

  const nestedKeys =
    depth === 0
      ? ['rpcCapabilities', 'rpc_capabilities', 'atomicRpc', 'atomic_rpc']
      : ['rpcCapabilities', 'rpc_capabilities', 'capabilities', 'atomicRpc', 'atomic_rpc']

  for (const key of nestedKeys) {
    if (hasExplicitAtomicQuestionnaireRpcCapabilityAtDepth(record[key], depth + 1)) return true
  }

  return false
}

function parseSemver(value: string): SemverParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (!match) return null

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null

  const prerelease = match[4] ?? null
  return {
    major,
    minor,
    patch,
    prerelease,
    normalized: prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`
  }
}

function compareSemverParts(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return Math.sign(a.major - b.major)
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor)
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch)
  return 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
