// Hermetic dsh-acp protocol smoke test. It exercises the ACP wire surface and
// the editor-facing projections against mock dsh services without touching the
// model stack or $DSH_HOME.
//
// Run: node smoke-test.mjs

import { Context } from '@deepseek-ai/cordis'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { apply } from './lib/index.js'
import { askViaAcp } from './lib/elicitation.js'
import { mountAcpMcpServers } from './lib/mcp.js'

const PROJECT_CWD = '/Users/a11111/code/dsh-acp'
const agentToClient = new TransformStream()
const clientToAgent = new TransformStream()

let failures = 0
function check(condition, message) {
  if (!condition) {
    failures += 1
    console.error('FAIL:', message)
  }
}

class FakeAgent {
  constructor(session) {
    this.id = session.id
    this.session = session
    this.followedUp = false
    this.lastMessage = undefined
    this.busy = false
    this.idleWaiters = []
  }

  followup(message) {
    this.followedUp = true
    this.lastMessage = message
    this.busy = true
  }

  cancel() {
    this.finishTurn()
  }

  whenIdle() {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  finishTurn() {
    this.busy = false
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}

function makeSession(id, cwd, events = []) {
  return {
    id,
    header: { id, cwd, createdAt: 1_700_000_000_000 },
    snapshotEvents: () => events,
    requestHeader: () => undefined,
    requestContext: () => ({ contextWindow: 128000 }),
  }
}

const liveSessions = new Map()
const agents = new Map()
let lastCreateOptions
let lastResumeOptions

const persisted = new Map([
  ['persist-1', {
    header: { id: 'persist-1', cwd: PROJECT_CWD, createdAt: 1_600_000_000_000 },
    revision: 'revision-1',
  }],
])
const eventsBySession = new Map([
  ['persist-1', [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'assistant-1', content: [{ type: 'text', text: 'hello back' }] } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-replay', name: 'read', arguments: '{"file_path":"/tmp/replay.txt"}' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'call-replay', content: [{ type: 'tool-result', toolCallId: 'call-replay', content: [{ type: 'text', text: 'replayed' }] }] } } },
    { type: 'todo/write', data: { todos: [{ content: 'replay plan', status: 'pending' }] } },
  ]],
])

const ctx = new Context()
ctx.provide('logger', {
  debug() {},
  warn(message) { console.error('WARN:', message) },
  error(message) { console.error('ERROR:', message) },
})
ctx.provide('agents', {
  async create(options) {
    lastCreateOptions = options
    const session = makeSession(options.sessionId, options.meta?.cwd ?? PROJECT_CWD)
    const agent = new FakeAgent(session)
    const agentCtx = new Context(ctx)
    await options.setup?.(agentCtx, agent)
    liveSessions.set(session.id, session)
    agents.set(session.id, agent)
    return { agent, dispose: async () => { agents.delete(session.id); liveSessions.delete(session.id) } }
  },
  async resume(options) {
    lastResumeOptions = options
    const session = makeSession(options.resumeSessionId, PROJECT_CWD, eventsBySession.get(options.resumeSessionId) ?? [])
    session.header = persisted.get(options.resumeSessionId)?.header ?? session.header
    const agent = new FakeAgent(session)
    const agentCtx = new Context(ctx)
    await options.setup?.(agentCtx, agent)
    liveSessions.set(session.id, session)
    agents.set(session.id, agent)
    return { agent, dispose: async () => { agents.delete(session.id); liveSessions.delete(session.id) } }
  },
  get(id) { return agents.get(id) },
  roots() { return [...agents.values()] },
})
ctx.provide('agentDefaultModel', {
  currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }),
})
ctx.provide('llm', {
  listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
  listModels: async () => [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  ],
  resolveModelInfo: async (_provider, model) => ({
    inputModalities: ['text', 'image'],
    ...(model === 'deepseek-v4-flash'
      ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }
      : { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }),
  }),
  resolveCallConfig: async (selection) => selection,
})
ctx.provide('permissionPresets', {
  names: ['read-only', 'workspace-write', 'danger-full-access'],
  current() { return this.value ?? 'workspace-write' },
  set(_session, value) { this.value = value },
})
let lastCommandInput
ctx.provide('commands', {
  list: () => [{ name: 'plan', description: 'Enter plan mode', input: { hint: '[off|message]', attachments: true } }],
  async execute(_agent, line, attachments, signal) {
    lastCommandInput = { line, attachments, signal }
    if (line.trimStart().startsWith('/plan')) {
      return { commandId: 'command-1', result: { kind: 'success', text: 'Plan mode enabled.' } }
    }
    return undefined
  },
})
const admittedImages = []
ctx.provide('attachments', {
  imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  async saveImages(images) {
    admittedImages.push(...images)
    return images.map((image, index) => ({
      attachmentId: `sha256:smoke-${index}`,
      mediaType: image.mediaType,
      bytes: image.data.byteLength,
      width: 1,
      height: 1,
    }))
  },
})
ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 1200 }) })
ctx.provide('agentPresets', {
  defaultId: 'standard',
  async mount(_ctx, id) { return { id: id ?? 'standard' } },
})
ctx.provide('sessionPersistence', {
  async list() { return [...persisted.values()] },
  async stat(id) { return persisted.get(id) },
  locate(header) { return { kind: 'jsonl', path: `/tmp/dsh-acp-smoke/${header.id}/session.v3.jsonl` } },
})
ctx.provide('sessions', {
  get(id) { return liveSessions.get(id) },
  async flush(session) {
    persisted.set(session.id, {
      header: { ...session.header },
      revision: `revision-${persisted.size + 1}`,
    })
  },
})

