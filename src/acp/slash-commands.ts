import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { getAgentDirs, getProjectConfigDirs, readMergedResourceSettings, resolveAtomicPath } from './atomic-settings.js'
import type { AtomicRpcCommandInfo } from './atomic-commands.js'

/**
 * File-based slash command (mirrors atomic-coding-agent semantics).
 */
export type FileSlashCommand = {
  name: string
  description: string
  content: string
  source: string // e.g. "(user)", "(project)", "(project:frontend)"
  path?: string
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>
  content: string
} {
  const frontmatter: Record<string, string> = {}

  if (!content.startsWith('---')) return { frontmatter, content }

  const endIndex = content.indexOf('\n---', 3)
  if (endIndex === -1) return { frontmatter, content }

  const frontmatterBlock = content.slice(4, endIndex)
  const remaining = content.slice(endIndex + 4).trim()

  for (const line of frontmatterBlock.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/)
    if (match) frontmatter[match[1]] = match[2].trim()
  }

  return { frontmatter, content: remaining }
}

function describeContent(content: string, frontmatter: Record<string, string>, sourceStr: string): string {
  let description = frontmatter.description || ''
  if (!description) {
    const firstLine = content.split('\n').find(l => l.trim())
    if (firstLine) {
      description = firstLine.slice(0, 60)
      if (firstLine.length > 60) description += '...'
    }
  }

  return description ? `${description} ${sourceStr}` : sourceStr
}

function loadCommandFromFile(path: string, sourceStr: string, name = basename(path, '.md')): FileSlashCommand | null {
  try {
    const rawContent = readFileSync(path, 'utf-8')
    const { frontmatter, content } = parseFrontmatter(rawContent)

    return {
      name,
      description: describeContent(content, frontmatter, sourceStr),
      content,
      source: sourceStr,
      path
    }
  } catch {
    return null
  }
}

function loadCommandsFromDir(dir: string, source: 'user' | 'project' | 'path', subdir = ''): FileSlashCommand[] {
  const commands: FileSlashCommand[] = []
  if (!existsSync(dir)) return commands

  try {
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue

      const fullPath = join(dir, entry.name)
      const sourceStr =
        source === 'path'
          ? '(path)'
          : source === 'user'
            ? subdir
              ? `(user:${subdir})`
              : '(user)'
            : subdir
              ? `(project:${subdir})`
              : '(project)'
      const command = loadCommandFromFile(fullPath, sourceStr)
      if (command) commands.push(command)
    }
  } catch {
    // Silently skip unreadable dirs.
  }

  return commands
}

function settingSourceLabel(location: 'user' | 'project'): string {
  return location === 'user' ? '(user:settings)' : '(project:settings)'
}

function resolvePromptSettingPaths(value: string, baseDirs: string[]): string[] {
  return baseDirs.map(baseDir => resolveAtomicPath(value, baseDir))
}

function loadCommandsFromSettingPath(path: string, location: 'user' | 'project'): FileSlashCommand[] {
  try {
    const stat = statSync(path)
    if (stat.isFile() && path.endsWith('.md')) {
      const command = loadCommandFromFile(path, settingSourceLabel(location))
      return command ? [command] : []
    }
    if (stat.isDirectory()) return loadCommandsFromDir(path, 'path')
  } catch {
    // Silently skip unreadable paths.
  }
  return []
}

function filterExcluded(commands: FileSlashCommand[], excludedPaths: Set<string>): FileSlashCommand[] {
  if (!excludedPaths.size) return commands
  return commands.filter(c => !c.path || !excludedPaths.has(c.path))
}

/**
 * Load prompt templates from Atomic's prompt directories (formerly "commands").
 *  - user:    top-level *.md files in <Atomic agent dir>/prompts
 *  - project: top-level *.md files in <cwd>/.atomic/prompts
 */
