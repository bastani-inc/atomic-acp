import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandSlashCommand,
  loadSlashCommands,
  loadSlashCommandsFromAtomicGetCommands,
  parseCommandArgs,
  substituteArgs,
  toAvailableCommands
} from '../../src/acp/slash-commands.js'

test('parseCommandArgs: handles quotes', () => {
  assert.deepEqual(parseCommandArgs('a b'), ['a', 'b'])
  assert.deepEqual(parseCommandArgs("'a b' c"), ['a b', 'c'])
  assert.deepEqual(parseCommandArgs('"a b" c'), ['a b', 'c'])
})

test('substituteArgs: replaces Atomic prompt-template arguments', () => {
  assert.equal(
    substituteArgs('x=$1 y=$2 all=$@ args=$ARGUMENTS', ['one', 'two']).trim(),
    'x=one y=two all=one two args=one two'
  )
  assert.equal(substituteArgs('$3', ['one']).trim(), '')
  assert.equal(
    substituteArgs('tail=${@:2} pair=${@:1:2}', ['one', 'two', 'three']).trim(),
    'tail=two three pair=one two'
  )
  assert.equal(
    substituteArgs('zero=${@:0} zeroPair=${@:0:2}', ['one', 'two', 'three']).trim(),
    'zero=one two three zeroPair=one two'
  )
  assert.equal(substituteArgs('all=$@ first=$1', ['$2', 'x']).trim(), 'all=$2 x first=$2')
})

test('expandSlashCommand: expands known command', () => {
  const cmds = [{ name: 'hello', description: '(user)', content: 'Say hi to $1', source: '(user)' }]

  assert.equal(expandSlashCommand('/hello world', cmds as any), 'Say hi to world')
  assert.equal(expandSlashCommand('/unknown world', cmds as any), '/unknown world')
  assert.equal(expandSlashCommand('not a command', cmds as any), 'not a command')
})

test('toAvailableCommands: de-dupes by name (first wins)', () => {
  const cmds = [
    { name: 'x', description: 'first', content: '1', source: '(project)' },
    { name: 'x', description: 'second', content: '2', source: '(user)' }
  ]

  assert.deepEqual(toAvailableCommands(cmds as any), [{ name: 'x', description: 'first' }])
})

test('loadSlashCommands: reads user prompts from ATOMIC_CODING_AGENT_DIR', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-prompts-'))
  const promptsDir = join(root, 'prompts')
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, 'custom.md'), '---\ndescription: Custom prompt\n---\nHello from override\n', 'utf8')

  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = root

  try {
    const commands = loadSlashCommands(root)
    const command = commands.find(c => c.name === 'custom')
    assert.ok(command)
    assert.equal(command?.content, 'Hello from override')
    assert.equal(command?.source, '(user)')
  } finally {
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})

test('loadSlashCommands: reads user prompts from PI_CODING_AGENT_DIR alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-prompts-'))
  const promptsDir = join(root, 'prompts')
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, 'legacy.md'), 'Hello from legacy alias\n', 'utf8')

  const oldAtomicEnv = process.env.ATOMIC_CODING_AGENT_DIR
  const oldPiEnv = process.env.PI_CODING_AGENT_DIR
  delete process.env.ATOMIC_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const commands = loadSlashCommands(root)
    assert.equal(commands.find(c => c.name === 'legacy')?.content, 'Hello from legacy alias\n')
  } finally {
    if (oldAtomicEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldAtomicEnv
    if (oldPiEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldPiEnv
  }
})

test('loadSlashCommands: project prompts override same-named user prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-prompts-'))
  const agentDir = join(root, 'agent')
  const userPromptsDir = join(agentDir, 'prompts')
  const projectPromptsDir = join(root, 'project', '.atomic', 'prompts')
  mkdirSync(userPromptsDir, { recursive: true })
  mkdirSync(projectPromptsDir, { recursive: true })
  writeFileSync(join(userPromptsDir, 'review.md'), 'user template\n', 'utf8')
  writeFileSync(join(projectPromptsDir, 'review.md'), 'project template\n', 'utf8')

  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = agentDir

  try {
    const commands = loadSlashCommands(join(root, 'project'))
    assert.equal(expandSlashCommand('/review hello', commands), 'project template\n')
    assert.deepEqual(
      toAvailableCommands(commands).filter(c => c.name === 'review'),
      [{ name: 'review', description: 'project template (project)' }]
    )
  } finally {
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})