apply(ctx, {
  stream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
  preset: 'standard',
  sessionListPageSize: 50,
})

const writer = clientToAgent.writable.getWriter()
const reader = agentToClient.readable.getReader()
const encoder = new TextEncoder()
const decoder = new TextDecoder()
let buffer = ''
const skippedFrames = []

async function send(frame) {
  await writer.write(encoder.encode(`${JSON.stringify(frame)}\n`))
}

async function readFrame(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) return JSON.parse(line)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`timed out waiting for frame; buffered=${JSON.stringify(buffer)}`)
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), Math.min(remaining, 250))),
    ])
    if (result.done) throw new Error('stream closed before frame')
    if (result.value) buffer += decoder.decode(result.value, { stream: true })
  }
}

async function response(id) {
  for (;;) {
    const frame = await readFrame()
    if (frame.id === id) return frame
    if (frame.method === 'session/update') skippedFrames.push(frame)
  }
}

function emitEvent(session, type, data) {
  ctx.emit('session/event', session, { type, data, seq: 0, time: 0 })
}

function nextFrame() { return readFrame() }

// 1. initialize
await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } } })
const initialized = await response(1)
console.log('initialize ->', JSON.stringify(initialized.result))
check(initialized.result?.agentInfo?.name === 'dsh-acp', 'initialize identifies dsh-acp')
check(initialized.result?.agentCapabilities?.loadSession === true, 'loadSession advertised')
check(initialized.result?.agentCapabilities?.promptCapabilities?.image === true, 'image prompt advertised')
check(initialized.result?.agentCapabilities?.sessionCapabilities?.resume !== undefined, 'resume advertised')
check(initialized.result?.agentCapabilities?.sessionCapabilities?.close !== undefined, 'close advertised')
check(initialized.result?.agentCapabilities?.sessionCapabilities?.delete !== undefined, 'delete extension advertised')

// 2. session/new
await send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: PROJECT_CWD, mcpServers: [] } })
const created = await response(2)
const sessionId = created.result?.sessionId
const session = liveSessions.get(sessionId)
const agent = agents.get(sessionId)
console.log('session/new ->', sessionId)
check(typeof sessionId === 'string' && sessionId.length > 0, 'session/new returns an id')
check(lastCreateOptions?.meta?.agentPreset === 'standard', 'session/new records the selected preset')
check(lastCreateOptions?.setup !== undefined, 'session/new composes an unpublished agent scope')
check(created.result?.configOptions?.some((option) => option.id === 'permission'), 'permission selector advertised')
check(created.result?.configOptions?.some((option) => option.id === 'model'), 'model selector advertised')
check(created.result?.configOptions?.some((option) => option.id === 'thought_level'), 'thinking selector advertised')
check(persisted.has(sessionId), 'session/new flushes an empty durable session')
const commandCatalog = await nextFrame()
check(commandCatalog.params?.update?.sessionUpdate === 'available_commands_update', 'commands advertised after session creation')

