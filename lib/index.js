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
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
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
  const logger = ctx.logger ?? {
    warn() {},
    error() {},
  }
  const sessions = new Map()
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
    }
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
    void conn.sessionUpdate(notification).catch((error) => {
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

  // Emit only committed assistant text. Raw chunks, reasoning, tools, plans,
  // titles, and retry markers are presentation or trace data and stay off the
  // automation wire.
  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      if (event.type === 'assistant/message') {
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text.length > 0) {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: block.text },
              },
            })
          } else if (block.type === 'image') {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `[image attachment ${block.attachment.attachmentId}]`,
                },
              },
            })
          }
        }
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          // Model failures surface immediately as prompt errors; ordinary
          // endings wait for whole-agent idle below.
          record.inflight = undefined
          rejectFromError(inflight, event.data.reason)
        } else {
          inflight.endReason = event.data.reason
        }
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
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
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
        // No preset composition: the ACP bundle keeps the model-facing rows in
        // the host plane, so this agent reads them from the global layer.
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: resolveAgentOptions(),
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        sessions.set(sessionId, {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          inflight: undefined,
        })
        return { sessionId }
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