test('loadSlashCommands: reads legacy project .pi prompts and settings prompt paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-prompts-'))
  const project = join(root, 'project')
  const agentDir = join(root, 'agent')
  const legacyPromptsDir = join(project, '.pi', 'prompts')
  const legacyExtraDir = join(project, '.pi', 'extra')
  mkdirSync(legacyPromptsDir, { recursive: true })
  mkdirSync(legacyExtraDir, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(legacyPromptsDir, 'legacy.md'), 'legacy auto\n', 'utf8')
  writeFileSync(join(legacyExtraDir, 'settings.md'), 'legacy settings\n', 'utf8')
  writeFileSync(join(project, '.pi', 'settings.json'), JSON.stringify({ prompts: ['extra/settings.md'] }), 'utf8')

  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = agentDir

  try {
    const commands = loadSlashCommands(project)
    assert.equal(expandSlashCommand('/settings', commands), 'legacy settings\n')
    assert.equal(expandSlashCommand('/legacy', commands), 'legacy auto\n')
  } finally {
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})

test('loadSlashCommands: expands ~ in ATOMIC_CODING_AGENT_DIR', () => {
  const home = mkdtempSync(join(tmpdir(), 'atomic-acp-home-'))
  const agentDir = join(home, 'custom-agent')
  const promptsDir = join(agentDir, 'prompts')
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, 'homecmd.md'), 'Hello from home override\n', 'utf8')

  const oldHome = process.env.HOME
  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.HOME = home
  process.env.ATOMIC_CODING_AGENT_DIR = '~/custom-agent'

  try {
    const commands = loadSlashCommands(home)
    assert.equal(commands.find(c => c.name === 'homecmd')?.content, 'Hello from home override\n')
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})

test('loadSlashCommands: settings prompts take precedence and exclusions remove auto prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-prompts-'))
  const project = join(root, 'project')
  const agentDir = join(root, 'agent')
  const autoDir = join(project, '.atomic', 'prompts')
  const extraDir = join(project, '.atomic', 'extra')
  mkdirSync(autoDir, { recursive: true })
  mkdirSync(extraDir, { recursive: true })
  mkdirSync(agentDir, { recursive: true })

  writeFileSync(join(autoDir, 'review.md'), 'auto review\n', 'utf8')
  writeFileSync(join(autoDir, 'disabled.md'), 'disabled auto\n', 'utf8')
  writeFileSync(join(extraDir, 'review.md'), 'settings review\n', 'utf8')
  writeFileSync(
    join(project, '.atomic', 'settings.json'),
    JSON.stringify({ prompts: ['extra/review.md', '-prompts/disabled.md'] }),
    'utf8'
  )

  const oldEnv = process.env.ATOMIC_CODING_AGENT_DIR
  process.env.ATOMIC_CODING_AGENT_DIR = agentDir

  try {
    const commands = loadSlashCommands(project)
    assert.equal(expandSlashCommand('/review', commands), 'settings review\n')
    assert.equal(expandSlashCommand('/disabled', commands), '/disabled')
  } finally {
    if (oldEnv === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR
    else process.env.ATOMIC_CODING_AGENT_DIR = oldEnv
  }
})

test('loadSlashCommandsFromAtomicGetCommands: uses Atomic settings-aware prompt paths only', () => {
  const root = mkdtempSync(join(tmpdir(), 'atomic-acp-prompts-'))
  const settingsPrompt = join(root, 'settings-review.md')
  const excludedPrompt = join(root, 'excluded.md')
  writeFileSync(settingsPrompt, 'settings content $1\n', 'utf8')
  writeFileSync(excludedPrompt, 'excluded content\n', 'utf8')

  const commands = loadSlashCommandsFromAtomicGetCommands({
    commands: [
      { name: 'review', description: 'Settings review', source: 'prompt', location: 'path', path: settingsPrompt },
      { name: 'x', source: 'extension', path: excludedPrompt }
    ]
  })

  assert.deepEqual(toAvailableCommands(commands), [{ name: 'review', description: 'Settings review' }])
  assert.equal(expandSlashCommand('/review one', commands), 'settings content one\n')
  assert.equal(expandSlashCommand('/x', commands), '/x')
})