// 3. live assistant stream and committed event coordination
ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 } })
ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello ' } } })
ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 1, time: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } } })
const liveText = await nextFrame()
const liveThought = await nextFrame()
check(liveText.params?.update?.sessionUpdate === 'agent_message_chunk', 'live text projected')
check(liveText.params?.update?.content?.text === 'Hello ', 'live text preserved')
check(liveThought.params?.update?.sessionUpdate === 'agent_thought_chunk', 'live reasoning projected')
ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'attempt-1', revision: 1, index: 2, outcome: { kind: 'abandoned' } } })
emitEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'assistant-1', content: [{ type: 'text', text: 'Hello world' }, { type: 'reasoning', text: 'thinking more' }] } })

// 4. rich tool call, diff result, and terminal result
emitEvent(session, 'tool/call', { turn: 1, step: 1, callId: 'call-write', name: 'write', arguments: '{"file_path":"/tmp/dsh-acp-smoke.txt"}' })
const toolCall = await nextFrame()
check(toolCall.params?.update?.sessionUpdate === 'tool_call', 'tool call projected')
check(toolCall.params?.update?.kind === 'edit', 'write maps to edit kind')
check(toolCall.params?.update?.locations?.[0]?.path === '/tmp/dsh-acp-smoke.txt', 'tool location projected')
emitEvent(session, 'tool/result', {
  turn: 1,
  step: 1,
  message: { toolCallId: 'call-write', content: [{ type: 'tool-result', toolCallId: 'call-write', content: [{ type: 'text', text: 'done' }] }] },
  meta: { diffs: [{ path: '/tmp/dsh-acp-smoke.txt', oldText: null, newText: 'hello' }] },
})
const toolResult = await nextFrame()
check(toolResult.params?.update?.sessionUpdate === 'tool_call_update', 'tool result projected')
check(toolResult.params?.update?.content?.[0]?.type === 'diff', 'structured diff projected')

emitEvent(session, 'tool/call', { turn: 1, step: 1, callId: 'call-bash', name: 'bash', arguments: '{"command":"printf hi"}' })
const terminalCall = await nextFrame()
check(terminalCall.params?.update?.content?.[0]?.type === 'terminal', 'bash tool call advertises terminal content')
emitEvent(session, 'tool/result', {
  turn: 1,
  step: 1,
  message: { toolCallId: 'call-bash', content: [{ type: 'tool-result', toolCallId: 'call-bash', content: [{ type: 'text', text: 'hi' }] }] },
  meta: { card: 'terminal', output: 'hi', exitCode: 0 },
})
const terminalResult = await nextFrame()
check(terminalResult.params?.update?._meta?.terminal_output?.data === 'hi', 'terminal output projected')
check(terminalResult.params?.update?._meta?.terminal_exit?.exit_code === 0, 'terminal exit projected')

// 5. plan replacement and clear
emitEvent(session, 'todo/write', { todos: [{ content: 'step one', status: 'in_progress' }] })
const plan = await nextFrame()
check(plan.params?.update?.sessionUpdate === 'plan', 'todo snapshot maps to plan')
check(plan.params?.update?.entries?.[0]?.priority === 'medium', 'plan priority defaulted')
emitEvent(session, 'turn/start', { turn: 2 })
const planClear = await nextFrame()
check(planClear.params?.update?.entries?.length === 0, 'new turn clears a visible plan')

