// In-process smoke test for dsh-acp: verifies the ACP JSON-RPC stdio surface
// (initialize + session/new) against mock agent services, without touching the
// model stack or $DSH_HOME.
//
// Run:  node smoke-test.mjs

import { Context } from '@deepseek-ai/cordis'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { apply } from './lib/index.js'

const agentToClient = new TransformStream()
const clientToAgent = new TransformStream()

const ctx = new Context()
ctx.provide('agents', {
  async create(options) {
    return {
      agent: { id: options.sessionId, session: { id: options.sessionId } },
      dispose: async () => {},
    }
  },
  get() {
    return undefined
  },
})
ctx.provide('agentDefaultModel', {
  currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
})

apply(ctx, {
  stream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
})

const writer = clientToAgent.writable.getWriter()
const reader = agentToClient.readable.getReader()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function send(obj) {
  return writer.write(encoder.encode(JSON.stringify(obj) + '\n'))
}

// Read one newline-delimited JSON frame (buffers partial lines across chunks).
let buf = ''
async function readFrame(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) return JSON.parse(line)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('timed out waiting for a frame; buffered=' + JSON.stringify(buf))
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), Math.min(remaining, 250))),
    ])
    if (done) throw new Error('stream closed before a full frame')
    if (value) buf += decoder.decode(value, { stream: true })
  }
}

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

// 1. initialize
await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
const init = await readFrame()
console.log('initialize ->', JSON.stringify(init))
if (init.result?.protocolVersion !== 1) fail(`expected protocolVersion 1, got ${init.result?.protocolVersion}`)
if (init.result?.agentInfo?.name !== 'dsh-acp') fail(`unexpected agentInfo ${JSON.stringify(init.result?.agentInfo)}`)

// 2. session/new with an absolute cwd
await send({
  jsonrpc: '2.0',
  id: 2,
  method: 'session/new',
  params: { cwd: '/Users/a11111/code/dsh-acp', mcpServers: [], additionalDirectories: [] },
})
const created = await readFrame()
console.log('session/new ->', JSON.stringify(created))
if (typeof created.result?.sessionId !== 'string' || created.result.sessionId.length === 0) {
  fail(`expected a sessionId, got ${JSON.stringify(created.result)}`)
}

// 3. session/new rejects a relative cwd (invalid-params)
await send({
  jsonrpc: '2.0',
  id: 3,
  method: 'session/new',
  params: { cwd: 'relative/path', mcpServers: [] },
})
const rejected = await readFrame()
console.log('session/new(relative) ->', JSON.stringify(rejected))
if (rejected.error?.code !== -32602) fail(`expected invalid-params error, got ${JSON.stringify(rejected.error)}`)

console.log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED')
process.exit(process.exitCode || 0)
