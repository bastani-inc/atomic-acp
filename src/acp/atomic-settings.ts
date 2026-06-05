import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const av = out[k]
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v)
    else out[k] = v
  }
  return out
}

export function readJsonFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw)
    return isObject(data) ? data : {}
  } catch {
    return {}
  }
}

type SettingsLocation = 'user' | 'project'

type SettingsWithLocation = {
  location: SettingsLocation
  settings: Record<string, unknown>
  baseDirs: string[]
}

function getFirstDefinedEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined) return value
  }
  return undefined
}

function hasAgentDirOverride(): boolean {
  return process.env.ATOMIC_CODING_AGENT_DIR !== undefined || process.env.PI_CODING_AGENT_DIR !== undefined
}

export function readMergedJsonFiles(paths: string[]): Record<string, unknown> {
  let merged: Record<string, unknown> = {}

  // Paths are passed in precedence order (primary first, legacy fallback second).
  // Read from lowest to highest precedence so primary settings override legacy settings.
  for (let i = paths.length - 1; i >= 0; i--) {
    merged = deepMerge(merged, readJsonFile(paths[i]))
  }

  return merged
}

function getSettingsWithLocations(cwd: string): SettingsWithLocation[] {
  const agentDirs = getAgentDirs()
  const projectDirs = getProjectConfigDirs(cwd)

  return [
    {
      location: 'user',
      baseDirs: agentDirs,
      settings: readMergedJsonFiles(agentDirs.map(dir => join(dir, 'settings.json')))
    },
    {
      location: 'project',
      baseDirs: projectDirs,
      settings: readMergedJsonFiles(projectDirs.map(dir => join(dir, 'settings.json')))
    }
  ]
}

function getMergedSettings(cwd: string): Record<string, unknown> {
  const settings = getSettingsWithLocations(cwd)
  return deepMerge(settings[0].settings, settings[1].settings)
}

export function expandHomePath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

export function resolveAtomicPath(value: string, relativeBase = process.cwd()): string {
  const expanded = expandHomePath(value)
  return resolve(relativeBase, expanded)
}

export function readMergedResourceSettings(cwd: string): {
  prompts: Array<{ value: string; location: SettingsLocation; baseDirs: string[] }>
} {
  const prompts: Array<{ value: string; location: SettingsLocation; baseDirs: string[] }> = []

  for (const entry of [...getSettingsWithLocations(cwd)].reverse()) {
    const rawPrompts = entry.settings.prompts
    if (!Array.isArray(rawPrompts)) continue

    for (const value of rawPrompts) {
      if (typeof value === 'string') prompts.push({ value, location: entry.location, baseDirs: entry.baseDirs })
    }
  }

  return { prompts }
}

export function getAgentDir(): string {
  const override = getFirstDefinedEnv(['ATOMIC_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'])?.trim()
  return override ? resolveAtomicPath(override) : join(homedir(), '.atomic', 'agent')
}

export function getAgentDirs(): string[] {
  const primary = getAgentDir()
  if (hasAgentDirOverride()) return [primary]

  const legacy = join(homedir(), '.pi', 'agent')
  return legacy === primary ? [primary] : [primary, legacy]
}

export function getProjectConfigDirs(cwd: string): string[] {
  const resolvedCwd = resolve(cwd)
  return [resolve(resolvedCwd, '.atomic'), resolve(resolvedCwd, '.pi')]
}

/**
 * Mirror Atomic settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
export function getEnableSkillCommands(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.enableSkillCommands
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used skills.enableSkillCommands
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : undefined
  if (typeof nested === 'boolean') return nested

  return true
}

/**
 * Mirror Atomic's quietStartup setting: if true, Atomic suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export function getQuietStartup(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.quietStartup
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used quietStart
  const legacy = (merged as any).quietStart
  if (typeof legacy === 'boolean') return legacy

  return false
}
