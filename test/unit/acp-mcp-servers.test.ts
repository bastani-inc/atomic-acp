import test from 'node:test'
import assert from 'node:assert/strict'
import type { McpServer } from '@agentclientprotocol/sdk'
import { toAtomicMcpServers } from '../../src/acp/mcp-servers.js'

test('toAtomicMcpServers: stdio env arrays become an env object with direct exposure', () => {
  const { servers, warnings } = toAtomicMcpServers([
    {
      name: 'run-tools',
      command: '/usr/bin/node',
      args: ['server.js', '--port', '0'],
      env: [
        { name: 'TOKEN', value: 'secret' },
        { name: 'MODE', value: 'test' }
      ]
    }
  ])

  assert.deepEqual(servers, {
    'run-tools': {
      command: '/usr/bin/node',
      args: ['server.js', '--port', '0'],
      env: { TOKEN: 'secret', MODE: 'test' },
      exposure: 'direct'
    }
  })
  assert.deepEqual(warnings, [])
})

test('toAtomicMcpServers: http headers become a headers object', () => {
  const { servers } = toAtomicMcpServers([
    {
      type: 'http',
      name: 'docs',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer abc' }]
    }
  ])

  assert.deepEqual(servers, {
    docs: {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
      exposure: 'direct'
    }
  })
})

test('toAtomicMcpServers: passes env and header values through unchanged', () => {
  const { servers } = toAtomicMcpServers([
    {
      name: 'literal',
      command: 'tool',
      args: [],
      env: [
        { name: 'A', value: '!rm -rf /' },
        { name: 'B', value: 'cost: $5 ${HOME} $USER' }
      ]
    },
    {
      type: 'http',
      name: 'web',
      url: 'https://example.com/mcp',
      headers: [{ name: 'X-Key', value: '!echo hi' }]
    }
  ])

  assert.deepEqual(servers.literal, {
    command: 'tool',
    args: [],
    env: { A: '!rm -rf /', B: 'cost: $5 ${HOME} $USER' },
    exposure: 'direct'
  })
  assert.deepEqual(servers.web, {
    url: 'https://example.com/mcp',
    headers: { 'X-Key': '!echo hi' },
    exposure: 'direct'
  })
})

test('toAtomicMcpServers: skips sse and acp transports with a warning naming the server only', () => {
  const { servers, warnings } = toAtomicMcpServers([
    { type: 'sse', name: 'legacy', url: 'https://example.com/sse', headers: [{ name: 'Authorization', value: 'tok' }] },
    { type: 'acp', name: 'in-band', id: 'abc' }
  ] as McpServer[])

  assert.deepEqual(servers, {})
  assert.equal(warnings.length, 2)
  assert.match(warnings[0]!, /legacy/)
  assert.match(warnings[0]!, /SSE/i)
  assert.match(warnings[1]!, /in-band/)
  for (const warning of warnings) assert.doesNotMatch(warning, /tok|abc/)
})

test('toAtomicMcpServers: normalizes names to Atomic server names and keeps them unique', () => {
  const { servers } = toAtomicMcpServers([
    { name: 'My Tools!', command: 'a', args: [], env: [] },
    { name: 'my_tools_', command: 'b', args: [], env: [] },
    { name: 'my-tools-', command: 'c', args: [], env: [] },
    { name: '', command: 'd', args: [], env: [] },
    { name: '__proto__', command: 'e', args: [], env: [] }
  ])

  const names = Object.keys(servers)
  for (const name of names) assert.match(name, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(servers['My_Tools_'], { command: 'a', args: [], env: {}, exposure: 'direct' })
  assert.equal(names.length, 5)
  const namespaces = names.map(name => name.replace(/-/g, '_'))
  assert.equal(new Set(namespaces).size, names.length)
  assert.ok(!names.includes('__proto__'))
})

function refusal(servers: McpServer[]): { code?: number; message: string } {
  try {
    toAtomicMcpServers(servers)
  } catch (error) {
    return error as { code?: number; message: string }
  }
  assert.fail('expected the MCP servers to be refused')
}

test('toAtomicMcpServers: refuses header names and values that could break the request, naming only the header', () => {
  const http = (headers: Array<{ name: string; value: string }>): McpServer => ({
    type: 'http',
    name: 'docs',
    url: 'https://example.com/mcp',
    headers
  })
  for (const value of ['Bearer tok-91\ninvalid', 'Bearer tok-91\r', 'Bearer tok-91\0']) {
    const error = refusal([http([{ name: 'Authorization', value }])])
    assert.equal(error.code, -32602)
    assert.match(error.message, /"docs"/)
    assert.match(error.message, /Authorization/)
    assert.doesNotMatch(error.message, /tok-91/)
  }
  for (const name of ['X Key', 'X-Key:', 'X-Key\nInjected', '', 'Ké']) {
    const error = refusal([http([{ name, value: 'tok-91' }])])
    assert.equal(error.code, -32602)
    assert.match(error.message, /"docs"/)
    assert.doesNotMatch(error.message, /tok-91/)
  }
})

test('toAtomicMcpServers: refuses URLs that Atomic would expand from its environment', () => {
  for (const url of ['https://example.com/mcp?token=${SECRET}', 'https://example.com/$ENV:SECRET/mcp']) {
    const error = refusal([{ type: 'http', name: 'docs', url, headers: [] }])
    assert.equal(error.code, -32602)
    assert.match(error.message, /"docs"/)
  }
  assert.doesNotThrow(() =>
    toAtomicMcpServers([{ type: 'http', name: 'docs', url: 'https://example.com/mcp?price=$5', headers: [] }])
  )
})

test('toAtomicMcpServers: refuses stdio env values with NUL, which no process environment can hold', () => {
  const error = refusal([{ name: 'tools', command: 'tool', args: [], env: [{ name: 'TOKEN', value: 'tok-91\0' }] }])
  assert.equal(error.code, -32602)
  assert.match(error.message, /"tools"/)
  assert.match(error.message, /TOKEN/)
  assert.doesNotMatch(error.message, /tok-91/)
})
