import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'tsup'
import { removeTempDir } from '../helpers/fake-atomic-cli.js'

const repoRoot = process.cwd()
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const timeoutMs = 10_000

// Build with the real tsup config into a scratch directory inside the repo, so the CLI resolves
// its dependencies and package.json like dist/index.js does, without racing a parallel `npm run build`.
let outDir = ''
before(async () => {
  mkdirSync(join(repoRoot, '.dist-cache'), { recursive: true })
  outDir = mkdtempSync(join(repoRoot, '.dist-cache', 'cli-test-'))
  await build({ outDir, sourcemap: false, silent: true })
})
after(() => removeTempDir(outDir))

type RunResult = { code: number | null; stdout: string; stderr: string }

function runCli(
  args: string[],
  input?: string,
  onStdout?: (stdout: string, stdin: NodeJS.WritableStream) => void
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ATOMIC_ACP_ATOMIC_COMMAND: 'atomic-does-not-exist-12345' }
    delete env.ATOMIC_ACP_ATOMIC_ARGS
    const child = spawn(process.execPath, [join(outDir, 'index.js'), ...args], { env, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`atomic-acp ${args.join(' ')} did not exit within ${timeoutMs}ms\nstdout: ${stdout}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
      onStdout?.(stdout, child.stdin)
    })
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    if (input !== undefined) child.stdin.write(input)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// Starts the CLI, completes an ACP initialize handshake on stdio, then closes stdin.
async function initializeOverStdio(args: string[]): Promise<{ result: RunResult; response: any }> {
  let response: any
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }
  const resultPromise = runCli(args, JSON.stringify(initialize) + '\n', (stdout, stdin) => {
    const line = stdout.split('\n').find(l => l.includes('"id":1'))
    if (!line || response) return
    response = JSON.parse(line)
    stdin.end()
  })
  return { result: await resultPromise, response }
}

for (const flag of ['--version', '-v']) {
  test(`atomic-acp ${flag} prints the version and exits 0 even with stdin open`, async () => {
    const { code, stdout, stderr } = await runCli([flag])
    assert.equal(code, 0, stderr)
    assert.equal(stdout, `atomic-acp ${pkg.version}\n`)
  })
}

for (const flag of ['--help', '-h']) {
  test(`atomic-acp ${flag} prints usage and exits 0`, async () => {
    const { code, stdout, stderr } = await runCli([flag])
    assert.equal(code, 0, stderr)
    assert.match(stdout, /^Usage: atomic-acp/)
    assert.match(stdout, /--version/)
    assert.match(stdout, /--terminal-login/)
  })
}

test('atomic-acp rejects an unknown flag before -- with exit code 2', async () => {
  const { code, stdout, stderr } = await runCli(['--verison'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /unknown option '--verison'/)
  assert.match(stderr, /atomic-acp --help/)
})

test('atomic-acp -- --version is an Atomic argument, not the adapter flag', async () => {
  const { code, stdout, stderr } = await runCli(['--', '--version'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /--version is not allowed/)
})

test('atomic-acp with no flags serves ACP on stdio', async () => {
  const { result, response } = await initializeOverStdio([])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(response?.result?.agentInfo?.version, pkg.version)
})

test('atomic-acp still serves ACP when extra Atomic arguments follow --', async () => {
  const { result, response } = await initializeOverStdio(['--', '--model', 'openai/gpt-6', '--thinking', 'high'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(response?.result?.protocolVersion, 1)
})
