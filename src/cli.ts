export type CliCommand = 'serve' | 'help' | 'version' | 'terminal-login'

export type CliParseResult = { command: CliCommand } | { error: string }

export const USAGE = `Usage: atomic-acp [options] [-- <atomic args...>]

Runs the Atomic ACP adapter over stdio. ACP clients such as Zed start it for you.

Options:
  --terminal-login  Open Atomic in this terminal to log in to a provider
  -h, --help        Show this help and exit
  -v, --version     Show the version and exit

Arguments after -- are passed to every \`atomic --mode rpc\` process.
`

const FLAGS: Record<string, CliCommand> = {
  '-h': 'help',
  '--help': 'help',
  '-v': 'version',
  '--version': 'version',
  '--terminal-login': 'terminal-login'
}

const PRECEDENCE: CliCommand[] = ['help', 'version', 'terminal-login']

/** Parses the adapter's own flags, which come before `--`; everything after it belongs to Atomic. */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  const separator = argv.indexOf('--', 2)
  const adapterArgs = separator < 0 ? argv.slice(2) : argv.slice(2, separator)
  const commands = new Set<CliCommand>()
  for (const arg of adapterArgs) {
    if (!arg.startsWith('-')) continue
    const command = FLAGS[arg]
    if (!command) return { error: `unknown option '${arg}'` }
    commands.add(command)
  }
  return { command: PRECEDENCE.find(command => commands.has(command)) ?? 'serve' }
}
