/**
 * Automation-only Agent Client Protocol (ACP) server over JSON-RPC stdio.
 *
 * The bridge exposes fresh DeepSeek Harness sessions to ACP clients such as
 * Zed and other IDEs. It carries prompt text, committed assistant text,
 * cancellation, and one-shot permission decisions; presentation and
 * human-interaction features stay with the harness's UI modules.
 *
 * This is a port of `@deepseek-ai/dsh-acp` (packages/acp/acp in the
 * deepseek-harness repo) to a self-contained, plain-JavaScript dsh profile
 * bundle that rides over `dsh-base`.
 *
 * @module dsh-acp
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'acp'

/**
 * The bridge creates and owns agents; every other concern is carried by the
 * agent composition. `agentDefaultModel` supplies the provider/model when the
 * plugin config does not pin one (mirrors the headless runner).
 */
export const inject = ['agents', 'agentDefaultModel']

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail) {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail) {
  return RequestError.internalError(undefined, detail)
}

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param {import('@deepseek-ai/dsh-session').TurnEndReason} reason
 * @returns {import('@agentclientprotocol/sdk').StopReason}
 */
function turnEndToStopReason(reason) {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

/**
 * Flatten an ACP prompt's baseline blocks to text. Text blocks concatenate
 * verbatim; resource links become explicit textual references so a baseline
 * client can point at files without the bridge silently dropping that context.
 * @param {readonly import('@agentclientprotocol/sdk').ContentBlock[]} prompt
 * @returns {string}
 */
function acpPromptToText(prompt) {
  return prompt
    .flatMap((block) => {
      switch (block.type) {
        case 'text':
          return [block.text]
        case 'resource_link':
          return [
            `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`,
          ]
        default:
          return []
      }
    })
    .join('')
}

/**
 * Whether a prompt carries content beyond the ACP baseline (text and
 * resource_link). Richer inline payloads (image, audio, embedded resource) are
 * optional capabilities this bridge does not advertise, so they are rejected
 * rather than silently dropped.
 * @param {readonly import('@agentclientprotocol/sdk').ContentBlock[]} prompt
 * @returns {boolean}
 */
function promptHasUnsupportedContent(prompt) {
  return prompt.some((block) => block.type !== 'text' && block.type !== 'resource_link')
}

/** Reject session features outside the automation contract. */
function validateSessionParams(params) {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
}

/** Tool names whose execution mutates a file (structured-diff candidates). */
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * Map a DSH tool name to ACP's {@link ToolKind}.
 * @param {string} name
 * @returns {import('@agentclientprotocol/sdk').ToolKind}
 */
function toToolKind(name) {
  switch (name) {
    case 'read':
    case 'read_image':
    case 'glob':
    case 'grep':
      return 'read'
    case 'write':
    case 'edit':
    case 'str_replace_editor':
      return 'edit'
    case 'bash':
    case 'pwsh':
      return 'execute'
    default:
      return 'other'
  }
}

/** The file a tool targets, from its arguments (`path` or `file_path`). */
function getToolPath(args) {
  if (typeof args?.path === 'string') return args.path
  if (typeof args?.file_path === 'string') return args.file_path
  return undefined
}

/** A short, human-readable card title: the command for shells, else the tool name. */
function toolTitle(name, args) {
  if ((name === 'bash' || name === 'pwsh') && typeof args?.command === 'string') {
    const cmd = args.command.trim()
    return cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd
  }
  return name
}

/** Resolve a tool's file target into an ACP location, against the session cwd. */
function toToolCallLocations(args, cwd) {
  const path = getToolPath(args)
  if (!path) return undefined
  return [{ path: isAbsolute(path) ? path : resolve(cwd, path) }]
}

/** The old-text needle an edit-style tool will replace, for line inference. */
function getEditNeedle(name, args) {
  if (name === 'edit' && typeof args?.old_string === 'string') return args.old_string
  if (name === 'str_replace_editor' && typeof args?.old_str === 'string') return args.old_str
  return undefined
}

/** Infer a 1-based line for a needle that appears exactly once in the pre-edit text. */
function findUniqueLineNumber(text, needle) {
  if (!needle || typeof text !== 'string') return undefined
  const first = text.indexOf(needle)
  if (first < 0) return undefined
  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined
  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

/** Human-readable label for a permission preset key. */
function permissionLabel(name) {
  switch (name) {
    case 'read-only':
      return 'Read only'
    case 'workspace-write':
      return 'Workspace write'
    case 'danger-full-access':
      return 'Full access'
    default:
      return name
  }
}

/** Parse a raw JSON arguments string, degrading to a raw wrapper on failure. */
function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : { raw }
  } catch {
    return { raw }
  }
}

