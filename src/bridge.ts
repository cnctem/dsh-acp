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
import type { Context } from '@deepseek-ai/cordis'
import { admitEncodedImages, isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent as DshAgent } from '@deepseek-ai/dsh-agent'
import { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Agent as AcpAgent, ClientCapabilities, StopReason, ToolCallContent } from '@agentclientprotocol/sdk'
import {
  MUTATING_TOOLS,
  acpImagesToEncoded,
  acpPromptToText,
  findUniqueLineNumber,
  getEditNeedle,
  getToolPath,
  imageMarker,
  internalError,
  invalidParams,
  isTerminalTool,
  parseToolArguments,
  permissionLabel,
  promptHasUnsupportedContent,
  toPlanEntries,
  toToolCallLocations,
  toToolKind,
  toolResultToText,
  toolTitle,
  turnEndToStopReason,
  validateSessionParams,
} from './protocol.js'
import { createElicitationProvider } from './elicitation.js'
import type { AcpModelSelection, AcpModelSelectionRef, ApplyConfig, BridgeLogger, InflightPrompt, SessionRecord } from './types.js'
import type { TodoItem } from './protocol.js'

const FALLBACK_REASONING_EFFORTS: readonly { id: ReasoningEffortId; name: string; description: string | null }[] = [
  { id: 'off' as ReasoningEffortId, name: 'Off', description: null },
  { id: 'minimal' as ReasoningEffortId, name: 'Minimal', description: null },
  { id: 'low' as ReasoningEffortId, name: 'Low', description: null },
  { id: 'medium' as ReasoningEffortId, name: 'Medium', description: null },
  { id: 'high' as ReasoningEffortId, name: 'High', description: null },
  { id: 'xhigh' as ReasoningEffortId, name: 'Xhigh', description: null },
  { id: 'max' as ReasoningEffortId, name: 'Max', description: null },
]

const PROVIDER_DEFAULT_REASONING_EFFORT = 'provider-default' as ReasoningEffortId

interface ToolDiffPayload {
  path: string
  oldText: string | null
  newText: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isToolDiffPayload(value: unknown): value is ToolDiffPayload {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    (typeof value.oldText === 'string' || value.oldText === null) &&
    typeof value.newText === 'string'
  )
}


/**
 * Mount the automation-only ACP server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context carrying the agent factory and session events.
 * @param {{provider?: string, model?: string}} config - Initial provider/model selection.
 */
