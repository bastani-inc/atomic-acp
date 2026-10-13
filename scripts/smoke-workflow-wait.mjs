// Real-Atomic smoke test: a prompt that starts a workflow stays open until the run ends.
// Writes a project workflow with one ~3 s ctx.tool step, runs `/workflow sleepy` over ACP and checks
// that session/prompt returns only after the run completed, with its result in the streamed updates.
// Then it kills Atomic during a 20 s workflow step: that prompt must fail with a JSON-RPC error and a
// failed run, and the next prompt must run on a restarted Atomic that still has the conversation.
// Needs `npm run build` and an Atomic provider login; skips when Atomic has no usable model.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = 'sleepy-done-7f3a'
const workspace = await mkdtemp(join(tmpdir(), 'atomic-acp-workflow-wait-'))
await mkdir(join(workspace, '.atomic', 'workflows'), { recursive: true })
await writeFile(
  join(workspace, '.atomic', 'workflows', 'sleepy.ts'),
  `import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export default workflow({
  name: "sleepy",
  description: "Sleep about three seconds in a durable tool step and return a marker.",
  inputs: {},
  outputs: { marker: Type.String({ description: "Marker proving the run finished." }) },
  run: async (ctx) => {
    const marker = await ctx.tool("sleep", { ms: 3000 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return "${MARKER}";
    });
    return { marker };
  },
});
`
)

await writeFile(
  join(workspace, '.atomic', 'workflows', 'slow.ts'),
  `import { workflow } from "@bastani/atomic/workflows";

export default workflow({
  name: "slow",
  description: "Sleep twenty seconds in a durable tool step.",
  inputs: {},
  outputs: {},
  run: async (ctx) => {
    await ctx.tool("sleep", { ms: 20000 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20000));
      return "slow-done";
    });
    return {};
  },
});
`
)
const WORD = `kumquat${Math.random().toString(36).slice(2, 6)}`

const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url))
// --approve trusts the temporary project so Atomic loads its workflow.
const child = spawn(process.execPath, [entrypoint, '--', '--approve'], {
  cwd: workspace,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32'
})
const pending = new Map()
const updates = []
let nextId = 0
let buffer = ''
let stderr = ''

function failPending(error) {
  for (const { reject } of pending.values()) reject(error)
  pending.clear()
}

child.on('error', failPending)
child.on('exit', (code, signal) => {
  failPending(new Error(`Adapter exited before response (code=${code}, signal=${signal}). ${stderr}`))
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => {
  stderr = (stderr + chunk).slice(-8000)
})
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request.reject(Object.assign(new Error(JSON.stringify(message.error)), message.error))
      else request.resolve(message.result)
      continue
    }
    if (message.method === 'session/update') updates.push({ at: Date.now(), update: message.params.update })
  }
})

function request(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const timeout = setTimeout(
  () => failPending(new Error(`Workflow wait smoke timed out after 300 seconds. ${stderr}`)),
  300000
)
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  let session
  try {
    session = await request('session/new', { cwd: workspace, mcpServers: [] })
  } catch (error) {
    if (error.code !== -32000) throw error
    console.log('Workflow wait smoke skipped: Atomic has no provider login. Run `atomic` and sign in, then retry.')
  }

  if (session) {
    if (process.env.ATOMIC_ACP_SMOKE_MODEL) {
      await request('session/set_model', { sessionId: session.sessionId, modelId: process.env.ATOMIC_ACP_SMOKE_MODEL })
    }
    const start = updates.length
    const startedAt = Date.now()
    const result = await request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/workflow sleepy' }]
    })
    const returnedAt = Date.now()
    assert.equal(result.stopReason, 'end_turn')
    assert.ok(
      returnedAt - startedAt >= 3000,
      `The prompt returned after ${returnedAt - startedAt} ms, before the 3 s step`
    )

    const turnUpdates = updates.slice(start).map(entry => entry.update)
    const runUpdates = turnUpdates.filter(
      update =>
        (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
        String(update.toolCallId).startsWith('workflow-run-')
    )
    assert.ok(runUpdates.length > 0, 'Expected a tool call tracking the workflow run')
    assert.ok(
      runUpdates.some(update => update.status === 'completed'),
      `The prompt returned before the run completed: ${JSON.stringify(runUpdates)}`
    )
    assert.match(JSON.stringify(turnUpdates), new RegExp(MARKER), 'Expected the run result in the prompt updates')
    console.log(
      `Workflow wait smoke passed: /workflow sleepy returned after ${returnedAt - startedAt} ms with ${MARKER} in the run updates`
    )

    if (process.platform !== 'win32') {
      const remember = await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `Remember the word ${WORD}. Reply with just OK.` }]
      })
      assert.equal(remember.stopReason, 'end_turn')

      const killStart = updates.length
      const slow = request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/workflow slow' }]
      }).then(
        result => ({ result }),
        error => ({ error })
      )
      const runOpened = () =>
        updates
          .slice(killStart)
          .some(
            ({ update }) =>
              update.sessionUpdate === 'tool_call' && String(update.toolCallId).startsWith('workflow-run-')
          )
      for (let i = 0; i < 300 && !runOpened(); i += 1) await new Promise(resolve => setTimeout(resolve, 100))
      assert.ok(runOpened(), 'The slow workflow run never started')
      const atomicPids = execFileSync('ps', ['-o', 'pid=', '--ppid', String(child.pid)], { encoding: 'utf8' })
        .split('\n')
        .map(line => Number(line.trim()))
        .filter(Boolean)
      assert.ok(atomicPids.length > 0, 'Could not find the Atomic process')
      for (const pid of atomicPids) process.kill(pid, 'SIGKILL')

      const outcome = await slow
      assert.ok(outcome.error, `A prompt whose Atomic was killed must fail, got ${JSON.stringify(outcome.result)}`)
      assert.equal(outcome.error.code, -32603)
      assert.match(outcome.error.message, /Atomic exited.*SIGKILL/)
      const killUpdates = updates.slice(killStart).map(entry => entry.update)
      const openCalls = new Set(
        killUpdates.filter(update => update.sessionUpdate === 'tool_call').map(update => update.toolCallId)
      )
      for (const toolCallId of openCalls) {
        const last = killUpdates.filter(update => update.toolCallId === toolCallId).at(-1)
        assert.ok(
          last.status === 'failed' || last.status === 'completed',
          `${toolCallId} was left ${last.status} after Atomic died`
        )
      }
      const runCall = [...openCalls].find(id => String(id).startsWith('workflow-run-'))
      assert.equal(killUpdates.filter(update => update.toolCallId === runCall).at(-1).status, 'failed')

      const recallStart = updates.length
      const recall = await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'What word did I ask you to remember? Reply with the word only.' }]
      })
      assert.equal(recall.stopReason, 'end_turn')
      const recallText = updates
        .slice(recallStart)
        .filter(({ update }) => update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text')
        .map(({ update }) => update.content.text)
        .join('')
      assert.match(recallText, new RegExp(WORD), 'The restarted Atomic must keep the conversation')
      console.log(
        `Atomic exit smoke passed: killing Atomic mid-workflow failed the prompt (${outcome.error.message}); the next prompt restarted Atomic and recalled ${WORD}`
      )
    }
  }
} finally {
  clearTimeout(timeout)
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit')
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGTERM')
    }
  } else {
    child.kill('SIGTERM')
  }
  await exited
  await rm(workspace, { recursive: true, force: true })
}
