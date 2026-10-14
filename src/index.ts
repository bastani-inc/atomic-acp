import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { AtomicAcpAgent, readNearestPackageJson } from './acp/agent.js'
import { getAtomicCommand, parseAtomicExtraArgs, shouldUseShellForAtomicCommand } from './atomic-rpc/command.js'
import { parseCliArgs, USAGE } from './cli.js'

// Pipe writes can be asynchronous, so let the output flush before exiting.
async function writeAndExit(stream: NodeJS.WriteStream, text: string, code: number): Promise<never> {
  await new Promise<void>(resolve => stream.write(text, () => resolve()))
  process.exit(code)
}

const cli = parseCliArgs(process.argv)

if ('error' in cli) {
  await writeAndExit(process.stderr, `atomic-acp: ${cli.error}\nRun 'atomic-acp --help' for usage.\n`, 2)
} else if (cli.command === 'help') {
  await writeAndExit(process.stdout, USAGE, 0)
} else if (cli.command === 'version') {
  await writeAndExit(process.stdout, `atomic-acp ${readNearestPackageJson(import.meta.url).version ?? '0.0.0'}\n`, 0)
}

// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if ('command' in cli && cli.command === 'terminal-login') {
  const { spawnSync } = await import('node:child_process')
  const cmd = getAtomicCommand(process.env.ATOMIC_ACP_ATOMIC_COMMAND)
  const res = spawnSync(cmd, [], {
    stdio: 'inherit',
    env: process.env,
    shell: shouldUseShellForAtomicCommand(cmd)
  })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `atomic-acp: could not start Atomic (command not found: ${cmd}). Install it via \`npm install -g @bastani/atomic\` or ensure \`atomic\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

try {
  parseAtomicExtraArgs(process.argv, process.env)
} catch (error) {
  process.stderr.write(`atomic-acp: ${(error as Error).message}\n`)
  process.exit(2)
}

const input = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>(resolve => {
      if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()

      try {
        process.stdout.write(chunk, err => {
          void err
          resolve()
        })
      } catch {
        // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
        resolve()
      }
    })
  }
})

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    process.stdin.on('end', () => controller.close())
    process.stdin.on('error', err => controller.error(err))
  }
})

const stream = ndJsonStream(input, output)

const agent = new AgentSideConnection(conn => new AtomicAcpAgent(conn), stream)

function shutdown() {
  try {
    // Best-effort: dispose session subprocesses when the client disconnects.
    ;(agent as any)?.agent?.dispose?.()
  } catch {
    // ignore
  }
  try {
    process.exit(0)
  } catch {
    // ignore
  }
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Avoid crashing if the client closes stdout early.
process.stdout.on('error', () => {
  try {
    process.exit(0)
  } catch {
    // ignore
  }
})