/** Extract visible text from a ToolResultMessage's single tool-result block. */
function toolResultToText(message) {
  const block = message?.content?.[0]
  if (block?.type !== 'tool-result') return ''
  return (block.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Mount the automation-only ACP server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context carrying the agent factory and session events.
 * @param {{provider?: string, model?: string}} config - Initial provider/model selection.
 */
export function apply(ctx, config = {}) {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const agents = ctx.agents
  const defaultModel = ctx.agentDefaultModel
  const sessionPersistence = ctx.get('sessionPersistence')
  const llm = ctx.get('llm')
  const permissionPresets = ctx.get('permissionPresets')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const agentPresets = ctx.get('agentPresets')
  const logger = ctx.logger ?? {
    warn() {},
    error() {},
  }
  const sessions = new Map()
  /** Pre-mutation file snapshots keyed by tool callId, for structured diffs. */
  const fileSnapshots = new Map()
  /** Serialize session/update delivery so chunks, tool cards, and updates stay ordered. */
  let emitChain = Promise.resolve()
  let closed = false
  let conn

  /** Resolve the provider/model for a new agent: pinned config wins, else the default model selection. */
  const resolveAgentOptions = () => {
    const selection = defaultModel?.currentSelection?.()
    return {
      ...(config.provider !== undefined || selection?.provider !== undefined
        ? { provider: config.provider ?? selection.provider }
        : {}),
      ...(config.model !== undefined || selection?.model !== undefined
        ? { model: config.model ?? selection.model }
        : {}),
      ...(selection?.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  }

  /** Switch a session's model selection, accepting `provider/model` or a bare model id. */
  const setSessionModel = async (record, requested) => {
    const selection = record.selectionRef.current
    if (selection === undefined) throw internalError('model selection is not available for this session')
    let provider = selection.provider
    let model = requested
    if (typeof requested === 'string' && requested.includes('/')) {
      const slash = requested.indexOf('/')
      provider = requested.slice(0, slash)
      model = requested.slice(slash + 1)
    } else if (llm !== undefined) {
      // Resolve a bare model id against the current provider's catalog.
      const found = (await llm.listModels(selection.provider).catch(() => [])).find((m) => m.id === requested)
      if (found !== undefined) model = found.id
    }
    selection.provider = provider
    selection.model = model
    selection.reasoningEffort = undefined
  }

  /** The write-permission option values: the three presets, else the three sandbox modes. */
  const permissionNames = () => {
    if (permissionPresets !== undefined) return [...permissionPresets.names]
    if (sandboxPolicy !== undefined) return [...SANDBOX_MODES]
    return []
  }

  /** The current write-permission selection for a record. */
  const currentPermission = (record) => {
    const events = record.agent.session.events ?? []
    if (permissionPresets !== undefined) {
      try {
        return permissionPresets.current(events)
      } catch {
        return undefined
      }
    }
    if (sandboxPolicy !== undefined) return effectiveSandboxMode(events) ?? sandboxPolicy.defaultMode
    return undefined
  }

  /** Switch a record's write permission (preset or raw sandbox mode). */
  const setPermission = (record, value) => {
    if (permissionPresets !== undefined) {
      permissionPresets.set(record.agent.session, value)
    } else if (sandboxPolicy !== undefined) {
      setSandboxMode(record.agent.session, value)
    }
  }

  /**
   * Build the ACP session configuration: write-permission config option plus
   * the native model and reasoning-effort pickers.
   */
  const buildSessionConfiguration = async (record) => {
    const selection = record.selectionRef.current

    // Models.
    let models = null
    if (llm !== undefined && selection?.provider && selection?.model) {
      const availableModels = []
      for (const p of llm.listProviders()) {
        try {
          const list = await llm.listModels(p.id)
          for (const m of list) {
            availableModels.push({
              modelId: `${p.id}/${m.id}`,
              name: `${p.name} / ${m.name}`,
              description: m.description ?? null,
            })
          }
        } catch {
          // a provider with no discoverable models is skipped
        }
      }
      models = {
        availableModels,
        currentModelId: `${selection.provider}/${selection.model}`,
      }
    }

    // Reasoning-effort (thinking) levels.
    let efforts = []
    let defaultEffort
    if (llm !== undefined && selection?.provider && selection?.model) {
      try {
        const info = await llm.resolveModelInfo(selection.provider, selection.model)
        efforts = info?.reasoning?.efforts ?? []
        defaultEffort = info?.reasoning?.defaultEffort
      } catch {
        // a model without reasoning metadata contributes no thinking picker
      }
    }

    // NOTE: Zed ignores `models`/`modes` when `configOptions` is present
    // (its ACP client uses config options exclusively). Every selector must
    // therefore be a config option with the right category. Left-to-right
    // order: write permission, model, thinking.
    const configOptions = []

    const permissionNamesList = permissionNames()
    if (permissionNamesList.length > 0) {
      const current = currentPermission(record)
      configOptions.push({
        type: 'select',
        id: 'permission',
        category: 'permission',
        name: 'Write permission',
        description: 'Sandbox and approval policy for file and shell writes',
        currentValue: current,
        options: permissionNamesList.map((name) => ({
          value: name,
          name: permissionLabel(name),
          description: null,
        })),
      })
    }

    if (models !== null && models.availableModels.length > 0) {
      configOptions.push({
        type: 'select',
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Provider/model for this session',
        currentValue: models.currentModelId,
        options: models.availableModels.map((m) => ({
          value: m.modelId,
          name: m.name,
          description: m.description ?? null,
        })),
      })
    }

    if (efforts.length > 0) {
      configOptions.push({
        type: 'select',
        id: 'thought_level',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Reasoning effort for this session',
        currentValue: selection.reasoningEffort ?? defaultEffort,
        options: efforts.map((e) => ({
          value: e.id,
          name: e.name,
          description: e.description ?? null,
        })),
      })
    }

    // Native models/modes fields stay for non-Zed ACP clients; Zed ignores them.
    const modes =
      efforts.length > 0
        ? {
            availableModes: efforts.map((e) => ({ id: e.id, name: e.name, description: e.description ?? null })),
            currentModeId: selection.reasoningEffort ?? defaultEffort,
          }
        : null

    return { configOptions, models, modes }
  }

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent) => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = () => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId) => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send a protocol update without letting a disconnected client fail an agent turn. */
  const notify = (notification) => {
    emitChain = emitChain
      .then(() => conn.sessionUpdate(notification))
      .catch((error) => {
        logger.warn(`acp: session/update failed: ${String(error)}`)
      })
  }

  const settlePrompt = (record, reason) => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const rejectFromError = (inflight, reason) => {
    inflight.reject(internalError(`turn failed: ${reason.error.message}`))
  }

  /** Dispose one bridge-owned session: cancel its agent, settle its prompt, and drop the record. */
  const closeRecord = async (record) => {
    record.agent.cancel({ kind: 'user' })
    settlePrompt(record, 'cancelled')
    await record.dispose().catch(() => {})
  }

  /** Replay a persisted session's transcript onto the wire for a client that just loaded it. */
  const replaySession = (record) => {
    const sessionId = record.agent.session.id
    const events = record.agent.session.events ?? []
    for (const event of events) {
      switch (event.type) {
        case 'user/message': {
          if (event.data?.source?.kind !== 'user') break
          const text = (event.data.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
          if (text) {
            notify({
              sessionId,
              update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
            })
          }
          break
        }
        case 'assistant/message': {
          const text = (event.data.message.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
          if (text) {
            notify({
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            })
          }
          break
        }
        case 'tool/call': {
          const { callId, name, arguments: rawArgs } = event.data
          const args = parseToolArguments(rawArgs)
          notify({
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: callId,
              title: toolTitle(name, args),
              kind: toToolKind(name),
              status: 'completed',
              locations: toToolCallLocations(args, record.cwd),
              rawInput: args,
            },
          })
          break
        }
        case 'tool/result': {
          const block = event.data.message?.content?.[0]
          const callId = block?.toolCallId
          if (callId === undefined) break
          const isError = event.data.error !== undefined || block.isError === true
          const text = toolResultToText(event.data.message)
          notify({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: callId,
              status: isError ? 'failed' : 'completed',
              content: text ? [{ type: 'content', content: { type: 'text', text } }] : undefined,
            },
          })
          break
        }
      }
    }
  }

  // Emit the rich editor surface: raw text/reasoning deltas as streaming
  // chunks, tool activity as tool cards, and structured diffs for file
  // mutations. Committed assistant text is intentionally NOT re-emitted — the
  // streaming deltas already cover it, matching pi-acp's editor experience.
  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    const sessionId = record.agent.session.id

    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta' && chunk.text.length > 0) {
          record.streamedSteps.add(`${event.data.turn}:${event.data.step}`)
          notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk.text },
            },
          })
        } else if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
          notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: chunk.text },
            },
          })
        }
        break
      }

      case 'assistant/message': {
        // Fallback for adapters/replay that commit text without streaming
        // deltas: emit the committed text once for a step that never streamed.
        const key = `${event.data.turn}:${event.data.step}`
        if (record.streamedSteps.has(key)) break
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text.length > 0) {
            notify({
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: block.text },
              },
            })
          }
        }
        break
      }

      case 'tool/call': {
        const { callId, name, arguments: rawArgs } = event.data
        const args = parseToolArguments(rawArgs)
        const kind = toToolKind(name)
        const path = getToolPath(args)

        // Snapshot the target file before a mutation runs so we can emit a
        // structured diff on completion, and infer an edit line while we hold
        // the pre-edit text.
        let line
        if (MUTATING_TOOLS.has(name) && path) {
          try {
            const abs = isAbsolute(path) ? path : resolve(record.cwd, path)
            const oldText = readFileSync(abs, 'utf8')
            fileSnapshots.set(callId, { path, oldText })
            line = findUniqueLineNumber(oldText, getEditNeedle(name, args))
          } catch {
            fileSnapshots.set(callId, { path, oldText: null })
          }
        }

        const resolvedPath = path ? (isAbsolute(path) ? path : resolve(record.cwd, path)) : undefined
        const locations =
          resolvedPath !== undefined
            ? [{ path: resolvedPath, ...(line !== undefined ? { line } : {}) }]
            : undefined

        notify({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: toolTitle(name, args),
            kind,
            status: 'in_progress',
            locations,
            rawInput: args,
          },
        })
        break
      }

      case 'tool/result': {
        const block = event.data.message?.content?.[0]
        const callId = block?.toolCallId
        if (callId === undefined) break
        const isError = event.data.error !== undefined || block.isError === true
        const status = isError ? 'failed' : 'completed'

        let content
        // 1) Native hunk diffs (write/edit carry them in meta.diffs).
        const metaDiffs = Array.isArray(event.data.meta?.diffs) ? event.data.meta.diffs : []
        if (metaDiffs.length > 0) {
          content = metaDiffs.map((d) => ({
            type: 'diff',
            path: d.path,
            oldText: d.oldText,
            newText: d.newText,
          }))
        } else {
          // 2) Manual before/after diff (str_replace_editor has no meta).
          const snapshot = fileSnapshots.get(callId)
          if (snapshot !== undefined) {
            try {
              const abs = isAbsolute(snapshot.path) ? snapshot.path : resolve(record.cwd, snapshot.path)
              const newText = readFileSync(abs, 'utf8')
              if (snapshot.oldText === null || newText !== snapshot.oldText) {
                content = [
                  { type: 'diff', path: snapshot.path, oldText: snapshot.oldText, newText },
                ]
              }
            } catch {
              // ignore; fall back to result text below
            }
          }
        }

        // 3) Fallback: the tool's rendered text result.
        if (content === undefined) {
          const text = toolResultToText(event.data.message)
          if (text) content = [{ type: 'content', content: { type: 'text', text } }]
        }

        notify({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status,
            content,
          },
        })
        fileSnapshots.delete(callId)
        break
      }

      case 'turn/end': {
        const inflight = record.inflight
        if (inflight !== undefined && inflight.turn === event.data.turn) {
          if (event.data.reason.kind === 'error') {
            // Model failures surface immediately as prompt errors; ordinary
            // endings wait for whole-agent idle below.
            record.inflight = undefined
            rejectFromError(inflight, event.data.reason)
          } else {
            inflight.endReason = event.data.reason
          }
        }
        break
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  // Permission requests are a machine policy channel for ACP clients. The
  // bridge offers one-shot choices only and never infers a durable grant from
  // an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn
      .requestPermission({
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: request.callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      })
      .then(({ outcome }) => {
        if (outcome.outcome === 'cancelled') return 'cancelled'
        return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
      })
  })

  const makeAgent = (connection) => {
    conn = connection
    return {
      initialize(_params) {
        // Single-version agent: the spec's "same version if supported, else
        // the latest supported" both resolve to this server's one version.
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dsh-acp', version: '0.1.0' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: {
              // UNSTABLE capability used by Zed to enable a native session picker.
              list: {},
              delete: {},
            },
          },
          authMethods: [],
        })
      },

      authenticate(_params) {
        return Promise.resolve()
      },

      async newSession(params) {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(randomUUID())
        // The mutable model selection is coupled to the agent scope so the
        // client can switch provider/model/reasoning effort at runtime. When
        // agent presets are composed, the agent also joins its preset's
        // standing composition here (the one supported mount call site).
        const selection = resolveAgentOptions()
        const selectionRef = { current: selection, assembled: undefined }
        const defaultPresetId = config.preset ?? 'standard'
        let presetId = defaultPresetId
        const agentOptions = {
          ...(selection.provider !== undefined ? { provider: selection.provider } : {}),
          ...(selection.model !== undefined ? { model: selection.model } : {}),
        }
        const handle = await agents.create({
          sessionId,
          meta: {
            cwd: params.cwd,
            ...(agentPresets !== undefined ? { agentPreset: defaultPresetId } : {}),
          },
          agentOptions,
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, selectionRef)
            if (agentPresets !== undefined) {
              const preset = await agentPresets.mount(agentCtx, presetId)
              presetId = preset.id
            }
          },
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const record = {
          agent: handle.agent,
          cwd: params.cwd,
          dispose: () => handle.dispose(),
          inflight: undefined,
          /** Steps (`turn:step`) whose text was already streamed as deltas. */
          streamedSteps: new Set(),
          selectionRef,
          presetId,
        }
        sessions.set(sessionId, record)
        const { configOptions, models, modes } = await buildSessionConfiguration(record)
        return { sessionId, configOptions, models, modes }
      },

      async prompt(params) {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text and resource_link prompt content is supported')
        }
        const text = acpPromptToText(params.prompt)
        if (text.trim().length === 0) throw invalidParams('empty prompt')

        // Not driving a retired agent is this bridge's contract: validate the
        // record against the live registry before sending — a disposed machine
        // would accept the item silently.
        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        const stopReason = await new Promise((resolve, reject) => {
          // Arm the slot before followup() so a listener-driven synchronous
          // turn cannot slip past correlation; a synchronous followup()
          // failure must free the slot again or the session would reject every
          // later prompt as already in flight.
          const inflight = {
            resolve,
            reject,
            messageId: message.id,
            turn: undefined,
            endReason: undefined,
          }
          record.inflight = inflight
          try {
            record.agent.followup(message)
          } catch (error) {
            record.inflight = undefined
            const detail = error instanceof Error ? error.message : String(error)
            throw internalError(`prompt was not queued: ${detail}`)
          }
          // Settlement waits for whole-agent idle: a correlated turn/end arms
          // `endReason`, while a turnless slot (admission discarded the
          // prompt) stays cancelled. Other producers may run further turns
          // before quiescence; the prompt settles only when the agent stops.
          void record.agent.whenIdle().then(() => {
            if (record.inflight !== inflight) return
            record.inflight = undefined
            const end = inflight.endReason
            if (end === undefined) {
              inflight.resolve('cancelled')
            } else {
              // Token-limit and other non-terminal endings are not prompt-level
              // stop reasons; only normal quiescence reports end_turn.
              inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
            }
          })
        })
        return { stopReason }
      },

      cancel(params) {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        return Promise.resolve()
      },

      async setSessionMode(params) {
        const record = requireSession(SessionId(params.sessionId))
        const selection = record.selectionRef?.current
        if (selection === undefined) throw internalError('model selection is not available for this session')
        selection.reasoningEffort = String(params.modeId)

        // Let the client keep its mode dropdown in sync.
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: params.modeId,
          },
        })
        await emitChain

        const { configOptions } = await buildSessionConfiguration(record)
        return { configOptions }
      },

      async setSessionConfigOption(params) {
        const record = requireSession(SessionId(params.sessionId))
        const configId = String(params.configId)
        const value = typeof params.value === 'string' ? params.value : undefined

        if (configId === 'model') {
          if (value === undefined) throw invalidParams('model requires a string value')
          await setSessionModel(record, value)
        } else if (configId === 'thought_level') {
          if (value === undefined) throw invalidParams('thought_level requires a string value')
          const selection = record.selectionRef?.current
          if (selection === undefined) throw internalError('model selection is not available for this session')
          selection.reasoningEffort = value
        } else if (configId === 'permission') {
          if (value === undefined) throw invalidParams('permission requires a string value')
          if (permissionPresets === undefined && sandboxPolicy === undefined) {
            throw internalError('permission is not available')
          }
          setPermission(record, value)
        } else {
          throw invalidParams(`unknown config option: ${configId}`)
        }

        const { configOptions } = await buildSessionConfiguration(record)
        return { configOptions }
      },

      async listSessions(params) {
        assertOpen()
        if (sessionPersistence === undefined) throw internalError('session persistence is not available')
        const headers = await sessionPersistence.list()
        let all = headers.map((h) => ({
          sessionId: h.id,
          cwd: h.cwd,
          title: undefined,
          updatedAt: new Date(h.createdAt).toISOString(),
        }))
        // Newest-first, using createdAt as the best cheap timestamp.
        all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        if (params.cwd) all = all.filter((s) => s.cwd === params.cwd)

        const PAGE_SIZE = 50
        const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
        const start = Number.isFinite(offset) && offset > 0 ? offset : 0
        const page = all.slice(start, start + PAGE_SIZE)
        return {
          sessions: page,
          nextCursor: start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null,
          _meta: {},
        }
      },

      async loadSession(params) {
        assertOpen()
        if (sessionPersistence === undefined) throw internalError('session persistence is not available')
        if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
        const sessionId = SessionId(params.sessionId)

        // Resolve the persisted header first so a bogus id fails cleanly.
        const headers = await sessionPersistence.list()
        const header = headers.find((h) => h.id === sessionId)
        if (header === undefined) throw invalidParams(`unknown session: ${params.sessionId}`)

        // Tear down any existing live session with the same id before resuming.
        const existing = sessions.get(sessionId)
        if (existing !== undefined) {
          await closeRecord(existing)
          sessions.delete(sessionId)
        }

        const selection = resolveAgentOptions()
        const selectionRef = { current: selection, assembled: undefined }
        const agentOptions = {
          ...(selection.provider !== undefined ? { provider: selection.provider } : {}),
          ...(selection.model !== undefined ? { model: selection.model } : {}),
        }
        // Resume under the deployment-preset field (persisted header preset as
        // fallback for a preset-less legacy session), so history matches its tool set.
        let presetId = config.preset ?? header.agentPreset ?? 'standard'
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, selectionRef)
            if (agentPresets !== undefined) {
              const preset = await agentPresets.mount(agentCtx, presetId)
              presetId = preset.id
            }
          },
        })
        const record = {
          agent: handle.agent,
          cwd: params.cwd,
          dispose: () => handle.dispose(),
          inflight: undefined,
          streamedSteps: new Set(),
          selectionRef,
          presetId,
        }
        sessions.set(sessionId, record)

        // Replay the transcript so the client shows history, not an empty view,
        // flushing the replay before answering so it precedes the response.
        replaySession(record)
        await emitChain

        const { configOptions, models, modes } = await buildSessionConfiguration(record)
        return { configOptions, models, modes, _meta: {} }
      },

      async deleteSession(params) {
        assertOpen()
        if (sessionPersistence === undefined) throw internalError('session persistence is not available')
        const sessionId = SessionId(params.sessionId)

        // Dispose a live session with this id, if any.
        const record = sessions.get(sessionId)
        if (record !== undefined) {
          await closeRecord(record)
          sessions.delete(sessionId)
        }

        // Best-effort removal of the persisted artifact (the seam has no delete API).
        try {
          const headers = await sessionPersistence.list()
          const header = headers.find((h) => h.id === sessionId)
          if (header !== undefined) {
            const location = sessionPersistence.locate(header)
            if (location?.path) {
              rmSync(dirname(location.path), { recursive: true, force: true })
            }
          }
        } catch (error) {
          logger.warn(`acp: session/delete cleanup failed for ${params.sessionId}: ${String(error)}`)
        }

        return {}
      },
    }
  }

  const stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing
  const quiesce = () => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    // Stop the bridge's own work before any await: a descendant drain can block
    // on persistence or scoped cleanup, and the top-level agents must not keep
    // running model and tool calls for its whole duration.
    for (const record of records) {
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
    }
    quiescing = (async () => {
      // Continuable subagents outlive the turn that started them, and their
      // Activations own descendant teardown. Drain only these sessions' forests
      // child-first BEFORE disposing the top-level agents, so no descendant is
      // left holding a runtime its owner already released.
      const subagents = ctx.get('subagents')
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map((record) => record.agent))
        } catch (error) {
          logger.warn(`acp: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const disposals = await Promise.allSettled(records.map((record) => record.dispose()))
      const failures = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
      if (failures.length > 0) {
        const detail = failures.map((failure) => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  void conn.closed
    .catch((error) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, 'acp.connection')
}
