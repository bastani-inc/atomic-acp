import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectAtomicQuestionnaireRpcSupport,
  MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
} from '../../src/acp/elicitation/atomic-questionnaire-support.js'

test('Atomic questionnaire RPC support detection gates current Atomic versions unsupported', () => {
  const stableCurrent = detectAtomicQuestionnaireRpcSupport({ versionOutput: '0.8.25' })
  assert.equal(stableCurrent.supported, false)
  assert.equal(stableCurrent.atomicVersion, '0.8.25')

  const prereleaseCurrent = detectAtomicQuestionnaireRpcSupport({ versionOutput: 'atomic v0.8.26-alpha.1' })
  assert.equal(prereleaseCurrent.supported, false)
  assert.equal(prereleaseCurrent.atomicVersion, '0.8.26-alpha.1')
})

test('Atomic questionnaire RPC support detection treats unknown and pre-release versions as unsupported', () => {
  const unknown = detectAtomicQuestionnaireRpcSupport({ versionOutput: 'not a semver version' })
  assert.equal(unknown.supported, false)
  if (unknown.supported) throw new Error('expected unknown version to be unsupported')
  assert.equal(unknown.reason, 'atomic_version_unknown')

  const futurePrerelease = detectAtomicQuestionnaireRpcSupport({
    versionOutput: `${MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION}-alpha.1`
  })
  assert.equal(futurePrerelease.supported, false)
  if (futurePrerelease.supported) throw new Error('expected pre-release to be unsupported')
  assert.equal(futurePrerelease.reason, 'atomic_version_too_old')
})

test('Atomic questionnaire RPC support detection accepts explicit capability or provisional future minimum', () => {
  const explicitCapability = detectAtomicQuestionnaireRpcSupport({
    versionOutput: '0.8.25',
    rpcCapabilities: { rpcCapabilities: { askUserQuestion: true } }
  })
  assert.deepEqual(explicitCapability, {
    supported: true,
    source: 'atomic_rpc_capability',
    atomicVersion: '0.8.25'
  })

  const futureVersion = detectAtomicQuestionnaireRpcSupport({
    versionOutput: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
  })
  assert.deepEqual(futureVersion, {
    supported: true,
    source: 'atomic_version',
    atomicVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION,
    minimumVersion: MIN_ATOMIC_ASK_USER_QUESTION_RPC_VERSION
  })
})
