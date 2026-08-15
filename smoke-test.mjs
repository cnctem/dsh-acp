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
let resumed = null

// Persisted sessions backing session/list·load·delete.
const persisted = [
  { version: 0, id: 'persist-1', createdAt: 1700000000000, cwd: '/Users/a11111/code/dsh-acp' },
]
const replayEvents = [
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'hello back' }] } },
  },
  { type: 'tool/call', data: { callId: 'call-replay', name: 'read', arguments: '{"file_path":"/tmp/r.txt"}' } },
  {
    type: 'tool/result',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-replay', content: [{ type: 'text', text: 'replay content' }] }],
        source: { kind: 'tool' },
      },
    },
  },
]

const ctx = new Context()
ctx.provide('agents', {
  async create(options) {
    const sessionId = options.sessionId
    const session = { header: { id: sessionId }, id: sessionId }
    const agent = { id: sessionId, session }
    captured = { sessionId, session, agent }
    return { agent, dispose: async () => {} }
  },
  async resume(options) {
    const sessionId = options.resumeSessionId
    const session = { header: { id: sessionId }, id: sessionId, events: replayEvents }
    const agent = { id: sessionId, session, cancel() {}, followup() {}, whenIdle: async () => {} }
    resumed = { sessionId, agent }
    return { agent, dispose: async () => {} }
  },
  get(id) {
    return captured && captured.agent.id === id ? captured.agent : undefined
  },
})
ctx.provide('agentDefaultModel', {
  currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
})
ctx.provide('llm', {
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
  listModels: async (provider) => [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider }],
  resolveModelInfo: async (_provider, _model) => ({
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
  }),
})
ctx.provide('permissionPresets', {
  names: ['read-only', 'workspace-write', 'danger-full-access'],
  current: () => 'workspace-write',
  set: () => {},
})
ctx.provide('agentPresets', {
  defaultId: 'standard',
  async list() {
    return [
      { id: 'standard', name: '标准模式' },
      { id: 'code', name: 'PTC 模式' },
      { id: 'minimal', name: '极简模式' },
      { id: 'cordis', name: '创造模式' },
    ]
  },
  async mount() {
    return { id: 'standard' }
  },
  async recompose(_ctx, id) {
    return { id }
  },
})
ctx.provide('sessionPersistence', {
  async list() {
    return persisted
  },
  locate(header) {
    return { kind: 'jsonl', path: `/tmp/acp-test/${header.id}/session.jsonl.zstd` }
  },
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
check(init.result?.agentCapabilities?.loadSession === true, 'should advertise loadSession')
check(
  init.result?.agentCapabilities?.sessionCapabilities?.list !== undefined &&
    init.result?.agentCapabilities?.sessionCapabilities?.delete !== undefined,
  'should advertise session list/delete capabilities',
)

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
console.log('session/new config ->', JSON.stringify({ configOptions: created.result?.configOptions, models: created.result?.models, modes: created.result?.modes }))
check(typeof sessionId === 'string' && sessionId.length > 0, 'expected a sessionId')
check(captured !== null, 'mock create should have been invoked')
check(
  created.result?.configOptions?.some((o) => o.id === 'model' && o.category === 'model'),
  'config should advertise a model option',
)
check(
  created.result?.configOptions?.some((o) => o.id === 'thought_level' && o.category === 'thought_level' && o.options?.length === 2),
  'config should advertise a thought_level option',
)
check(
  created.result?.configOptions?.some((o) => o.id === 'permission' && o.options?.length === 3),
  'config should advertise a 3-way permission option',
)
check(
  created.result?.configOptions?.every((o) => o.id !== 'preset'),
  'preset should NOT be a config option (it is a deployment field)',
)
check(
  created.result?.configOptions?.findIndex((o) => o.id === 'permission') <
    created.result?.configOptions?.findIndex((o) => o.id === 'model'),
  'order should be permission before model',
)
check(created.result?.models?.availableModels?.length === 1, 'one available model')
check(created.result?.models?.currentModelId === 'deepseek-official/deepseek-v4-pro', 'current model id')
check(created.result?.modes?.availableModes?.length === 2, 'two thinking modes')
check(created.result?.modes?.currentModeId === 'high', 'default thinking mode')

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

// 4b. edit line inference: old_string "beta" is on line 2 of the snapshot.
import { writeFileSync } from 'node:fs'
writeFileSync('/tmp/dsh-acp-line-test.txt', 'alpha\nbeta\ngamma\n', 'utf8')
emitEvent('tool/call', {
  turn: 1,
  step: 2,
  callId: 'call-edit',
  name: 'edit',
  arguments: '{"file_path":"/tmp/dsh-acp-line-test.txt","old_string":"beta","new_string":"BETA"}',
})
emitEvent('tool/result', {
  turn: 1,
  step: 2,
  message: {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-edit', content: [{ type: 'text', text: 'edited' }] }],
    source: { kind: 'tool' },
  },
})
const editFrames = [await readFrame(), await readFrame()]
for (const f of editFrames) console.log('edit ->', JSON.stringify(f.params))
const editCall = editFrames[0].params?.update
check(editCall?.sessionUpdate === 'tool_call', 'edit tool_call')
check(editCall?.kind === 'edit', 'edit kind')
check(editCall?.locations?.[0]?.line === 2, 'edit location should infer line 2')

// 5. session/list
await send({ jsonrpc: '2.0', id: 10, method: 'session/list', params: {} })
const listed = await readFrame()
console.log('session/list ->', JSON.stringify(listed.result))
check(listed.result?.sessions?.length === 1, 'should list one persisted session')
check(listed.result?.sessions?.[0]?.sessionId === 'persist-1', 'listed session id')
check(listed.result?.sessions?.[0]?.cwd === '/Users/a11111/code/dsh-acp', 'listed session cwd')

// 6. session/load — resumes the agent and replays its transcript first, then responds.
await send({ jsonrpc: '2.0', id: 11, method: 'session/load', params: { sessionId: 'persist-1', cwd: '/Users/a11111/code/dsh-acp', mcpServers: [] } })
const replay = []
for (let i = 0; i < 4; i += 1) replay.push(await readFrame())
for (const f of replay) console.log('replay ->', JSON.stringify(f.params))
const loaded = await readFrame()
console.log('session/load ->', JSON.stringify(loaded.result))
check(loaded.result !== undefined, 'session/load should succeed')
check(resumed?.sessionId === 'persist-1', 'agents.resume should have been called')

check(replay[0]?.params?.update?.sessionUpdate === 'user_message_chunk', 'replay user message')
check(replay[0]?.params?.update?.content?.text === 'hi', 'replay user text')
check(replay[1]?.params?.update?.sessionUpdate === 'agent_message_chunk', 'replay assistant message')
check(replay[1]?.params?.update?.content?.text === 'hello back', 'replay assistant text')
check(replay[2]?.params?.update?.sessionUpdate === 'tool_call', 'replay tool call')
check(replay[2]?.params?.update?.toolCallId === 'call-replay', 'replay tool call id')
check(replay[3]?.params?.update?.sessionUpdate === 'tool_call_update', 'replay tool result')
check(replay[3]?.params?.update?.status === 'completed', 'replay tool result completed')

// 7. session/delete — idempotent, removes the artifact.
await send({ jsonrpc: '2.0', id: 12, method: 'session/delete', params: { sessionId: 'persist-1' } })
const deleted = await readFrame()
console.log('session/delete ->', JSON.stringify(deleted.result))
check(deleted.result !== undefined, 'session/delete should succeed')
await send({ jsonrpc: '2.0', id: 13, method: 'session/delete', params: { sessionId: 'does-not-exist' } })
const deletedMissing = await readFrame()
check(deletedMissing.result !== undefined, 'session/delete of an unknown id should be idempotent')

// 8. session/set_mode (thinking strength) — emits current_mode_update before the response.
await send({ jsonrpc: '2.0', id: 14, method: 'session/set_mode', params: { sessionId, modeId: 'low' } })
const modeFrames = [await readFrame(), await readFrame()]
for (const f of modeFrames) console.log('set_mode frame ->', JSON.stringify(f))
const modeNotif = modeFrames.find((f) => f.method === 'session/update')
const modeResp = modeFrames.find((f) => f.id === 14)
check(modeNotif?.params?.update?.sessionUpdate === 'current_mode_update', 'set_mode should emit current_mode_update')
check(modeNotif?.params?.update?.currentModeId === 'low', 'current_mode_update should carry the new mode')
check(modeResp?.result !== undefined, 'set_mode should succeed')

// 9. session/set_config_option (permission + model)
await send({ jsonrpc: '2.0', id: 15, method: 'session/set_config_option', params: { sessionId, configId: 'permission', value: 'danger-full-access' } })
const permResp = await readFrame()
console.log('set permission ->', JSON.stringify(permResp.result))
check(permResp.result?.configOptions !== undefined, 'set permission should return configOptions')

await send({ jsonrpc: '2.0', id: 16, method: 'session/set_config_option', params: { sessionId, configId: 'model', value: 'deepseek-official/deepseek-v4-pro' } })
const modelResp = await readFrame()
console.log('set model ->', JSON.stringify(modelResp.result))
check(modelResp.result?.configOptions !== undefined, 'set model should return configOptions')

console.log(failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
