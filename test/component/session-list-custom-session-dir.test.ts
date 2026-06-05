import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAtomicSessionsDir, listAtomicSessions } from '../../src/acp/atomic-sessions.js'

test('getAtomicSessionsDir: ATOMIC_CODING_AGENT_SESSION_DIR overrides settings.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const envSessionsDir = join(root, 'env-sessions')
  mkdirSync(envSessionsDir, { recursive: true })
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: join(root, 'settings-sessions') }), 'utf8')

  const oldAgentDir = process.env.ATOMIC_CODING_AGENT_DIR
  const oldSessionDir = process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  process.env.ATOMIC_CODING_AGENT_SESSION_DIR = envSessionsDir

  try {
    assert.equal(getAtomicSessionsDir(), envSessionsDir)
  } finally {
    if (oldAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldAgentDir
    if (oldSessionDir === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
    else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = oldSessionDir
  }
})

test('getAtomicSessionsDir: expands ~ in session dir overrides', () => {
  const oldSessionDir = process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  process.env.ATOMIC_CODING_AGENT_SESSION_DIR = '~/atomic-acp-sessions'

  try {
    assert.equal(getAtomicSessionsDir('/tmp/project'), join(homedir(), 'atomic-acp-sessions'))
  } finally {
    if (oldSessionDir === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
    else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = oldSessionDir
  }
})

test('getAtomicSessionsDir: PI_CODING_AGENT_SESSION_DIR alias overrides settings.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const envSessionsDir = join(root, 'legacy-env-sessions')
  mkdirSync(envSessionsDir, { recursive: true })
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: join(root, 'settings-sessions') }), 'utf8')

  const oldAgentDir = process.env.ATOMIC_CODING_AGENT_DIR
  const oldAtomicSessionDir = process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  const oldPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = envSessionsDir

  try {
    assert.equal(getAtomicSessionsDir(), envSessionsDir)
  } finally {
    if (oldAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldAgentDir
    if (oldAtomicSessionDir === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
    else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = oldAtomicSessionDir
    if (oldPiSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = oldPiSessionDir
  }
})

test('getAtomicSessionsDir: project settings override global settings when cwd is provided', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const project = join(root, 'project')
  mkdirSync(join(project, '.atomic'), { recursive: true })
  const globalSessions = join(root, 'global-sessions')
  const projectSessions = join(project, 'project-sessions')
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: globalSessions }), 'utf8')
  writeFileSync(join(project, '.atomic', 'settings.json'), JSON.stringify({ sessionDir: 'project-sessions' }), 'utf8')

  const oldAgentDir = process.env.ATOMIC_CODING_AGENT_DIR
  const oldSessionDir = process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR

  try {
    assert.equal(getAtomicSessionsDir(project), projectSessions)
  } finally {
    if (oldAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldAgentDir
    if (oldSessionDir === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
    else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = oldSessionDir
  }
})

test('getAtomicSessionsDir: legacy project .pi settings are honored', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const project = join(root, 'project')
  mkdirSync(join(project, '.pi'), { recursive: true })
  writeFileSync(join(project, '.pi', 'settings.json'), JSON.stringify({ sessionDir: 'legacy-sessions' }), 'utf8')

  const oldAgentDir = process.env.ATOMIC_CODING_AGENT_DIR
  const oldPiAgentDir = process.env.PI_CODING_AGENT_DIR
  const oldSessionDir = process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  const oldPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  delete process.env.ATOMIC_CODING_AGENT_DIR
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  delete process.env.PI_CODING_AGENT_SESSION_DIR

  try {
    assert.equal(getAtomicSessionsDir(project), join(project, 'legacy-sessions'))
  } finally {
    if (oldAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldAgentDir
    if (oldPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldPiAgentDir
    if (oldSessionDir === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
    else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = oldSessionDir
    if (oldPiSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = oldPiSessionDir
  }
})

test('getAtomicSessionsDir: global relative sessionDir resolves against Atomic cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ sessionDir: 'rel-sessions' }), 'utf8')

  const oldAgentDir = process.env.ATOMIC_CODING_AGENT_DIR
  const oldSessionDir = process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR

  try {
    assert.equal(getAtomicSessionsDir(project), join(project, 'rel-sessions'))
  } finally {
    if (oldAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldAgentDir
    if (oldSessionDir === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
    else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = oldSessionDir
  }
})

test('listAtomicSessions: respects sessionDir from Atomic settings.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-test-'))
  const customSessionsDir = join(root, 'somewhere-else', '--p--')
  mkdirSync(customSessionsDir, { recursive: true })

  writeFileSync(
    join(root, 'settings.json'),
    JSON.stringify({ sessionDir: join(root, 'somewhere-else') }, null, 2),
    'utf8'
  )

  writeFileSync(
    join(customSessionsDir, 's.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-custom',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'hi' }
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldAgentDir = process.env.ATOMIC_CODING_AGENT_DIR
  const oldSessionDir = process.env.ATOMIC_CODING_AGENT_SESSION_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root
  delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR

  try {
    const s = listAtomicSessions().find(x => x.sessionId === 'sess-custom')
    assert.ok(s)
    assert.equal(s?.sessionFile, join(customSessionsDir, 's.jsonl'))
  } finally {
    if (oldAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldAgentDir
    if (oldSessionDir === undefined) delete process.env.ATOMIC_CODING_AGENT_SESSION_DIR
    else process.env.ATOMIC_CODING_AGENT_SESSION_DIR = oldSessionDir
  }
})
