import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const child = spawn(process.execPath, ['dist/index.js'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
const updates = []
let nextId = 0
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'session/update') updates.push(message.params.update)
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
  }
})
child.on('exit', code => {
  for (const request of pending.values()) request.reject(new Error(`Adapter exited: ${code}`))
})
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const timeout = setTimeout(() => {
  for (const request of pending.values()) request.reject(new Error('Workflow smoke timed out'))
  child.kill('SIGTERM')
}, 60000)
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await request('session/new', { cwd, mcpServers: [] })
  const start = updates.length
  const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/workflow list' }] })
  assert.equal(result.stopReason, 'end_turn')
  const output = updates
    .slice(start)
    .filter(update => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
    .map(update => update.content.text)
    .join('\n')
  assert.match(output, /workflow:|WORKFLOWS\s+\d+\s+registered/i, 'Atomic workflow list must stream back through ACP')
  assert.doesNotMatch(output, /unknown command|not supported/i)
  const workflowCommand = updates
    .flatMap(update => (update.sessionUpdate === 'available_commands_update' ? update.availableCommands : []))
    .find(command => command.name === 'workflow')
  assert.ok(workflowCommand?.input?.hint, 'Workflow command and usage hint must be advertised')
  console.log(`Workflow ACP smoke passed:\n${output}`)
} finally {
  clearTimeout(timeout)
  child.kill('SIGTERM')
}
