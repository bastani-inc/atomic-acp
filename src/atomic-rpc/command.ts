import { platform } from 'node:os'

export function defaultAtomicCommand(): string {
  return platform() === 'win32' ? 'atomic.cmd' : 'atomic'
}

export function getAtomicCommand(override?: string): string {
  return override ?? defaultAtomicCommand()
}

export function shouldUseShellForAtomicCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}

// Flags that would take RPC mode, session selection or stdio away from the adapter.
const RESERVED_ATOMIC_ARGS = new Set([
  '--',
  '--mode',
  '-p',
  '--print',
  '--session',
  '--session-id',
  '--session-dir',
  '--session-store',
  '--session-prefix',
  '--import',
  '--storage',
  '--storage-file',
  '--no-session',
  '-c',
  '--continue',
  '-r',
  '--resume',
  '--fork',
  '--export',
  '--list-models',
  '-h',
  '--help',
  '-v',
  '--version'
])

function validateAtomicArg(arg: string, source: string): string {
  if (arg.includes('\0')) throw new Error(`${source}: arguments must not contain NUL characters`)
  const flag = arg.startsWith('--') ? arg.split('=', 1)[0]! : arg
  if (RESERVED_ATOMIC_ARGS.has(flag)) throw new Error(`${source}: ${flag} is not allowed; atomic-acp manages it`)
  return arg
}

/**
 * Extra arguments for every `atomic --mode rpc`: the JSON array in ATOMIC_ACP_ATOMIC_ARGS, then
 * everything after `--` on the adapter's command line. They are passed as argv entries, never
 * through a shell.
 */
export function parseAtomicExtraArgs(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const fromEnv: string[] = []
  const raw = env.ATOMIC_ACP_ATOMIC_ARGS
  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('ATOMIC_ACP_ATOMIC_ARGS must be a JSON array of strings')
    }
    if (!Array.isArray(parsed) || !parsed.every(arg => typeof arg === 'string')) {
      throw new Error('ATOMIC_ACP_ATOMIC_ARGS must be a JSON array of strings')
    }
    fromEnv.push(...parsed.map(arg => validateAtomicArg(arg, 'ATOMIC_ACP_ATOMIC_ARGS')))
  }
  const separator = argv.indexOf('--', 2)
  const fromArgv =
    separator < 0 ? [] : argv.slice(separator + 1).map(arg => validateAtomicArg(arg, 'arguments after --'))
  return [...fromEnv, ...fromArgv]
}

const EXCLUDE_TOOLS_FLAGS = new Set(['--exclude-tools', '-xt'])

/**
 * `extraArgs` with `tool` added to Atomic's tool exclusions. Atomic keeps only the last
 * `--exclude-tools`, so the tool joins that list rather than adding a second flag that would
 * replace it.
 */
export function withExcludedTool(extraArgs: readonly string[], tool: string): string[] {
  const args = [...extraArgs]
  const joined = (list: string) => (list.split(',').includes(tool) ? list : list ? `${list},${tool}` : tool)
  for (let index = args.length - 1; index >= 0; index--) {
    const arg = args[index]!
    if (arg.startsWith('--exclude-tools=')) {
      args[index] = `--exclude-tools=${joined(arg.slice('--exclude-tools='.length))}`
      return args
    }
    if (EXCLUDE_TOOLS_FLAGS.has(arg) && index + 1 < args.length) {
      args[index + 1] = joined(args[index + 1]!)
      return args
    }
  }
  return [...args, '--exclude-tools', tool]
}