// 6. permission and model config updates
await send({ jsonrpc: '2.0', id: 6, method: 'session/set_config_option', params: { sessionId, configId: 'permission', value: 'danger-full-access' } })
const permissionResponse = await response(6)
check(permissionResponse.result?.configOptions?.find((option) => option.id === 'permission')?.currentValue === 'danger-full-access', 'permission selector updates')
await send({ jsonrpc: '2.0', id: 7, method: 'session/set_config_option', params: { sessionId, configId: 'model', value: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']) } })
const modelResponse = await response(7)
check(modelResponse.result?.configOptions?.find((option) => option.id === 'model')?.currentValue?.includes('deepseek-v4-flash'), 'model selector updates')

// 7. slash commands stay in the command plane and receive raw image attachments
const imageData = Buffer.from('smoke-image').toString('base64')
await send({
  jsonrpc: '2.0',
  id: 8,
  method: 'session/prompt',
  params: { sessionId, prompt: [{ type: 'text', text: '/plan' }, { type: 'image', mimeType: 'image/png', data: imageData }] },
})
const commandChunk = await nextFrame()
check(commandChunk.params?.update?.content?.text === 'Plan mode enabled.', 'command result surfaces')
const commandResponse = await response(8)
check(commandResponse.result?.stopReason === 'end_turn', 'command prompt settles')
check(lastCommandInput?.attachments?.[0]?.type === 'image', 'command receives typed image attachment')
check(lastCommandInput?.attachments?.[0]?.data === imageData, 'command receives raw image data')
check(lastCommandInput?.signal instanceof AbortSignal, 'command receives cancellation signal')
check(agent.followedUp === false, 'recognized command does not enter model history')

// 8. model prompt admission, image admission, and stop reason
await send({ jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'implement this' }] } })
await new Promise((resolve) => setTimeout(resolve, 0))
check(agent.followedUp === true, 'ordinary prompt enters model path')
check(agent.lastMessage?.content?.[0]?.text === 'implement this', 'ordinary prompt text preserved')
ctx.emit('agent/inbox/claimed', { agent, message: agent.lastMessage, turn: 3 })
emitEvent(session, 'turn/start', { turn: 3 })
emitEvent(session, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
agent.finishTurn()
const promptResponse = await response(9)
check(promptResponse.result?.stopReason === 'end_turn', 'prompt stop reason maps')
agent.followedUp = false

await send({
  jsonrpc: '2.0',
  id: 10,
  method: 'session/prompt',
  params: { sessionId, prompt: [{ type: 'text', text: 'look: ' }, { type: 'image', mimeType: 'image/png', data: imageData }] },
})
await new Promise((resolve) => setTimeout(resolve, 0))
check(admittedImages.length === 1, 'image admitted once through attachment service')
check(agent.lastMessage?.content?.some((block) => block.type === 'image' && block.attachment?.attachmentId === 'sha256:smoke-0'), 'model receives durable image reference')
ctx.emit('agent/inbox/claimed', { agent, message: agent.lastMessage, turn: 4 })
emitEvent(session, 'turn/start', { turn: 4 })
emitEvent(session, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
agent.finishTurn()
await response(10)

// 9. close, list, resume, and delete
await send({ jsonrpc: '2.0', id: 11, method: 'session/close', params: { sessionId } })
await response(11)
await send({ jsonrpc: '2.0', id: 12, method: 'session/list', params: {} })
const listed = await response(12)
check(listed.result?.sessions?.some((item) => item.sessionId === sessionId), 'closed session is listable')
await send({ jsonrpc: '2.0', id: 13, method: 'session/resume', params: { sessionId, cwd: PROJECT_CWD, mcpServers: [] } })
const resumed = await response(13)
check(resumed.result?.configOptions !== undefined, 'session/resume restores options')
check(lastResumeOptions?.meta?.agentPreset === undefined, 'resume does not invent create metadata')
await send({ jsonrpc: '2.0', id: 14, method: 'session/close', params: { sessionId } })
await response(14)
await send({ jsonrpc: '2.0', id: 15, method: 'session/delete', params: { sessionId } })
const deleted = await response(15)
check(deleted.result !== undefined, 'session/delete succeeds')

// 10. non-standard load replays durable history before responding
await send({ jsonrpc: '2.0', id: 16, method: 'session/load', params: { sessionId: 'persist-1', cwd: PROJECT_CWD, mcpServers: [] } })
const loaded = await response(16)
const replayUpdates = skippedFrames.filter((frame) => frame.params?.sessionId === 'persist-1').map((frame) => frame.params.update)
check(loaded.result?.configOptions !== undefined, 'session/load succeeds')
check(replayUpdates.some((update) => update.sessionUpdate === 'user_message_chunk' && update.content?.text === 'hello'), 'load replays user history')
check(replayUpdates.some((update) => update.sessionUpdate === 'agent_message_chunk' && update.content?.text === 'hello back'), 'load replays assistant history')
check(replayUpdates.some((update) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'call-replay'), 'load replays tool cards')
check(replayUpdates.some((update) => update.sessionUpdate === 'plan' && update.entries?.[0]?.content === 'replay plan'), 'load folds todo history into a plan')
await send({ jsonrpc: '2.0', id: 17, method: 'session/close', params: { sessionId: 'persist-1' } })
await response(17)

// 11. MCP validation and stable elicitation conversion
await send({
  jsonrpc: '2.0',
  id: 18,
  method: 'session/new',
  params: { cwd: PROJECT_CWD, mcpServers: [{ name: 'bad', command: 'relative-server', args: [], env: [] }] },
})
const invalidMcp = await response(18)
check(invalidMcp.error?.code === -32602, 'relative MCP command rejected as invalid params')

const mcpConfigs = []
await mountAcpMcpServers({
  async plugin(_plugin, config) { mcpConfigs.push(config) },
}, [
  {
    name: 'Local Tools!',
    command: process.execPath,
    args: ['server.mjs'],
    env: [{ name: 'TOKEN', value: 'secret' }],
  },
  {
    type: 'http',
    name: 'Remote Tools',
    url: 'https://example.test/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer test' }],
  },
], PROJECT_CWD)
check(mcpConfigs.length === 2, 'both MCP transports mapped')
check(mcpConfigs[0]?.transport === 'stdio' && mcpConfigs[0]?.env?.TOKEN === 'secret', 'stdio MCP config mapped')
check(mcpConfigs[1]?.transport === 'streamable-http' && mcpConfigs[1]?.headers?.Authorization === 'Bearer test', 'HTTP MCP config mapped')
let duplicateMcpRejected = false
try {
  await mountAcpMcpServers({ async plugin() {} }, [
    { name: 'same', command: process.execPath, args: [], env: [] },
    { name: 'same', command: process.execPath, args: [], env: [] },
  ], PROJECT_CWD)
} catch (error) {
  duplicateMcpRejected = String(error).includes('duplicate normalized name')
}
check(duplicateMcpRejected, 'duplicate normalized MCP names rejected')

let elicited
const answer = await askViaAcp({
  connection: () => ({
    async request(method, params) {
      check(method === 'elicitation/create', 'elicitation uses stable wire method')
      elicited = params
      return { action: 'accept', content: { choice: 'standard', note: 'details' } }
    },
  }),
  supportsForm: () => true,
}, {
  questions: [
    { id: 'choice', question: 'Pick one', options: [{ label: 'standard' }, { label: 'cordis' }] },
    { id: 'note', question: 'Details' },
  ],
  wait: { callId: 'call-question' },
}, sessionId)
check(elicited?.sessionId === sessionId, 'elicitation carries session id')
check(elicited?.toolCallId === 'call-question', 'elicitation correlates the tool call id')
check(elicited?.mode === 'form', 'elicitation uses form mode')
check(elicited?.requestedSchema?.properties?.choice?.oneOf?.length === 2, 'single select schema emitted')
check(elicited?.requestedSchema?.required?.includes('note'), 'free-text question is required')
check(answer.answers?.[0]?.selected?.[0] === 'standard', 'selected option converted')
check(answer.answers?.[1]?.custom === 'details', 'free-text answer converted')

console.log(failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