export function loadSlashCommands(cwd: string): FileSlashCommand[] {
  const settings = readMergedResourceSettings(cwd)
  const commands: FileSlashCommand[] = []
  const excludedPaths = new Set<string>()

  for (const entry of settings.prompts) {
    const raw = entry.value.trim()
    if (!raw) continue

    const marker = raw[0]
    const isExclusion = marker === '-' || marker === '!'
    const isForceInclude = marker === '+'
    const pathText = isExclusion || isForceInclude ? raw.slice(1) : raw
    const resolvedPaths = resolvePromptSettingPaths(pathText, entry.baseDirs)

    if (isExclusion) {
      for (const resolved of resolvedPaths) excludedPaths.add(resolved)
      continue
    }

    for (const resolved of resolvedPaths) {
      commands.push(...loadCommandsFromSettingPath(resolved, entry.location))
    }
  }

  const projectDirs = getProjectConfigDirs(cwd).map(configDir => join(configDir, 'prompts'))
  const userDirs = getAgentDirs().map(agentDir => join(agentDir, 'prompts'))

  // Match Atomic ordering: explicit settings prompts take precedence, then project auto-discovery,
  // then user auto-discovery. Auto-discovery is non-recursive in Atomic.
  for (const projectDir of projectDirs) commands.push(...loadCommandsFromDir(projectDir, 'project'))
  for (const userDir of userDirs) commands.push(...loadCommandsFromDir(userDir, 'user'))

  return filterExcluded(commands, excludedPaths)
}

export function loadSlashCommandsFromAtomicGetCommands(data: unknown): FileSlashCommand[] {
  const root: any = data
  const commandsRaw: AtomicRpcCommandInfo[] = Array.isArray(root?.commands)
    ? root.commands
    : Array.isArray(root?.data?.commands)
      ? root.data.commands
      : []

  const out: FileSlashCommand[] = []

  for (const c of commandsRaw) {
    if (c?.source !== 'prompt') continue
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    const path = typeof c.path === 'string' ? c.path : ''
    if (!name || !path) continue

    const location = typeof c.location === 'string' && c.location ? c.location : 'path'
    const sourceStr = `(${location})`
    const command = loadCommandFromFile(path, sourceStr, name)
    if (!command) continue

    if (typeof c.description === 'string' && c.description.trim()) command.description = c.description.trim()
    out.push(command)
  }

  return out
}

/**
 * Convert file-based commands to ACP AvailableCommand objects.
 * De-dupes by name (first wins).
 */
export function toAvailableCommands(fileCommands: FileSlashCommand[]): AvailableCommand[] {
  const seen = new Set<string>()
  const out: AvailableCommand[] = []

  for (const c of fileCommands) {
    if (seen.has(c.name)) continue
    seen.add(c.name)

    out.push({
      name: c.name,
      description: c.description
      // input: omitted for now (Atomic commands don't specify this)
    })
  }

  return out
}

/**
 * Parse command args (bash-style quotes).
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote: string | null = null

  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i]

    if (inQuote) {
      if (ch === inQuote) inQuote = null
      else current += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }

  if (current) args.push(current)
  return args
}

/**
 * Substitute Atomic prompt-template arguments.
 */
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(' ')

  return content.replace(/\$\{@:(\d+)(?::(\d+))?\}|\$ARGUMENTS|\$@|\$(\d+)/g, (match, start, length, num) => {
    if (match === '$ARGUMENTS' || match === '$@') return allArgs

    if (num !== undefined) {
      const idx = Number.parseInt(String(num), 10) - 1
      return args[idx] ?? ''
    }

    const startIndex = Math.max(Number.parseInt(String(start), 10) - 1, 0)
    const count = length === undefined ? undefined : Number.parseInt(String(length), 10)
    const selected = count === undefined ? args.slice(startIndex) : args.slice(startIndex, startIndex + count)
    return selected.join(' ')
  })
}

/**
 * Expand a leading /command using the loaded file commands.
 * Returns original text if it's not a known slash command.
 */
export function expandSlashCommand(text: string, fileCommands: FileSlashCommand[]): string {
  if (!text.startsWith('/')) return text

  const spaceIndex = text.indexOf(' ')
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
  const argsString = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1)

  const cmd = fileCommands.find(c => c.name === commandName)
  if (!cmd) return text

  const args = parseCommandArgs(argsString)
  return substituteArgs(cmd.content, args)
}
