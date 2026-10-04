/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */
import { RequestError, } from '@agentclientprotocol/sdk';
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import {} from '@deepseek-ai/dsh-session';
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { AcpContentError, acpPromptToCommandAttachments, acpPromptToText, admitAcpPrompt, } from './content.js';
import { turnEndToStopReason } from './codec.js';
import { mountAcpMcpServers } from './mcp.js';
import { AcpModelControl } from './model-control.js';
import { assistantUpdates, findUniqueLineNumber, getEditNeedle, planUpdate, snapshotToolFile, toolCallUpdate, toolResultUpdate, } from './updates.js';
/** Standard invalid-parameter failure with protocol-safe detail. */
function invalidParams(detail) {
    return RequestError.invalidParams(undefined, detail);
}
/** Standard internal failure with protocol-safe detail. */
function internalError(detail) {
    return RequestError.internalError(undefined, detail);
}
/** Restore the latest logged route before falling back to deployment config. */
function selectionFor(logged, fallback) {
    return logged === undefined
        ? fallback
        : {
            provider: logged.config.provider,
            model: logged.config.model,
            ...logged.config.reasoningEffort === undefined || logged.adapterDefaults?.reasoningEffort === true
                ? {}
                : { reasoningEffort: logged.config.reasoningEffort },
        };
}
/**
 * Per-session ACP module. It owns the unpublished Agent composition, selected
 * route, one-prompt admission slot, ordered standard updates, and memoized
 * quiescent teardown.
 */
