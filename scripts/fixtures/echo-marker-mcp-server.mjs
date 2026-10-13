// Minimal stdio MCP server for smoke tests. It exposes one tool, `echo_marker`, and appends
// every call to the file named by ECHO_MARKER_LOG so the smoke test can see that it ran.
import { appendFileSync } from 'node:fs'

const log = process.env.ECHO_MARKER_LOG
let buffer = ''

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}

function handle(message) {
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      return send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-marker', version: '1.0.0' }
        }
      })
    case 'ping':
      return send({ id: message.id, result: {} })
    case 'tools/list':
      return send({
        id: message.id,
        result: {
          tools: [
            {
              name: 'echo_marker',
              description: 'Echo a marker string back to the caller.',
              inputSchema: {
                type: 'object',
                properties: { marker: { type: 'string', description: 'Marker to echo' } },
                required: ['marker']
              }
            }
          ]
        }
      })
    case 'tools/call': {
      const marker = String(message.params?.arguments?.marker ?? '')
      if (log) appendFileSync(log, JSON.stringify({ tool: message.params?.name, marker }) + '\n')
      return send({ id: message.id, result: { content: [{ type: 'text', text: `echo_marker:${marker}` }] } })
    }
    default:
      return send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch {
      // ignore malformed input
    }
  }
})