export function createAcpBridge(ctx: Context, config: ApplyConfig = {}): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const agents = ctx.agents
  const defaultModel = ctx.agentDefaultModel
  const sessionPersistence = ctx.get('sessionPersistence')
  const llm = ctx.get('llm')
  const commands = ctx.get('commands')
  const permissionPresets = ctx.get('permissionPresets')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const agentPresets = ctx.get('agentPresets')
  // Provider-anchored context-pressure projection (dsh-token-meter) — the
  // source for the client's context-usage ring.
  const sessionProjections = ctx.get('sessionProjections')
  // The `userQuestions` seam that dsh's model-facing ask_user_question tool
  // blocks on; the bridge supplies the human answerer through ACP elicitation.
  const userQuestions = ctx.get('userQuestions')
  const logger: BridgeLogger = ctx.logger ?? {
    debug() {},
    warn() {},
    error() {},
  }
  const sessions = new Map<import('@deepseek-ai/dsh-session').SessionId, SessionRecord>()
  /** Pre-mutation file snapshots keyed by tool callId, for structured diffs. */
  const fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  /** Tool callIds that are terminal tools (bash/pwsh), for terminal content emission. */
  const terminalToolCallIds = new Set<string>()
  /** Serialize session/update delivery so chunks, tool cards, and updates stay ordered. */
  let emitChain: Promise<void> = Promise.resolve()
  let closed = false
  let conn!: AgentSideConnection
  /**
   * The client's initialize capabilities. `elicitation.form` unlocks the
   * ask_user_question bridge; captured at initialize (single connection).
   */
  let clientCapabilities: ClientCapabilities | null = null

  /** Resolve the provider/model for a new agent: pinned config wins, else the default model selection. */
  const resolveAgentOptions = (): AcpModelSelection => {
    const selection = defaultModel.currentSelection()
    return {
      provider: config.provider ?? selection.provider,
      model: config.model ?? selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }

  /** Switch a session's model selection, accepting `provider/model` or a bare model id. */
  const setSessionModel = async (record: SessionRecord, requested: string): Promise<void> => {
    const selection = record.selectionRef.current
    if (selection === undefined) throw internalError('model selection is not available for this session')
    let provider = selection.provider
    let model = requested
    if (requested.includes('/')) {
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

  /**
   * Strip a reasoning effort the current model cannot honor from every agent
   * request. A thinking-level pick from the fallback list can name a level
   * the model does not support, and the harness rejects such efforts on every
   * request (UNSUPPORTED_REASONING_EFFORT); this guard keeps the picker from
   * breaking a session. Registered before `installModelSelection` so it sees
   * the injected effort; `selection.supportedReasoningEfforts` is refreshed by
   * `buildSessionConfiguration` whenever the model selection changes.
   */
  const installReasoningEffortGuard = (agentCtx: Context, selectionRef: AcpModelSelectionRef): void => {
    agentCtx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const supported = selectionRef.current?.supportedReasoningEfforts
      if (supported === undefined) return resolved
      if (resolved?.reasoningEffort !== undefined && !supported.includes(resolved.reasoningEffort)) {
        const { reasoningEffort: _stripped, ...rest } = resolved
        return rest
      }
      return resolved
    })
  }

  /** The write-permission option values: the three presets, else the three sandbox modes. */
  const permissionNames = () => {
    if (permissionPresets !== undefined) return [...permissionPresets.names]
    if (sandboxPolicy !== undefined) return [...SANDBOX_MODES]
    return []
  }

  /** The current write-permission selection for a record. */
  const currentPermission = (record: SessionRecord): string | undefined => {
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
  const setPermission = (record: SessionRecord, value: string): void => {
    if (permissionPresets !== undefined) {
      permissionPresets.set(record.agent.session, value)
    } else if (sandboxPolicy !== undefined) {
      setSandboxMode(record.agent.session, value as Parameters<typeof setSandboxMode>[1])
    }
  }


  const askViaAcp = createElicitationProvider({
    connection: () => conn,
    supportsForm: () => clientCapabilities?.elicitation?.form !== undefined,
    ownedRecord: (agent) => ownedRecord(agent),
  })

  // The agent presets mount dsh-tool-ask-user, whose execute blocks on
  // `ctx.userQuestions`; this provider is the bridge's answerer. Registering
  // it via the seam (not a bare service) keeps the single-provider contract
  // and the DUPLICATE_PROVIDER guard of the web UI.
  if (userQuestions !== undefined) {
    ctx.effect(
      () => userQuestions.registerProvider({ ask: askViaAcp }),
      'acp.user-questions',
    )
  }

  /**
   * Build the ACP session configuration: write-permission config option plus
   * the native model and reasoning-effort pickers.
   */
  const buildSessionConfiguration = async (record: SessionRecord) => {
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

    // Reasoning-effort (thinking) levels. A model without reasoning metadata
    // falls back to the canonical ordered list, so the thinking picker never
    // disappears. The model's OWN levels are remembered on the selection so
    // requests can strip efforts the model cannot honor (a pick from the
    // fallback list must not fail every prompt).
    let efforts: readonly { id: ReasoningEffortId; name: string; description?: string | null }[] = []
    let defaultEffort: ReasoningEffortId | undefined
    if (llm !== undefined && selection?.provider && selection?.model) {
      try {
        const info = await llm.resolveModelInfo(selection.provider, selection.model)
        efforts = info?.reasoning?.efforts ?? []
        defaultEffort = info?.reasoning?.defaultEffort
      } catch {
        // unresolvable reasoning metadata counts as absent: fallback applies
      }
      selection.supportedReasoningEfforts = efforts.map((e) => e.id)
      if (efforts.length === 0) {
        efforts = FALLBACK_REASONING_EFFORTS
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
      // A select's currentValue is required by the ACP schema; when neither
      // the session nor the model names an effort, it falls back to the
      // display-only "Provider default" entry instead of the first declared
      // level — `off` for the canonical list and for models whose metadata
      // leads with it. Falling back to `off` advertises (and, for clients
      // that apply the currentValue, enforces) thinking off for models whose
      // default is actually "whatever the provider decides" — the web UI
      // shows the same situation as a "Provider default" picker entry.
      // Display-only: an effort is only passed to the model when the user
      // actually picks a real level; "provider-default" is stripped by the
      // request guard and no effort reaches the harness.
      const currentValue = selection?.reasoningEffort ?? defaultEffort ?? PROVIDER_DEFAULT_REASONING_EFFORT
      const effortOptions =
        defaultEffort === undefined
          ? [{ id: PROVIDER_DEFAULT_REASONING_EFFORT, name: 'Provider default', description: null }, ...efforts]
          : efforts
      configOptions.push({
        type: 'select',
        id: 'thought_level',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Reasoning effort for this session',
        currentValue,
        options: effortOptions.map((e) => ({
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
            availableModes: (
              defaultEffort === undefined
                ? [{ id: PROVIDER_DEFAULT_REASONING_EFFORT, name: 'Provider default', description: null }, ...efforts]
                : efforts
            ).map((e) => ({ id: e.id, name: e.name, description: e.description ?? null })),
            currentModeId: selection?.reasoningEffort ?? defaultEffort ?? PROVIDER_DEFAULT_REASONING_EFFORT,
          }
        : null

    return { configOptions, models, modes }
  }

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: DshAgent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = () => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: import('@deepseek-ai/dsh-session').SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send a protocol update without letting a disconnected client fail an agent turn. */
  const notify = (notification: Parameters<AgentSideConnection['sessionUpdate']>[0]): void => {
    emitChain = emitChain
      .then(() => conn.sessionUpdate(notification))
      .catch((error) => {
        logger.warn(`acp: session/update failed: ${String(error)}`)
      })
  }

  /**
   * Push an ACP `usage_update` for the session's context occupancy — the feed
   * behind the IDE's context-usage ring (`used` / `size` in tokens).
   *
   * Reads the same provider-anchored context-pressure projection as dsh's own
   * web UI (`projectedTokens` vs `contextWindow`), so compaction and model
   * switches are reflected immediately instead of waiting for the next
   * provider usage report. Emits nothing until both the numerator and the
   * denominator are known — a fresh session before its first request has
   * neither, and the ring lights up as soon as the first turn reports usage.
   */
  const pushUsageUpdate = (record: SessionRecord): void => {
    if (sessionProjections === undefined) return
    let pressure
    try {
      pressure = sessionProjections.snapshot(record.agent.session).values?.contextPressure
    } catch (error) {
      logger.warn(`acp: context pressure read failed: ${String(error)}`)
      return
    }
    const used = pressure?.projectedTokens ?? pressure?.pressureTokens
    const size = pressure?.contextWindow
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return
    notify({
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: 'usage_update',
        used: Math.round(used),
        size: Math.round(size),
      },
    })
  }

  /**
   * Push the session's todo list as an ACP `plan` update — the feed behind
   * the IDE's plan/task checklist. Whole-list replacement, mirroring the web
   * UI's `todos` projection (`todo/write` snapshots are complete lists).
   */
  const pushPlanUpdate = (record: SessionRecord, todos: readonly TodoItem[]): void => {
    record.planKnown = true
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'plan', entries: toPlanEntries(todos) },
    })
  }

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const rejectFromError = (inflight: InflightPrompt, reason: Extract<TurnEndReason, { kind: 'error' }>): void => {
    inflight.reject(internalError(`turn failed: ${reason.error.message}`))
  }

  /** Dispose one bridge-owned session: cancel its agent, settle its prompt, and drop the record. */
  const closeRecord = async (record: SessionRecord): Promise<void> => {
    record.abort?.abort()
    record.agent.cancel({ kind: 'user' })
    settlePrompt(record, 'cancelled')
    await record.dispose().catch(() => {})
  }

  /**
   * Advertise the agent's slash commands so Zed can offer them after `/`.
   * Sent on a macrotask so it lands after the session/new (or load) response —
   * Zed ignores available_commands_update for a session it does not know yet.
   */
  const advertiseCommands = (record: SessionRecord): void => {
    if (commands === undefined) return
    let availableCommands = []
    try {
      availableCommands = commands.list(record.agent).map((c: { name: string; description: string; input?: { hint?: string } }) => ({
        name: c.name,
        description: c.description,
        ...(c.input?.hint !== undefined ? { input: { hint: c.input.hint } } : {}),
      }))
    } catch (error) {
      logger.warn(`acp: listing slash commands failed: ${String(error)}`)
    }
    setTimeout(() => {
      notify({
        sessionId: record.agent.session.id,
        update: { sessionUpdate: 'available_commands_update', availableCommands },
      })
    }, 0)
  }

  /** Replay a persisted session's transcript onto the wire for a client that just loaded it. */
  const replaySession = (record: SessionRecord): void => {
    const sessionId = record.agent.session.id
    const events = record.agent.session.events ?? []
    // Standing-plan fold: latest whole todo/write list, cleared by the next
    // turn/start — the same fold as the web UI's `todos` projection.
    let planEntries: readonly TodoItem[] | null = null
    for (const event of events) {
      switch (event.type) {
        case 'user/message': {
          if (event.data?.source?.kind !== 'user') break
          const text = (event.data.content ?? [])
            .flatMap((b: { type: string; text?: string; attachment?: ImageAttachmentRef }) => {
              if (b.type === 'text') return [b.text]
              if (b.type === 'image') return [imageMarker(b.attachment)]
              return []
            })
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
            .filter((b: { type: string; text?: string }): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
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
        case 'todo/write': {
          planEntries = event.data.todos
          break
        }
        case 'turn/start': {
          planEntries = null
          break
        }
      }
    }
    // Emit the folded plan once, after the transcript replay, so a resumed
    // session shows the same checklist (or none) as the web UI.
    if (planEntries !== null) pushPlanUpdate(record, planEntries)
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
        if (!record.streamedSteps.has(key)) {
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
        }
        // Committed assistant text grows the model-visible surface.
        pushUsageUpdate(record)
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

        const terminal = isTerminalTool(name)
        if (terminal) terminalToolCallIds.add(callId)

        // Correlate the pending ask_user_question call so its elicitation
        // modal can attach to the tool card the client already rendered.
        if (name === 'ask_user_question') record.questionCallIds.push(callId)

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
            ...(terminal
              ? {
                  content: [{ type: 'terminal', terminalId: callId }],
                  _meta: { terminal_info: { terminal_id: callId, cwd: record.cwd } },
                }
              : {}),
          },
        })
        break
      }

      case 'tool/result': {
        const block = event.data.message?.content?.[0]
        const callId = block?.toolCallId
        if (callId === undefined) break
        const isError = event.data.error !== undefined || block.isError === true

        // A tool that errored before asking (or was aborted) leaves its
        // callId queued; drop it so the next question correlates cleanly.
        const queued = record.questionCallIds.indexOf(callId)
        if (queued >= 0) record.questionCallIds.splice(queued, 1)

        // Terminal tools (bash/pwsh): present output + exit status as terminal content.
        if (terminalToolCallIds.has(callId)) {
          terminalToolCallIds.delete(callId)
          const meta = event.data.meta
          let output = toolResultToText(event.data.message)
          let exitCode = isError ? 1 : 0
          let signal = null
          if (isRecord(meta) && meta.card === 'terminal') {
            if (typeof meta.output === 'string') output = meta.output
            exitCode = typeof meta.exitCode === 'number' ? meta.exitCode : (isError ? 1 : 0)
            signal = typeof meta.signal === 'string' ? meta.signal : null
          }
          notify({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: callId,
              status: isError ? 'failed' : 'completed',
              _meta: {
                terminal_output: { terminal_id: callId, data: output },
                terminal_exit: { terminal_id: callId, exit_code: exitCode, signal },
              },
            },
          })
          pushUsageUpdate(record)
          break
        }

        const status = isError ? 'failed' : 'completed'

        let content: ToolCallContent[] | undefined
        // 1) Native hunk diffs (write/edit carry them in meta.diffs).
        const rawMetaDiffs: readonly unknown[] =
          isRecord(event.data.meta) && Array.isArray(event.data.meta.diffs) ? event.data.meta.diffs : []
        const metaDiffs = rawMetaDiffs.filter(isToolDiffPayload)
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
        // Tool results land in the next request's prompt surface.
        pushUsageUpdate(record)
        break
      }

      case 'todo/write': {
        // The dsh todo list (todo_write tool) as the IDE's plan checklist:
        // whole-list replacement, matching the web UI's `todos` projection.
        pushPlanUpdate(record, event.data.todos)
        break
      }

      case 'turn/start': {
        // The web UI hides the finished checklist when a new turn begins;
        // mirror that by replacing the plan with an empty list (the stable
        // ACP way to clear a plan). Only once a plan was actually shown, so
        // sessions that never write todos stay silent.
        if (record.planKnown) {
          notify({ sessionId, update: { sessionUpdate: 'plan', entries: [] } })
        }
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
        // A finished turn is the cheapest stable point to refresh the ring.
        pushUsageUpdate(record)
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

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      initialize(params: Parameters<AcpAgent['initialize']>[0]) {
        // Single-version agent: the spec's "same version if supported, else
        // the latest supported" both resolve to this server's one version.
        clientCapabilities = params.clientCapabilities ?? null
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dsh-acp', version: '0.1.1' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: false },
            sessionCapabilities: {
              // UNSTABLE capability used by Zed to enable a native session picker.
              list: {},
              delete: {},
            },
          },
          authMethods: [],
        })
      },

      authenticate(_params: Parameters<AcpAgent['authenticate']>[0]) {
        return Promise.resolve()
      },

      async newSession(params: Parameters<AcpAgent['newSession']>[0]) {
        assertOpen()
        validateSessionParams(params, logger)
        const sessionId = SessionId(randomUUID())
        // The mutable model selection is coupled to the agent scope so the
        // client can switch provider/model/reasoning effort at runtime. When
        // agent presets are composed, the agent also joins its preset's
        // standing composition here (the one supported mount call site).
        const selection = resolveAgentOptions()
        const selectionRef: AcpModelSelectionRef = { current: selection, assembled: undefined }
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
            installReasoningEffortGuard(agentCtx, selectionRef)
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
        const record: SessionRecord = {
          agent: handle.agent,
          cwd: params.cwd,
          dispose: () => handle.dispose(),
          inflight: undefined,
          /** Aborts a command dispatch in flight (slash-command prompt). */
          abort: undefined,
          /** Steps (`turn:step`) whose text was already streamed as deltas. */
          streamedSteps: new Set<string>(),
          /** Pending ask_user_question tool callIds (FIFO), for elicitation correlation. */
          questionCallIds: [],
          /** Whether a `plan` update was ever sent, so turn/start only clears a shown checklist. */
          planKnown: false,
          selectionRef,
          presetId,
        }
        sessions.set(sessionId, record)
        const { configOptions, models, modes } = await buildSessionConfiguration(record)
        // A fresh session has no pressure yet; this lights up once the
        // projection records the first provider usage report.
        pushUsageUpdate(record)
        advertiseCommands(record)
        return { sessionId, configOptions, models, modes }
      },

      async prompt(params: Parameters<AcpAgent['prompt']>[0]) {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text, resource_link and image prompt content is supported')
        }
        const text = acpPromptToText(params.prompt)
        // ACP image blocks in wire-admission form (`EncodedImageAttachment`),
        // in submission order. Commands admit them themselves (their own
        // store + limits check); the model path admits them once, here, before
        // the message is created so the durable references are the only
        // model-visible form of the upload.
        const encodedImages = acpImagesToEncoded(params.prompt)
        if (text.trim().length === 0 && encodedImages.length === 0) {
          throw invalidParams('empty prompt')
        }

        // Not driving a retired agent is this bridge's contract: validate the
        // record against the live registry before sending — a disposed machine
        // would accept the item silently.
        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }

        // Slash commands dispatch in the command plane, not as model input. The
        // bridge advertises them (`available_commands_update`), so `/plan` must
        // actually run here — otherwise it reaches the model as literal text,
        // plan mode never activates, and a later `exit_plan_mode` fails with
        // "only available in plan mode". A recognized command runs against the
        // agent and its result text surfaces as a message chunk without entering
        // model history; any follow-up work the handler steers (e.g.
        // `/plan <message>`) drains through the ordinary idle driver before the
        // prompt settles. Unknown slash input is not a command and falls through
        // to the model, matching the bridge's no-adapter contract. Recognized
        // commands own image admission: base64 uploads ride along in the
        // `images` argument, and the command's own store/limits check runs
        // before its handler (a command without image input settles with an
        // error text instead of dropping the uploads).
        if (commands !== undefined && typeof commands.execute === 'function') {
          const abort = new AbortController()
          record.abort = abort
          try {
            let execution
            try {
              execution = await commands.execute(record.agent, text, encodedImages, abort.signal)
            } catch (error) {
              notify({
                sessionId: record.agent.session.id,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `command failed: ${errorChain(error)}` },
                },
              })
              await emitChain
              return { stopReason: 'end_turn' }
            }
            if (execution !== undefined) {
              if (execution.result.text !== undefined && execution.result.text !== '') {
                notify({
                  sessionId: record.agent.session.id,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: execution.result.text },
                  },
                })
              }
              // Bare commands leave the agent idle and this resolves at once; a
              // handler that steer()ed work (e.g. `/plan <message>`) runs that
              // turn to quiescence here.
              await record.agent.whenIdle()
              // Flush the surfaced result before the response, matching the
              // set_mode/set_config_option surface-then-respond ordering.
              await emitChain
              return { stopReason: 'end_turn' }
            }
          } finally {
            if (record.abort === abort) record.abort = undefined
          }
        }

        // The model path admits image uploads through the durable attachment
        // seam once, before the message is created: `admitEncodedImages` runs
        // the deployment's batch policy (count, aggregate bytes, media type,
        // per-image validation) and returns durable references in submission
        // order. A refused batch is a caller-correctable input error and
        // publishes no durable object; storage failures stay internal.
        let imageRefs: readonly ImageAttachmentRef[] = []
        if (encodedImages.length > 0) {
          const attachments = ctx.get('attachments')
          if (attachments === undefined) {
            throw invalidParams('image attachments are unavailable: no attachment store is composed')
          }
          try {
            imageRefs = await admitEncodedImages(attachments, encodedImages)
          } catch (error) {
            if (isImageAdmissionError(error)) throw invalidParams(error.message)
            throw internalError(`image admission failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        // Build the user message preserving the prompt's block order: text
        // blocks and resource_link hints stay text, each image block becomes
        // the durable `ImageBlock` its reference describes.
        let nextImage = 0
        const content: Parameters<typeof createUserMessage>[0]['content'] = []
        for (const block of params.prompt) {
          switch (block.type) {
            case 'text':
              content.push({ type: 'text', text: block.text })
              break
            case 'resource_link':
              content.push({
                type: 'text',
                text: `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`,
              })
              break
            case 'image':
              content.push({ type: 'image', attachment: imageRefs[nextImage++] })
              break
            default:
              break
          }
        }
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        const stopReason = await new Promise<StopReason>((resolve, reject) => {
          // Arm the slot before followup() so a listener-driven synchronous
          // turn cannot slip past correlation; a synchronous followup()
          // failure must free the slot again or the session would reject every
          // later prompt as already in flight.
          const inflight: InflightPrompt = {
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

      cancel(params: Parameters<AcpAgent['cancel']>[0]) {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        record.abort?.abort()
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        return Promise.resolve()
      },

      async setSessionMode(params: Parameters<NonNullable<AcpAgent['setSessionMode']>>[0]) {
        const record = requireSession(SessionId(params.sessionId))
        const selection = record.selectionRef?.current
        if (selection === undefined) throw internalError('model selection is not available for this session')
        selection.reasoningEffort = String(params.modeId) as ReasoningEffortId

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

      async setSessionConfigOption(params: Parameters<NonNullable<AcpAgent['setSessionConfigOption']>>[0]) {
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
          selection.reasoningEffort = value as ReasoningEffortId
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
        // A model switch can change the context window (denominator).
        if (configId === 'model') pushUsageUpdate(record)
        return { configOptions }
      },

      async listSessions(params: Parameters<NonNullable<AcpAgent['listSessions']>>[0]) {
        assertOpen()
        if (sessionPersistence === undefined) throw internalError('session persistence is not available')
        const headers = await sessionPersistence.list()
        let all = headers.map((h: { id: import('@deepseek-ai/dsh-session').SessionId; cwd: string; createdAt: number }) => ({
          sessionId: h.id,
          cwd: h.cwd,
          title: undefined,
          updatedAt: new Date(h.createdAt).toISOString(),
        }))
        // Newest-first, using createdAt as the best cheap timestamp.
        all.sort((a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        if (params.cwd) all = all.filter((session: { cwd: string }) => session.cwd === params.cwd)

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

      async loadSession(params: Parameters<NonNullable<AcpAgent['loadSession']>>[0]) {
        assertOpen()
        if (sessionPersistence === undefined) throw internalError('session persistence is not available')
        if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
        const sessionId = SessionId(params.sessionId)

        // Resolve the persisted header first so a bogus id fails cleanly.
        const headers = await sessionPersistence.list()
        const header = headers.find((h: { id: import('@deepseek-ai/dsh-session').SessionId; agentPreset?: string }) => h.id === sessionId)
        if (header === undefined) throw invalidParams(`unknown session: ${params.sessionId}`)

        // Tear down any existing live session with the same id before resuming.
        const existing = sessions.get(sessionId)
        if (existing !== undefined) {
          await closeRecord(existing)
          sessions.delete(sessionId)
        }

        const selection = resolveAgentOptions()
        const selectionRef: AcpModelSelectionRef = { current: selection, assembled: undefined }
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
            installReasoningEffortGuard(agentCtx, selectionRef)
            installModelSelection(agentCtx, selectionRef)
            if (agentPresets !== undefined) {
              const preset = await agentPresets.mount(agentCtx, presetId)
              presetId = preset.id
            }
          },
        })
        const record: SessionRecord = {
          agent: handle.agent,
          cwd: params.cwd,
          dispose: () => handle.dispose(),
          inflight: undefined,
          /** Aborts a command dispatch in flight (slash-command prompt). */
          abort: undefined,
          streamedSteps: new Set<string>(),
          questionCallIds: [],
          /** Whether a `plan` update was ever sent, so turn/start only clears a shown checklist. */
          planKnown: false,
          selectionRef,
          presetId,
        }
        sessions.set(sessionId, record)

        // Replay the transcript so the client shows history, not an empty view,
        // flushing the replay before answering so it precedes the response.
        replaySession(record)
        // Seed the context ring from the persisted projection (if any).
        pushUsageUpdate(record)
        await emitChain

        const { configOptions, models, modes } = await buildSessionConfiguration(record)
        advertiseCommands(record)
        return { configOptions, models, modes, _meta: {} }
      },

      async deleteSession(params: Parameters<NonNullable<AcpAgent['deleteSession']>>[0]) {
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
          const header = headers.find((h: { id: import('@deepseek-ai/dsh-session').SessionId }) => h.id === sessionId)
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
    } as unknown as AcpAgent
  }

  const stream =
    config.stream ??
    ndJsonStream(
      Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing: Promise<void> | undefined
  const quiesce = () => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    // Stop the bridge's own work before any await: a descendant drain can block
    // on persistence or scoped cleanup, and the top-level agents must not keep
    // running model and tool calls for its whole duration.
    for (const record of records) {
      record.abort?.abort()
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