export class AcpSession {
    ctx;
    cwd;
    notify;
    /** The exact top-level Agent owned by this ACP session. */
    agent;
    modelControl;
    outputTail = Promise.resolve();
    inflight;
    closing;
    pendingSelections = new Map();
    fileSnapshots = new Map();
    streamedSteps = new Set();
    attempts = new Map();
    commandAbort;
    planKnown = false;
    constructor(ctx, handle, modelControl, cwd, notify) {
        this.ctx = ctx;
        this.cwd = cwd;
        this.notify = notify;
        this.agent = handle.agent;
        this.modelControl = modelControl;
        this.disposeAgent = () => handle.dispose();
    }
    disposeAgent;
    /**
     * Compose a fresh Agent and all requested MCP clients before publication.
     * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
     * @param options - fresh session identity, workspace, route, MCP, and notifier.
     * @returns the fully composed per-session module.
     */
    static async create(ctx, options) {
        const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);
        const presets = ctx.get('agentPresets');
        const presetId = options.presetId ?? presets?.defaultId;
        if (options.presetId !== undefined && presets === undefined) {
            throw invalidParams(`agent preset "${options.presetId}" is configured but no preset registry is mounted`);
        }
        const handle = await ctx.agents.create({
            sessionId: options.sessionId,
            meta: { cwd: options.cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
            agentOptions: options.agentOptions,
            signal: options.signal,
            setup: async (agentCtx) => {
                modelControl.install(agentCtx);
                if (presets !== undefined)
                    await presets.mount(agentCtx, presetId);
                await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
            },
        });
        return new AcpSession(ctx, handle, modelControl, options.cwd, options.notify);
    }
    /**
     * Restore a persisted Agent and compose the request's fresh MCP connections.
     * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
     * @param options - persisted identity, workspace, fallback route, MCP, and notifier.
     * @returns the restored per-session module.
     */
    static async resume(ctx, options) {
        let modelControl;
        const presets = ctx.get('agentPresets');
        const presetId = options.presetId ?? presets?.defaultId;
        const handle = await ctx.agents.resume({
            resumeSessionId: options.sessionId,
            agentOptions: options.agentOptions,
            signal: options.signal,
            setup: async (agentCtx, agent) => {
                modelControl = new AcpModelControl(ctx.llm, selectionFor(agent.session.requestHeader(), options.fallbackSelection));
                modelControl.install(agentCtx);
                if (presets !== undefined)
                    await presets.mount(agentCtx, presetId);
                await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
            },
        });
        /* v8 ignore start -- a fulfilled Agent resume necessarily ran setup to completion. */
        if (modelControl === undefined) {
            await handle.dispose();
            throw internalError('session/resume did not compose model selection');
        }
        /* v8 ignore stop */
        return new AcpSession(ctx, handle, modelControl, options.cwd, options.notify);
    }
    /**
     * Whether this module owns an exact Agent reference.
     * @param agent - Agent observed on a scoped runtime event.
     * @returns true only for this session's owned Agent.
     */
    owns(agent) {
        return this.agent === agent;
    }
    /**
     * Whether this module owns an exact Session reference.
     * @param session - Session observed on a durable event.
     * @returns true only for this session's owned Session.
     */
    ownsSession(session) {
        return this.agent.session === session;
    }
    /**
     * Return the complete standard model configuration state.
     * @param signal - optional request cancellation.
     * @returns provider-grouped model and exact-model reasoning options.
     */
    configOptions(signal) {
        this.assertActive();
        return this.allConfigOptions(signal);
    }
    /**
     * Apply one standard configuration option to later ACP turns.
     * @param configId - advertised standard option id.
     * @param value - selected standard option value.
     * @param signal - optional request cancellation.
     * @returns the complete resulting option state.
     */
    async setConfig(configId, value, signal) {
        this.assertActive();
        if (configId !== 'permission')
            return this.modelControl.set(configId, value, signal);
        if (typeof value !== 'string')
            throw invalidParams('permission requires a select value');
        const permissions = this.ctx.get('permissionPresets');
        const sandbox = this.ctx.get('sandboxPolicy');
        if (permissions === undefined && sandbox === undefined)
            throw invalidParams('permission is not available');
        const allowed = permissions?.names ?? SANDBOX_MODES;
        if (!allowed.includes(value))
            throw invalidParams(`unknown permission option: ${value}`);
        if (permissions !== undefined)
            permissions.set(this.agent.session, value);
        else {
            setSandboxMode(this.agent.session, value);
        }
        return this.allConfigOptions(signal);
    }
    async allConfigOptions(signal) {
        const modelOptions = await this.modelControl.options(signal);
        const permission = this.permissionOption();
        return permission === undefined ? modelOptions : [permission, ...modelOptions];
    }
    permissionOption() {
        const permissions = this.ctx.get('permissionPresets');
        const sandbox = this.ctx.get('sandboxPolicy');
        const values = permissions?.names ?? (sandbox === undefined ? [] : SANDBOX_MODES);
        if (values.length === 0)
            return undefined;
        let current;
        try {
            current = permissions?.current(this.agent.session) ?? sandbox?.overrideOf(this.agent.session) ?? sandbox?.defaultMode;
        }
        catch {
            current = undefined;
        }
        return {
            id: 'permission',
            name: 'Write permission',
            description: 'Sandbox and approval policy for file and shell writes',
            category: 'permission',
            type: 'select',
            currentValue: current ?? values[0],
            options: values.map(value => ({ value, name: permissionLabel(value), description: null })),
        };
    }
    /** Advertise the Agent-scoped slash command catalog after the session response. */
    advertiseCommands() {
        const commands = this.ctx.get('commands');
        if (commands === undefined)
            return;
        let availableCommands;
        try {
            availableCommands = commands.list(this.agent).map(command => ({
                name: command.name,
                description: command.description,
                ...(command.input === undefined ? {} : { input: { hint: command.input.hint } }),
            }));
        }
        catch (error) {
            this.ctx.logger.warn(`acp: listing slash commands failed: ${errorChain(error)}`);
            return;
        }
        setTimeout(() => {
            void this.notify({
                sessionId: this.agent.session.id,
                update: { sessionUpdate: 'available_commands_update', availableCommands },
            });
        }, 0);
    }
    /** Replay durable transcript history for the non-standard session/load extension. */
    async replayHistory() {
        let planEntries = null;
        for (const event of this.agent.session.snapshotEvents()) {
            switch (event.type) {
                case 'user/message': {
                    if (event.data.source.kind !== 'user')
                        break;
                    const text = contentToReplayText(event.data.content);
                    if (text.length > 0) {
                        await this.notify({
                            sessionId: this.agent.session.id,
                            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
                        });
                    }
                    break;
                }
                case 'assistant/message': {
                    for (const update of await assistantUpdates(this.ctx, this.agent.session, event)) {
                        await this.notify({ sessionId: this.agent.session.id, update });
                    }
                    break;
                }
                case 'tool/call': {
                    await this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event, this.cwd) });
                    break;
                }
                case 'tool/result': {
                    await this.notify({
                        sessionId: this.agent.session.id,
                        update: await toolResultUpdate(this.ctx, event, this.cwd),
                    });
                    break;
                }
                case 'todo/write': {
                    planEntries = event.data.todos;
                    break;
                }
                case 'turn/start': {
                    planEntries = null;
                    break;
                }
            }
        }
        if (planEntries !== null) {
            this.planKnown = true;
            await this.notify({ sessionId: this.agent.session.id, update: planUpdate(planEntries) });
        }
    }
    /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
    topologyChanged() {
        if (this.closing !== undefined)
            return;
        void this.allConfigOptions()
            .then((configOptions) => {
            if (this.closing !== undefined)
                return;
            const previous = this.outputTail;
            this.outputTail = previous
                .then(() => this.notify({
                sessionId: this.agent.session.id,
                update: { sessionUpdate: 'config_option_update', configOptions },
            }))
                /* v8 ignore start -- the bridge notifier contains transport failure. */
                .catch((error) => {
                this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`);
            });
            /* v8 ignore stop */
        })
            /* v8 ignore start -- option discovery contains per-provider failure. */
            .catch((error) => {
            this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`);
        });
        /* v8 ignore stop */
    }
    /**
     * Admit, enqueue, and settle one prompt at whole-Agent quiescence.
     * @param params - standard ACP prompt request for this session.
     * @param imageEnabled - connection-level capability advertised at initialization.
     * @param requestSignal - JSON-RPC request cancellation signal.
     * @returns the correlated standard stop reason after ordered updates drain.
     */
    async prompt(params, imageEnabled, requestSignal) {
        this.assertActive();
        if (this.inflight !== undefined)
            throw invalidParams('a prompt is already in flight for this session');
        const completion = Promise.withResolvers();
        const admission = Promise.withResolvers();
        const admissionController = new AbortController();
        const inflight = {
            resolve: completion.resolve,
            reject: completion.reject,
            messageId: undefined,
            messageQueued: false,
            turn: undefined,
            endReason: undefined,
            admissionDone: admission.promise,
            finishAdmission: admission.resolve,
            admissionController,
            cancelRequested: false,
            settlementStarted: false,
            outputError: undefined,
            agentError: undefined,
        };
        this.inflight = inflight;
        const onRequestAbort = () => {
            this.commandAbort?.abort(new Error('ACP prompt request cancelled'));
            this.cancelPrompt('ACP prompt request cancelled');
        };
        requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
        /* v8 ignore next -- the SDK dispatches a live signal, then notifies abort through its listener. */
        if (requestSignal?.aborted === true)
            onRequestAbort();
        try {
            const commandText = acpPromptToText(params.prompt);
            const commands = this.ctx.get('commands');
            if (commands !== undefined && commandText.trimStart().startsWith('/')) {
                inflight.finishAdmission();
                const commandAbort = new AbortController();
                this.commandAbort = commandAbort;
                try {
                    const execution = await commands.execute(this.agent, commandText, acpPromptToCommandAttachments(params.prompt), commandAbort.signal);
                    if (execution !== undefined) {
                        const resultText = execution.result.text ?? '';
                        if (resultText.length > 0) {
                            await this.notify({
                                sessionId: this.agent.session.id,
                                update: {
                                    sessionUpdate: 'agent_message_chunk',
                                    content: { type: 'text', text: execution.result.kind === 'error' ? `command failed: ${resultText}` : resultText },
                                },
                            });
                        }
                        await this.agent.whenIdle();
                        await this.outputTail;
                        if (this.inflight === inflight)
                            this.inflight = undefined;
                        return { stopReason: 'end_turn' };
                    }
                }
                catch (error) {
                    if (commandAbort.signal.aborted) {
                        if (this.inflight === inflight)
                            this.inflight = undefined;
                        return { stopReason: 'cancelled' };
                    }
                    const detail = errorChain(error);
                    await this.notify({
                        sessionId: this.agent.session.id,
                        update: {
                            sessionUpdate: 'agent_message_chunk',
                            content: { type: 'text', text: `command failed: ${detail}` },
                        },
                    });
                    if (this.inflight === inflight)
                        this.inflight = undefined;
                    return { stopReason: 'end_turn' };
                }
                finally {
                    if (this.commandAbort === commandAbort)
                        this.commandAbort = undefined;
                }
            }
            let admissionFailure;
            const promptSelection = this.modelControl.snapshot();
            try {
                if (this.ctx.agents.get(this.agent.id) !== this.agent) {
                    throw internalError('prompt was not queued: the agent was disposed outside the bridge');
                }
                const content = await admitAcpPrompt(this.ctx, promptSelection, params.prompt, imageEnabled, admissionController.signal);
                admissionController.signal.throwIfAborted();
                if (this.ctx.agents.get(this.agent.id) !== this.agent) {
                    throw internalError('prompt was not queued: the agent was disposed outside the bridge');
                }
                const message = createUserMessage({
                    content,
                    source: { kind: 'user' },
                });
                inflight.messageId = message.id;
                inflight.messageQueued = true;
                if (promptSelection !== undefined)
                    this.pendingSelections.set(message.id, promptSelection);
                try {
                    this.agent.followup(message);
                }
                catch (error) {
                    inflight.messageQueued = false;
                    this.pendingSelections.delete(message.id);
                    throw error;
                }
            }
            catch (error) {
                admissionFailure = error;
            }
            finally {
                inflight.finishAdmission();
            }
            if (inflight.cancelRequested) {
                this.settleAfterQuiescence(inflight);
                return { stopReason: await completion.promise };
            }
            if (admissionFailure !== undefined) {
                this.inflight = undefined;
                if (admissionFailure instanceof AcpContentError) {
                    throw admissionFailure.kind === 'invalid'
                        ? invalidParams(admissionFailure.message)
                        : internalError(admissionFailure.message);
                }
                if (admissionFailure instanceof RequestError)
                    throw admissionFailure;
                throw internalError(`prompt was not queued: ${admissionFailure.message}`);
            }
            this.settleAfterQuiescence(inflight);
            return { stopReason: await completion.promise };
        }
        finally {
            requestSignal?.removeEventListener('abort', onRequestAbort);
        }
    }
    /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
    cancel() {
        const inflight = this.inflight;
        this.commandAbort?.abort(new Error('ACP prompt cancelled'));
        this.cancelPrompt('ACP prompt cancelled');
        if (inflight === undefined)
            this.agent.cancel({ kind: 'user' });
    }
    /**
     * Project one process-local assistant stream frame onto ACP text/thought chunks.
     * @param frame - start, chunk, or terminal frame published by the Agent loop.
     */
    onAssistantStream(frame) {
        const attempt = String(frame.attemptId);
        if (frame.type === 'start') {
            this.attempts.set(attempt, { turn: frame.turn, step: frame.step });
            return;
        }
        if (frame.type === 'end') {
            this.attempts.delete(attempt);
            return;
        }
        const position = this.attempts.get(attempt);
        if (position === undefined)
            return;
        if (frame.chunk.type === 'text-delta' && frame.chunk.text.length > 0) {
            this.streamedSteps.add(`text:${position.turn}:${position.step}`);
            this.enqueue({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: frame.chunk.text },
            });
        }
        else if (frame.chunk.type === 'reasoning-delta' && frame.chunk.text.length > 0) {
            this.streamedSteps.add(`reasoning:${position.turn}:${position.step}`);
            this.enqueue({
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: frame.chunk.text },
            });
        }
    }
    /**
     * Process one durable event and enqueue its standard ACP projections.
     * @param session - exact event-owning Session.
     * @param event - committed durable event.
     */
    onSessionEvent(session, event) {
        try {
            if (event.type === 'assistant/message') {
                const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined;
                const previous = this.outputTail;
                const delivery = previous.then(async () => {
                    const key = `${event.data.turn}:${event.data.step}`;
                    for (const update of await assistantUpdates(this.ctx, session, event, {
                        skipText: this.streamedSteps.has(`text:${key}`),
                        skipReasoning: this.streamedSteps.has(`reasoning:${key}`),
                    })) {
                        await this.notify({ sessionId: this.agent.session.id, update });
                    }
                });
                this.outputTail = delivery.catch((error) => {
                    const failure = error;
                    if (inflight !== undefined)
                        inflight.outputError ??= failure;
                    this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`);
                });
            }
            else if (event.type === 'tool/call') {
                const args = parseToolInput(event.data.arguments);
                const snapshot = snapshotToolFile(event.data.name, args, this.cwd);
                if (snapshot !== undefined)
                    this.fileSnapshots.set(event.data.callId, snapshot);
                const line = snapshot?.oldText === null || snapshot === undefined
                    ? undefined
                    : findUniqueLineNumber(snapshot.oldText, getEditNeedle(event.data.name, args));
                const previous = this.outputTail;
                this.outputTail = previous
                    .then(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event, this.cwd, line) }))
                    /* v8 ignore start -- the bridge notifier contains transport rejection. */
                    .catch((error) => {
                    this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`);
                });
                /* v8 ignore stop */
            }
            else if (event.type === 'tool/result') {
                const callId = event.data.message.toolCallId;
                const snapshot = this.fileSnapshots.get(callId);
                this.fileSnapshots.delete(callId);
                const previous = this.outputTail;
                this.outputTail = previous
                    .then(async () => this.notify({
                    sessionId: this.agent.session.id,
                    update: await toolResultUpdate(this.ctx, event, this.cwd, snapshot),
                }))
                    /* v8 ignore start -- supplemental-content conversion failure is contained and cannot fail Agent work. */
                    .catch((error) => {
                    this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`);
                });
                /* v8 ignore stop */
            }
            else if (event.type === 'todo/write') {
                this.planKnown = true;
                this.enqueue(planUpdate(event.data.todos));
            }
            else if (event.type === 'turn/start') {
                if (this.planKnown)
                    this.enqueue({ sessionUpdate: 'plan', entries: [] });
                this.planKnown = false;
            }
        }
        finally {
            const inflight = this.inflight;
            if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
                inflight.endReason = event.data.reason;
            }
            if (event.type === 'turn/end') {
                this.modelControl.releaseTurn(event.data.turn);
                for (const key of this.streamedSteps) {
                    if (key.startsWith(`text:${event.data.turn}:`) || key.startsWith(`reasoning:${event.data.turn}:`)) {
                        this.streamedSteps.delete(key);
                    }
                }
            }
        }
    }
    /**
     * Correlate an accepted user message with its Agent turn and pinned route.
     * @param message - claimed durable inbox message.
     * @param turn - allocated Agent turn.
     */
    onInboxClaimed(message, turn) {
        if (this.inflight !== undefined && this.inflight.messageId === message.id)
            this.inflight.turn = turn;
        const selection = this.pendingSelections.get(message.id);
        this.pendingSelections.delete(message.id);
        if (selection !== undefined)
            this.modelControl.pinTurn(turn, selection);
    }
    /**
     * Correlate an Agent interval failure with the active ACP prompt.
     * @param turn - failed turn number.
     * @param error - original same-process failure.
     */
    onAgentError(turn, error) {
        const inflight = this.inflight;
        if (inflight === undefined || !inflight.messageQueued)
            return;
        // AgentLoop balances an in-turn failure with durable turn/end; settlement
        // reads that exact error reason. This slot records interval failures outside it.
        if (inflight.turn === turn)
            return;
        inflight.agentError = new Error(errorChain(error));
        this.settleAfterQuiescence(inflight);
    }
    /** Await every update queued before this call. */
    drainUpdates() {
        return this.outputTail;
    }
    /**
     * Cancel, drain, flush, and dispose this session once.
     * @param detail - cancellation detail for any prompt still in admission.
     * @returns the shared quiescent teardown promise.
     */
    close(detail) {
        if (this.closing !== undefined)
            return this.closing;
        this.closing = (async () => {
            const failures = [];
            const inflight = this.inflight;
            this.cancelPrompt(detail);
            if (inflight === undefined || !inflight.messageQueued)
                this.agent.cancel({ kind: 'user' });
            try {
                await inflight?.admissionDone;
                await this.agent.whenIdle();
                await this.outputTail;
            }
            catch (error) {
                failures.push(new Error('ACP session activity drain failed', { cause: error }));
            }
            const subagents = this.ctx.get('subagents');
            try {
                await subagents?.drainContinuableDescendants([this.agent]);
            }
            catch (error) {
                this.ctx.logger.warn(`acp: continuable subagent teardown failed: ${errorChain(error)}`);
                failures.push(new Error('continuable subagent teardown failed', { cause: error }));
            }
            try {
                await this.ctx.sessions.flush(this.agent.session);
            }
            catch (error) {
                failures.push(new Error('ACP session persistence flush failed', { cause: error }));
            }
            try {
                await this.disposeAgent();
            }
            catch (error) {
                failures.push(error);
            }
            this.pendingSelections.clear();
            if (failures.length === 1)
                throw failures[0];
            /* v8 ignore start -- independent teardown failures can aggregate only under multiple simultaneous provider faults. */
            if (failures.length > 1) {
                throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`);
            }
            /* v8 ignore stop */
        })();
        return this.closing;
    }
    enqueue(update) {
        const previous = this.outputTail;
        this.outputTail = previous
            .then(() => this.notify({ sessionId: this.agent.session.id, update }))
            .catch((error) => {
            this.ctx.logger.warn(`acp: session update delivery failed: ${errorChain(error)}`);
        });
    }
    assertActive() {
        if (this.closing !== undefined)
            throw invalidParams(`session is closing: ${this.agent.session.id}`);
    }
    cancelPrompt(detail) {
        const inflight = this.inflight;
        if (inflight === undefined)
            return;
        inflight.cancelRequested = true;
        inflight.admissionController.abort(new Error(detail));
        this.settleAfterQuiescence(inflight);
        if (inflight.messageQueued)
            this.agent.cancel({ kind: 'user' });
    }
    settleAfterQuiescence(inflight) {
        if (inflight.settlementStarted)
            return;
        inflight.settlementStarted = true;
        void (async () => {
            await inflight.admissionDone;
            if (inflight.messageQueued) {
                await this.agent.whenIdle();
                await this.outputTail;
            }
            /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
            if (this.inflight !== inflight)
                return;
            this.inflight = undefined;
            if (inflight.cancelRequested) {
                inflight.resolve('cancelled');
                return;
            }
            if (inflight.outputError !== undefined) {
                inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`));
                return;
            }
            if (inflight.agentError !== undefined) {
                inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`));
                return;
            }
            const end = inflight.endReason;
            if (end === undefined) {
                inflight.resolve('cancelled');
            }
            else if (end.kind === 'error') {
                inflight.reject(internalError(`turn failed: ${end.error.message}`));
            }
            else {
                inflight.resolve(turnEndToStopReason(end));
            }
        })()
            /* v8 ignore start -- admissionDone only resolves; idle/output gates contain their own failures. */
            .catch((error) => {
            if (this.inflight !== inflight)
                return;
            this.inflight = undefined;
            inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`));
        });
        /* v8 ignore stop */
    }
}
/** Parse model-authored JSON arguments without discarding malformed text. */
function parseToolInput(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
/** Human-readable labels for permission presets and raw sandbox modes. */
function permissionLabel(name) {
    switch (name) {
        case 'read-only': return 'Read only';
        case 'workspace-write': return 'Workspace write';
        case 'danger-full-access': return 'Full access';
        default: return name;
    }
}
/** Render user transcript blocks for replay while preserving image placeholders. */
function contentToReplayText(blocks) {
    return blocks.flatMap((block) => {
        if (block.type === 'text')
            return [block.text];
        if (block.type === 'image') {
            const attachment = block.attachment;
            const dimensions = typeof attachment.width === 'number' && typeof attachment.height === 'number'
                ? `, ${attachment.width}x${attachment.height} px`
                : '';
            return [`[image: ${attachment.name ?? attachment.mediaType ?? 'attachment'}${dimensions}]`];
        }
        return [];
    }).join('');
}
//# sourceMappingURL=session.js.map