// In-process smoke test for dsh-acp: verifies the ACP JSON-RPC stdio surface
// (initialize, session/new) plus the rich editor events (streaming chunks,
// tool cards, structured diffs) against mock agent services — without touching
// the model stack or $DSH_HOME.
//
// Run:  node smoke-test.mjs

import { Context } from '@deepseek-ai/cordis'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { apply } from './lib/index.js'

const agentToClient = new TransformStream()
const clientToAgent = new TransformStream()

let captured = null

const ctx = new Context()
ctx.provide('agents', {
  async create(options) {
    const sessionId = options.sessionId
    const session = { header: { id: sessionId }, id: sessionId }
    const agent = { id: sessionId, session }
    captured = { sessionId, session, agent }
    return { agent, dispose: async () => {} }
  },
  get(id) {
    return captured && captured.agent.id === id ? captured.agent : undefined
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

let failures = 0
function check(cond, msg) {
  if (!cond) {
    failures += 1
    console.error('FAIL:', msg)
  }
}

// 1. initialize
await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
const init = await readFrame()
console.log('initialize ->', JSON.stringify(init.result))
check(init.result?.protocolVersion === 1, 'protocolVersion should be 1')

// 2. session/new
await send({
  jsonrpc: '2.0',
  id: 2,
  method: 'session/new',
  params: { cwd: '/Users/a11111/code/dsh-acp', mcpServers: [], additionalDirectories: [] },
})
const created = await readFrame()
const sessionId = created.result?.sessionId
console.log('session/new ->', sessionId)
check(typeof sessionId === 'string' && sessionId.length > 0, 'expected a sessionId')
check(captured !== null, 'mock create should have been invoked')

// 3. Emit rich editor events through the session firehose.
function emitEvent(type, data) {
  ctx.emit('session/event', captured.session, { type, data })
}

emitEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello ' } })
emitEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'world' } })
emitEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking...' } })
emitEvent('tool/call', { turn: 1, step: 1, callId: 'call-read', name: 'read', arguments: '{"file_path":"/tmp/a.txt"}' })
emitEvent('tool/result', {
  turn: 1,
  step: 1,
  message: {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-read', content: [{ type: 'text', text: 'line one' }] }],
    source: { kind: 'tool' },
  },
})
emitEvent('tool/call', { turn: 1, step: 1, callId: 'call-write', name: 'write', arguments: '{"file_path":"/tmp/a.txt"}' })
emitEvent('tool/result', {
  turn: 1,
  step: 1,
  message: {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-write', content: [{ type: 'text', text: 'wrote' }] }],
    source: { kind: 'tool' },
  },
  meta: { diffs: [{ path: '/tmp/a.txt', oldText: 'line one', newText: 'line two' }] },
})

// 4. Read and assert the six session/update notifications.
const frames = []
for (let i = 0; i < 6; i += 1) frames.push(await readFrame())
for (const f of frames) console.log('update ->', JSON.stringify(f.params))

const updates = frames.map((f) => f.params?.update)
check(frames.every((f) => f.method === 'session/update'), 'all frames should be session/update notifications')
check(frames.every((f) => f.params?.sessionId === sessionId), 'notifications should carry the session id')

check(
  updates[0]?.sessionUpdate === 'agent_message_chunk' && updates[0]?.content?.text === 'Hello ',
  'first text chunk should be "Hello "',
)
check(
  updates[1]?.sessionUpdate === 'agent_message_chunk' && updates[1]?.content?.text === 'world',
  'second text chunk should be "world"',
)
check(
  updates[2]?.sessionUpdate === 'agent_thought_chunk' && updates[2]?.content?.text === 'thinking...',
  'third should be a thought chunk',
)

const readCall = updates[3]
check(readCall?.sessionUpdate === 'tool_call', 'fourth should be a tool_call')
check(readCall?.toolCallId === 'call-read', 'read call id')
check(readCall?.kind === 'read', 'read kind')
check(readCall?.locations?.[0]?.path === '/tmp/a.txt', 'read location')

const readResult = updates[4]
check(readResult?.sessionUpdate === 'tool_call_update', 'fifth should be tool_call_update')
check(readResult?.status === 'completed', 'read completed')
check(readResult?.content?.[0]?.content?.text === 'line one', 'read result text')

const writeCall = updates[5]
check(writeCall?.sessionUpdate === 'tool_call', 'sixth should be tool_call (write)')
check(writeCall?.kind === 'edit', 'write kind should be edit')

// The write result with meta.diffs should be the 7th frame (diff update).
frames.push(await readFrame())
console.log('update ->', JSON.stringify(frames[6].params))
const writeResult = frames[6].params?.update
check(writeResult?.sessionUpdate === 'tool_call_update', 'write tool_call_update')
check(writeResult?.content?.[0]?.type === 'diff', 'write result should be a structured diff')
check(
  writeResult?.content?.[0]?.oldText === 'line one' && writeResult?.content?.[0]?.newText === 'line two',
  'diff old/new text',
)

console.log(failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
