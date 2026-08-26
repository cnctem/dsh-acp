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

// Last slash-command dispatch arguments (images + signal) for image tests.
let lastCommandImages = undefined
let lastCommandSignal = undefined

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
  // Todo history: an early list, a turn boundary that clears it, and a final
  // snapshot — the replay fold must surface exactly the last list.
  { type: 'todo/write', data: { todos: [{ content: 'plan A', status: 'in_progress' }] } },
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'todo/write', data: { todos: [{ content: 'plan B', status: 'pending' }] } },
]

const ctx = new Context()
ctx.provide('agents', {
  async create(options) {
    const sessionId = options.sessionId
    const session = { header: { id: sessionId }, id: sessionId }
    const agent = {
      id: sessionId,
      session,
      cancel() {},
      followup(message) {
        this.followedUp = true
        this.lastMessage = message
      },
      whenIdle: async () => {},
      followedUp: false,
      lastMessage: undefined,
    }
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
  listModels: async (provider) => [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider },
    { id: 'deepseek-v4-lite', name: 'DeepSeek V4 Lite', provider },
  ],
  // deepseek-v4-pro exposes reasoning metadata; deepseek-v4-lite exposes none
  // and must fall back to the canonical thinking-level list.
  resolveModelInfo: async (_provider, model) =>
    model === 'deepseek-v4-lite'
      ? {}
      : { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
})
ctx.provide('permissionPresets', {
  names: ['read-only', 'workspace-write', 'danger-full-access'],
  current: () => 'workspace-write',
  set: () => {},
})
ctx.provide('commands', {
  list: () => [{ name: 'compact', description: 'Compress the session', input: { hint: 'optional notes' } }],
  execute: async (_agent, line, images, signal) => {
    lastCommandImages = images
    lastCommandSignal = signal
    if (String(line).trim().startsWith('/plan')) {
      return { commandId: 'cmd-plan', result: { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' } }
    }
    return undefined
  },
})

// Durable attachment seam (dsh-attachment): admits ACP image uploads and
// returns references; the bridge must only ever send those references to the
// model. `failAdmission` forces a caller-correctable admission rejection.
let admittedImages = []
let failAdmission = false
ctx.provide('attachments', {
  async saveImages(inputs) {
    if (failAdmission) {
      const error = new Error('image exceeds the per-image byte limit')
      error.code = 'IMAGE_TOO_LARGE'
      throw error
    }
    admittedImages = inputs.map((input) => ({
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
    }))
    return inputs.map((input, i) => ({
      attachmentId: `sha256:test-image-${i}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 10,
      height: 10,
    }))
  },
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

// Context-pressure projection (dsh-token-meter). Off by default so the
// existing frame counts above stay stable; sections that assert usage_update
// flip it on.
let pressureOn = false
ctx.provide('sessionProjections', {
  snapshot: () =>
    pressureOn
      ? { values: { contextPressure: { projectedTokens: 1200, contextWindow: 128000 } } }
      : { values: {} },
})

// userQuestions seam: the bridge registers its elicitation provider here; the
// mock ask() delegates to it exactly like UserQuestionService does.
let questionProvider = null
ctx.provide('userQuestions', {
  registerProvider(provider) {
    questionProvider = provider
    return () => {
      questionProvider = null
    }
  },
  async ask(request) {
    if (questionProvider === null) throw new Error('no user-questions provider registered')
    return questionProvider.ask(request)
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
  init.result?.agentCapabilities?.promptCapabilities?.image === true,
  'should advertise the image prompt capability',
)
check(
  init.result?.agentCapabilities?.promptCapabilities?.audio === false &&
    init.result?.agentCapabilities?.promptCapabilities?.embeddedContext === false,
  'audio and embeddedContext should stay off',
)
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
check(created.result?.models?.availableModels?.length === 2, 'two available models')
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

// 4c. bash terminal content: tool_call carries terminal content + info meta,
// tool_call_update carries terminal_output + terminal_exit.
emitEvent('tool/call', {
  turn: 1,
  step: 3,
  callId: 'call-bash',
  name: 'bash',
  arguments: '{"command":"echo hello","description":"say hi"}',
})
emitEvent('tool/result', {
  turn: 1,
  step: 3,
  message: {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-bash', content: [{ type: 'text', text: 'hello\n' }] }],
    source: { kind: 'tool' },
  },
  meta: { card: 'terminal', output: 'hello\n', exitCode: 0 },
})
const bashFrames = [await readFrame(), await readFrame()]
for (const f of bashFrames) console.log('bash ->', JSON.stringify(f.params))
const bashCall = bashFrames[0].params?.update
check(bashCall?.sessionUpdate === 'tool_call', 'bash tool_call')
check(bashCall?.kind === 'execute', 'bash kind should be execute')
check(bashCall?.title === 'echo hello', 'bash title should be the command')
check(bashCall?.content?.[0]?.type === 'terminal', 'bash call should carry terminal content')
check(bashCall?.content?.[0]?.terminalId === 'call-bash', 'terminal id matches call id')
check(bashCall?._meta?.terminal_info?.terminal_id === 'call-bash', 'terminal_info meta')
const bashResult = bashFrames[1].params?.update
check(bashResult?.sessionUpdate === 'tool_call_update', 'bash tool_call_update')
check(bashResult?._meta?.terminal_output?.data === 'hello\n', 'terminal_output data')
check(bashResult?._meta?.terminal_exit?.exit_code === 0, 'terminal_exit exit code')

// 4d. slash commands are advertised via available_commands_update (arrives after
// the rich-editor notifications because advertiseCommands uses setTimeout(0)).
const cmdFrame = await readFrame()
console.log('commands ->', JSON.stringify(cmdFrame.params))
check(cmdFrame.method === 'session/update', 'commands frame should be session/update')
check(
  cmdFrame.params?.update?.sessionUpdate === 'available_commands_update',
  'should advertise available_commands_update',
)
check(cmdFrame.params?.update?.availableCommands?.length === 1, 'one slash command')
check(cmdFrame.params?.update?.availableCommands?.[0]?.name === 'compact', 'command name')

// 4e. context-usage ring: with the projection populated, committed events push
// usage_update (used / size) — the feed behind the client's context ring.
pressureOn = true
emitEvent('turn/end', { turn: 1, reason: { kind: 'end_turn' } })
const usageFrame = await readFrame()
console.log('usage ->', JSON.stringify(usageFrame.params))
check(usageFrame.method === 'session/update', 'usage frame should be session/update')
check(usageFrame.params?.update?.sessionUpdate === 'usage_update', 'should emit usage_update')
check(usageFrame.params?.update?.used === 1200, 'usage_update used tokens')
check(usageFrame.params?.update?.size === 128000, 'usage_update context window')

// 4f. todo list → ACP plan: each todo_write snapshot (todo/write) becomes a
// `plan` update with whole-list replacement — the feed behind the IDE's task
// checklist. Entries carry content/priority/status (priority is ACP-required;
// dsh todos have none, so it is always medium).
// The clear is gated on a plan having been shown: the turn/start right before
// the first todo/write must emit nothing, so the next frame is the plan
// itself, not an empty clear.
emitEvent('turn/start', { turn: 2 })
emitEvent('todo/write', {
  todos: [
    { content: 'Explore the codebase', status: 'in_progress' },
    { content: 'Write the bridge', status: 'pending' },
    { content: 'Verify in Zed', status: 'pending' },
  ],
})
const planFrame = await readFrame()
console.log('plan ->', JSON.stringify(planFrame.params))
check(planFrame.method === 'session/update', 'plan frame should be session/update')
const planUpdate = planFrame.params?.update
check(planUpdate?.sessionUpdate === 'plan', 'todo/write should emit a plan update')
check(planUpdate?.entries?.length === 3, 'plan should carry all three todos')
check(planUpdate?.entries?.[0]?.content === 'Explore the codebase', 'first plan entry content')
check(planUpdate?.entries?.[0]?.priority === 'medium', 'plan entries should carry a priority')
check(planUpdate?.entries?.[0]?.status === 'in_progress', 'plan entry status maps through')

// A second snapshot replaces the whole list (no partial updates).
emitEvent('todo/write', {
  todos: [
    { content: 'Explore the codebase', status: 'completed' },
    { content: 'Write the bridge', status: 'in_progress' },
  ],
})
const planFrame2 = await readFrame()
const planUpdate2 = planFrame2.params?.update
check(planUpdate2?.sessionUpdate === 'plan', 'second todo/write should emit a plan update')
check(planUpdate2?.entries?.length === 2, 'plan should be replaced wholesale')
check(planUpdate2?.entries?.[1]?.status === 'in_progress', 'second entry status')

// A new turn clears the checklist (web-UI parity: turn/start hides the list).
emitEvent('turn/start', { turn: 2 })
const planClear = await readFrame()
console.log('plan clear ->', JSON.stringify(planClear.params))
check(planClear.params?.update?.sessionUpdate === 'plan', 'turn/start should emit a plan update')
check(planClear.params?.update?.entries?.length === 0, 'turn/start should clear the plan')

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
for (let i = 0; i < 5; i += 1) replay.push(await readFrame())
for (const f of replay) console.log('replay ->', JSON.stringify(f.params))
// loadSession seeds the ring from the persisted projection before answering.
const usageOnLoad = await readFrame()
console.log('usage on load ->', JSON.stringify(usageOnLoad.params))
check(usageOnLoad.params?.update?.sessionUpdate === 'usage_update', 'load should emit usage_update')
check(usageOnLoad.params?.update?.used === 1200, 'load usage_update used tokens')
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
// The todo history folds to a single final plan: the earlier list is cleared
// by the turn boundary, so only "plan B" surfaces.
check(replay[4]?.params?.update?.sessionUpdate === 'plan', 'replay should fold the todo history into a plan')
check(replay[4]?.params?.update?.entries?.length === 1, 'replay plan entry count')
check(replay[4]?.params?.update?.entries?.[0]?.content === 'plan B', 'replay plan should be the latest snapshot')

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
const modelUsage = await readFrame()
console.log('set model usage ->', JSON.stringify(modelUsage.params))
check(modelUsage.params?.update?.sessionUpdate === 'usage_update', 'model switch should refresh usage_update')
const modelResp = await readFrame()
console.log('set model ->', JSON.stringify(modelResp.result))
check(modelResp.result?.configOptions !== undefined, 'set model should return configOptions')

// 9b. Switch to a model without reasoning metadata: the thinking picker must
// fall back to the canonical ordered list instead of disappearing, and the
// select must still carry a schema-required currentValue. The default must be
// the display-only "Provider default" entry — never the first declared level
// (`off`), which would advertise (and, for clients that apply the
// currentValue, enforce) thinking off for a model whose default is actually
// whatever the provider decides.
await send({ jsonrpc: '2.0', id: 17, method: 'session/set_config_option', params: { sessionId, configId: 'model', value: 'deepseek-official/deepseek-v4-lite' } })
const fallbackUsage = await readFrame()
check(fallbackUsage.params?.update?.sessionUpdate === 'usage_update', 'lite model switch should refresh usage_update')
const fallbackResp = await readFrame()
console.log('set model (no reasoning metadata) ->', JSON.stringify(fallbackResp.result?.configOptions))
const fallbackThought = fallbackResp.result?.configOptions?.find((o) => o.id === 'thought_level')
check(fallbackThought !== undefined, 'thought_level should still be advertised without reasoning metadata')
check(
  JSON.stringify(fallbackThought?.options?.map((o) => o.value)) ===
    JSON.stringify(['provider-default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  'fallback thinking levels should lead with provider-default, then the full ordered list',
)
check(
  typeof fallbackThought?.currentValue === 'string' &&
    fallbackThought?.options?.some((o) => o.value === fallbackThought.currentValue),
  'fallback thought_level should carry a valid currentValue',
)
check(
  fallbackThought?.currentValue === 'provider-default',
  'fallback currentValue should be provider-default when nothing is selected, never off',
)

// 10. ask_user_question → ACP elicitation (form mode), per codex-acp.
// 10a. The initial initialize advertised clientCapabilities: {} — asking must
// fail fast with the self-explaining ELICITATION_UNSUPPORTED error instead of
// hanging the turn on a client that cannot render the question.
const unsupportedError = await ctx.userQuestions
  .ask({ agent: captured.agent, questions: [{ id: 'q', question: 'Proceed?' }] })
  .then(
    () => undefined,
    (error) => error,
  )
console.log('unsupported client ->', String(unsupportedError))
check(unsupportedError instanceof Error, 'unsupported client should reject ask_user_question')
check(
  String(unsupportedError.message).includes('elicitation capability'),
  'unsupported client error should explain the missing capability',
)

// 10b. Re-initialize with the elicitation capability advertised.
await send({
  jsonrpc: '2.0',
  id: 20,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
})
const init2 = await readFrame()
console.log('initialize (elicitation) ->', JSON.stringify(init2.result))
check(init2.result?.protocolVersion === 1, 're-initialize should succeed')

// 10c. The agent calls ask_user_question with one options question, one
// multi-select, and one free-text question.
emitEvent('tool/call', {
  turn: 2,
  step: 1,
  callId: 'call-ask',
  name: 'ask_user_question',
  arguments:
    '{"questions":[{"id":"mode","question":"Which preset?","options":[{"label":"standard"},{"label":"code"}]},{"id":"tags","question":"Pick tags","options":[{"label":"a"},{"label":"b"}],"multi_select":true},{"id":"note","question":"Any note?"}]}',
})
const askCard = await readFrame()
console.log('ask card ->', JSON.stringify(askCard.params))
check(askCard.method === 'session/update', 'ask card should be session/update')
check(askCard.params?.update?.sessionUpdate === 'tool_call', 'ask_user_question tool card')
check(askCard.params?.update?.toolCallId === 'call-ask', 'ask card callId')

// 10d. The tool blocks on ctx.userQuestions; the bridge turns it into an
// elicitation/create request correlated with the tool card.
const answersPromise = ctx.userQuestions.ask({
  agent: captured.agent,
  questions: [
    { id: 'mode', question: 'Which preset?', options: [{ label: 'standard' }, { label: 'code' }] },
    { id: 'tags', question: 'Pick tags', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true },
    { id: 'note', question: 'Any note?' },
  ],
})
const elicitation = await readFrame()
console.log('elicitation/create ->', JSON.stringify(elicitation))
check(elicitation.method === 'elicitation/create', 'should be an elicitation/create request')
check(elicitation.params?.sessionId === sessionId, 'elicitation should carry the session id')
check(elicitation.params?.toolCallId === 'call-ask', 'elicitation should correlate with the tool call')
check(elicitation.params?.mode === 'form', 'elicitation should be form mode')
check(elicitation.params?.message === 'Input requested (3 questions)', 'multi-question message summarizes the form')
const schema = elicitation.params?.requestedSchema
check(schema?.type === 'object', 'requestedSchema should be an object schema')
check(
  schema?.properties?.mode?.type === 'string' && schema?.properties?.mode?.oneOf?.[0]?.const === 'standard',
  'options question should be a oneOf string property',
)
check(
  schema?.properties?.tags?.type === 'array' && schema?.properties?.tags?.items?.enum?.length === 2,
  'multi-select question should be an array enum property',
)
check(
  schema?.properties?.note?.type === 'string' && schema?.properties?.note?.oneOf === undefined,
  'free-text question should be a plain string property',
)
// Option questions carry an optional free-text Other field (the ACP rendering
// of dsh's custom-answer channel) and are therefore not required; only the
// option-less question is.
check(
  schema?.properties?.mode__other?.type === 'string' &&
    schema?.properties?.mode__other?.title === 'Other' &&
    schema?.properties?.mode__other?.description?.includes('Type your own answer'),
  'single-select question should gain an Other input',
)
check(
  schema?.properties?.tags__other?.type === 'string' && schema?.properties?.tags__other?.title === 'Other',
  'multi-select question should gain an Other input',
)
check(schema?.properties?.note__other === undefined, 'option-less question should not gain an Other input')
check(
  schema?.required?.length === 1 && schema?.required?.[0] === 'note',
  'only the option-less question should be required',
)

// 10e. The user answers; accept content maps back to dsh answers (picked
// options → selected labels, Other text → custom — replacing the pick on
// single-select, riding alongside it on multi-select — matching the web UI).
await send({
  jsonrpc: '2.0',
  id: elicitation.id,
  result: {
    action: 'accept',
    content: { mode: 'standard', mode__other: 'run with vitest', tags: ['a', 'b'], tags__other: 'extra', note: 'hello there' },
  },
})
const answers = await answersPromise
console.log('answers ->', JSON.stringify(answers))
check(answers?.answers?.length === 3, 'three answers')
check(
  answers?.answers?.[0]?.id === 'mode' && answers.answers[0].custom === 'run with vitest' && answers.answers[0].selected?.length === 0,
  'typed Other should replace the picked option (single-select)',
)
check(
  answers?.answers?.[1]?.id === 'tags' && answers.answers[1].selected?.length === 2 && answers.answers[1].custom === 'extra',
  'multi-select should keep the selection and carry the Other text',
)
check(
  answers?.answers?.[2]?.id === 'note' && answers.answers[2].custom === 'hello there' && answers.answers[2].selected?.length === 0,
  'free text should land in custom',
)

// 10f. The tool completes; the queued callId is drained and the card updates.
emitEvent('tool/result', {
  turn: 2,
  step: 1,
  message: {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-ask', content: [{ type: 'text', text: '{"answers":[]}' }] }],
    source: { kind: 'tool' },
  },
})
const askResult = await readFrame()
console.log('ask result ->', JSON.stringify(askResult.params))
check(askResult.params?.update?.sessionUpdate === 'tool_call_update', 'ask tool_call_update')
check(askResult.params?.update?.toolCallId === 'call-ask' && askResult.params?.update?.status === 'completed', 'ask card completed')
// The tool/result also refreshes the context-usage ring (pressureOn → one
// usage_update frame) before the next ask_user_question card below.
const askUsage = await readFrame()
check(askUsage.params?.update?.sessionUpdate === 'usage_update', 'ask tool/result should refresh usage_update')

// 10g. A question answered through the Other input alone (no option picked) —
// the "其他" scenario: the user types instead of choosing an option.
emitEvent('tool/call', {
  turn: 2,
  step: 2,
  callId: 'call-ask-other',
  name: 'ask_user_question',
  arguments: '{"questions":[{"id":"mode","question":"Which preset?","options":[{"label":"standard"},{"label":"code"}]}]}',
})
await readFrame()
const otherOnlyPromise = ctx.userQuestions.ask({
  agent: captured.agent,
  questions: [{ id: 'mode', question: 'Which preset?', options: [{ label: 'standard' }, { label: 'code' }] }],
})
const elicitationOther = await readFrame()
await send({ jsonrpc: '2.0', id: elicitationOther.id, result: { action: 'accept', content: { mode__other: 'custom runner' } } })
const otherOnly = await otherOnlyPromise
console.log('other-only ->', JSON.stringify(otherOnly))
check(
  otherOnly?.answers?.[0]?.id === 'mode' &&
    otherOnly.answers[0].custom === 'custom runner' &&
    otherOnly.answers[0].selected?.length === 0,
  'Other-only answer should land in custom',
)

// 10h. A declined elicitation surfaces as ASK_CANCELLED, and an aborted turn
// (signal) as ASK_ABORTED — neither hangs the tool.
emitEvent('tool/call', {
  turn: 2,
  step: 3,
  callId: 'call-ask2',
  name: 'ask_user_question',
  arguments: '{"questions":[{"id":"confirm","question":"Proceed?"}]}',
})
await readFrame()
const declinedPromise = ctx.userQuestions.ask({ agent: captured.agent, questions: [{ id: 'confirm', question: 'Proceed?' }] })
const elicitation2 = await readFrame()
await send({ jsonrpc: '2.0', id: elicitation2.id, result: { action: 'decline' } })
const declineError = await declinedPromise.then(
  () => undefined,
  (error) => error,
)
console.log('decline ->', String(declineError))
check(declineError instanceof Error && String(declineError.message).includes('declined'), 'decline should reject as cancelled')

const abortController = new AbortController()
emitEvent('tool/call', {
  turn: 2,
  step: 4,
  callId: 'call-ask3',
  name: 'ask_user_question',
  arguments: '{"questions":[{"id":"note","question":"Anything else?"}]}',
})
await readFrame()
const abortedPromise = ctx.userQuestions.ask({
  agent: captured.agent,
  questions: [{ id: 'note', question: 'Anything else?' }],
  signal: abortController.signal,
})
const elicitation3 = await readFrame()
abortController.abort()
const abortError = await abortedPromise.then(
  () => undefined,
  (error) => error,
)
console.log('abort ->', String(abortError))
check(abortError instanceof Error && String(abortError.message).includes('aborted'), 'abort should reject as aborted')

// 11. session/prompt — a recognized slash command dispatches in the command
// plane rather than reaching the model: `/plan` must run here so plan mode
// activates (and a later exit_plan_mode succeeds). The command result text
// surfaces as a message chunk and the prompt settles without a model turn.
captured.agent.followedUp = false
await send({ jsonrpc: '2.0', id: 31, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/plan' }] } })
const commandChunk = await readFrame()
console.log('command dispatch chunk ->', JSON.stringify(commandChunk.params))
check(commandChunk.method === 'session/update', 'command result should be a session/update')
check(commandChunk.params?.update?.sessionUpdate === 'agent_message_chunk', 'command result should surface as a message chunk')
check(commandChunk.params?.update?.content?.text === 'Plan mode on. Use /plan off to leave.', 'command result text should surface')
const commandResp = await readFrame()
console.log('command dispatch response ->', JSON.stringify(commandResp.result))
check(commandResp.id === 31, 'command prompt should resolve')
check(commandResp.result?.stopReason === 'end_turn', 'a recognized command should end the turn')
check(captured.agent.followedUp === false, 'a recognized command should not reach the model as input')

// 11b. Non-command text still drives the model through the ordinary prompt path.
await send({ jsonrpc: '2.0', id: 32, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'write a function' }] } })
const modelPromptResp = await readFrame()
console.log('model prompt response ->', JSON.stringify(modelPromptResp.result))
check(modelPromptResp.id === 32, 'non-command prompt should resolve')
check(captured.agent.followedUp === true, 'non-command text should reach the model via followup')

// 12. Image prompts: ACP image blocks are admitted through the durable
// attachment seam before the message is created, and the message carries only
// the durable references — in submission order, with text blocks preserved.
const imageData = Buffer.from('fake-png-bytes').toString('base64')
captured.agent.followedUp = false
captured.agent.lastMessage = undefined
await send({
  jsonrpc: '2.0',
  id: 41,
  method: 'session/prompt',
  params: {
    sessionId,
    prompt: [
      { type: 'text', text: 'look at this: ' },
      { type: 'image', mimeType: 'image/png', data: imageData },
      { type: 'text', text: ' and this' },
    ],
  },
})
const imagePromptResp = await readFrame()
console.log('image prompt response ->', JSON.stringify(imagePromptResp.result))
check(imagePromptResp.id === 41 && imagePromptResp.error === undefined, 'image prompt should resolve')
check(captured.agent.followedUp === true, 'image prompt should reach the model via followup')
check(
  admittedImages.length === 1 && admittedImages[0].mediaType === 'image/png',
  'the image should be admitted through the attachment store',
)
const imageBlocks = captured.agent.lastMessage?.content?.filter((b) => b.type === 'image')
check(imageBlocks?.length === 1, 'message should carry exactly one image block')
check(
  imageBlocks?.[0]?.attachment?.attachmentId === 'sha256:test-image-0' &&
    imageBlocks[0].attachment.mediaType === 'image/png',
  'image block should carry the durable reference, never the base64 upload',
)
const textParts = captured.agent.lastMessage?.content?.filter((b) => b.type === 'text')
check(
  textParts?.length === 2 && textParts[0].text === 'look at this: ' && textParts[1].text === ' and this',
  'text blocks should keep their order around image blocks',
)

// 12b. An image-only prompt is a valid prompt (no text required).
captured.agent.followedUp = false
captured.agent.lastMessage = undefined
await send({
  jsonrpc: '2.0',
  id: 42,
  method: 'session/prompt',
  params: {
    sessionId,
    prompt: [{ type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') }],
  },
})
const imageOnlyResp = await readFrame()
console.log('image-only prompt response ->', JSON.stringify(imageOnlyResp.result))
check(imageOnlyResp.id === 42 && imageOnlyResp.error === undefined, 'image-only prompt should be accepted')
check(
  captured.agent.lastMessage?.content?.filter((b) => b.type === 'image').length === 1,
  'image-only prompt should carry one image block',
)

// 12c. An admission rejection is a caller-correctable input error
// (invalidParams), not an internal failure.
failAdmission = true
await send({
  jsonrpc: '2.0',
  id: 43,
  method: 'session/prompt',
  params: { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: imageData }] },
})
const admissionResp = await readFrame()
console.log('admission rejection ->', JSON.stringify(admissionResp.error))
check(admissionResp.id === 43, 'admission rejection should respond')
check(
  admissionResp.error?.code === -32602 && String(admissionResp.error?.message).includes('byte limit'),
  'admission failure should map to invalidParams with the store message',
)
failAdmission = false

// 12d. Unsupported content (audio, embedded resource) is still rejected.
await send({
  jsonrpc: '2.0',
  id: 44,
  method: 'session/prompt',
  params: { sessionId, prompt: [{ type: 'audio', mimeType: 'audio/mp3', data: imageData }] },
})
const audioResp = await readFrame()
check(audioResp.id === 44 && audioResp.error?.code === -32602, 'audio prompts should still be rejected')

// 12e. A slash command with images hands the raw uploads to the command plane
// (the command owns its own admission) and passes the abort signal through.
captured.agent.followedUp = false
captured.agent.lastMessage = undefined
lastCommandImages = undefined
lastCommandSignal = undefined
await send({
  jsonrpc: '2.0',
  id: 45,
  method: 'session/prompt',
  params: {
    sessionId,
    prompt: [
      { type: 'text', text: '/plan' },
      { type: 'image', mimeType: 'image/png', data: imageData },
    ],
  },
})
const commandImageChunk = await readFrame()
const commandImageResp = await readFrame()
console.log('command with images response ->', JSON.stringify(commandImageResp.result))
check(commandImageChunk.params?.update?.content?.text === 'Plan mode on. Use /plan off to leave.', 'command with images should surface its result text')
check(commandImageResp.id === 45 && commandImageResp.result?.stopReason === 'end_turn', 'command with images should dispatch')
check(commandImageResp.id === 45 && commandImageResp.result?.stopReason === 'end_turn', 'command with images should dispatch')
check(
  lastCommandImages?.length === 1 && lastCommandImages[0].mediaType === 'image/png' && lastCommandImages[0].data === imageData,
  'command should receive the raw base64 upload, not a reference',
)
check(lastCommandSignal instanceof AbortSignal, 'command should receive the abort signal')
check(captured.agent.followedUp === false, 'a command with images should not reach the model as input')

// 13. session/new with client-forwarded MCP servers (e.g. JetBrains AI
// Assistant) must succeed — they are ignored, not rejected.
await send({
  jsonrpc: '2.0',
  id: 46,
  method: 'session/new',
  params: {
    cwd: '/Users/a11111/code/dsh-acp',
    mcpServers: [
      {
        name: 'ide-configured',
        command: 'mcp-server',
        args: ['--stdio'],
        env: [],
      },
    ],
    additionalDirectories: [],
  },
})
// Notifications (usage_update / available_commands_update) may precede the
// response, so skip frames until the reply to id 46 arrives.
let mcpServersResp
for (let i = 0; i < 5 && mcpServersResp === undefined; i++) {
  const frame = await readFrame()
  if (frame.id === 46) mcpServersResp = frame
}
console.log('session/new with mcpServers ->', JSON.stringify(mcpServersResp))
check(mcpServersResp.id === 46 && mcpServersResp.error === undefined, 'session/new with mcpServers should be accepted')
check(
  typeof mcpServersResp.result?.sessionId === 'string' && mcpServersResp.result.sessionId.length > 0,
  'mcpServers-ignoring session/new should return a sessionId',
)

console.log(failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
