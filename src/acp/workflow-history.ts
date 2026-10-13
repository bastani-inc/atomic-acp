function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function renderRun(value: unknown): string {
  const run = record(value)
  const title = [run.name, run.runId].filter(v => typeof v === 'string').join(' — ')
  const lines = [`## ${title || 'Workflow run'}`]
  for (const key of ['status', 'label', 'identity', 'summarizedThrough']) {
    if (run[key] !== undefined)
      lines.push(`- **${key}:** ${typeof run[key] === 'object' ? JSON.stringify(run[key]) : String(run[key])}`)
  }
  if (run.summary !== undefined)
    lines.push('', typeof run.summary === 'string' ? run.summary : JSON.stringify(run.summary, null, 2))
  return lines.join('\n')
}

export function renderWorkflowHistory(data: unknown, list: boolean): string {
  if (!list) return renderRun(data)
  const runs = record(data).runs
  return Array.isArray(runs) && runs.length ? runs.map(renderRun).join('\n\n') : 'No workflow runs found.'
}
