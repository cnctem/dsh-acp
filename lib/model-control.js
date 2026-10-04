/** Standard ACP session configuration over one Agent's model selection. */
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
const MODEL_CONFIG_ID = 'model';
const REASONING_CONFIG_ID = 'thought_level';
// DSH reasoning effort ids are non-empty, so this sentinel is a disjoint provider-default choice.
const PROVIDER_DEFAULT_REASONING_VALUE = 'provider-default';
/** Caller-correctable session configuration failure. */
export class AcpModelConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AcpModelConfigError';
    }
}
/** Project and mutate one Agent's provider/model/reasoning selection through ACP config options. */
export class AcpModelControl {
    llm;
    /** Scoped selection reference consumed by Agent request assembly. */
    selection;
    tail = Promise.resolve();
    selected;
    turnSelection;
    hasResolvedState = false;
    constructor(llm, initial) {
        this.llm = llm;
        this.selected = initial;
        const getCurrent = () => this.turnSelection?.selection ?? this.selected;
        const setCurrent = (value) => { this.selected = value; };
        this.selection = {
            get current() { return getCurrent(); },
            set current(value) { setCurrent(value); },
            assembled: undefined,
        };
    }
    /**
     * Install request/prompt consistency listeners in the unpublished Agent scope.
     * @param agentCtx - Agent scope that consumes this selection.
     */
    install(agentCtx) {
        installModelSelection(agentCtx, this.selection);
    }
    /**
     * Snapshot the selection attached to the next accepted ACP prompt.
     * @returns a detached future selection, or undefined when listeners supply the route.
     */
    snapshot() {
        return this.selected === undefined ? undefined : { ...this.selected };
    }
    /**
     * Pin one admitted ACP message's selection for every step in its turn.
     * @param turn - admitted Agent turn.
     * @param selection - exact prompt-admission selection.
     */
    pinTurn(turn, selection) {
        this.turnSelection = { turn, selection: { ...selection } };
    }
    /**
     * Release only the exact completed turn's routing override.
     * @param turn - completed Agent turn.
     */
    releaseTurn(turn) {
        if (this.turnSelection?.turn === turn)
            this.turnSelection = undefined;
    }
    /**
     * Return the complete standard config-option state after prior mutations settle.
     * @param signal - optional catalog and exact-model cancellation.
     * @returns all current standard configuration options.
     */
    options(signal) {
        return this.serialize(async () => (await this.state(signal)).options);
    }
    /**
     * Set one advertised option and return the complete resulting option state.
     * @param configId - standard option id.
     * @param value - opaque selected value returned by a previous option state.
     * @param signal - optional catalog and exact-model cancellation.
     * @returns all standard options after the serialized mutation.
     */
    set(configId, value, signal) {
        return this.serialize(async () => {
            if (typeof value !== 'string')
                throw new AcpModelConfigError(`${configId} requires a select value`);
            const current = this.selected;
            if (current === undefined)
                throw new AcpModelConfigError('this session has no model selection');
            if (configId === MODEL_CONFIG_ID) {
                const state = await this.state(signal);
                const selected = state.choices.get(value);
                if (selected === undefined)
                    throw new AcpModelConfigError(`unknown model option: ${value}`);
                await this.resolveSelection(selected, signal);
                this.selected = selected;
            }
            else if (configId === REASONING_CONFIG_ID) {
                const info = await this.llm.resolveModelInfo(current.provider, current.model, signal);
                const providerDefault = value === PROVIDER_DEFAULT_REASONING_VALUE
                    && info.reasoning?.defaultEffort === undefined;
                if (info.reasoning === undefined
                    || (!providerDefault && !info.reasoning.efforts.some(effort => effort.id === value))) {
                    throw new AcpModelConfigError(`unknown reasoning effort for ${current.provider}/${current.model}: ${value}`);
                }
                this.selected = await this.resolveSelection({
                    provider: current.provider,
                    model: current.model,
                    ...providerDefault ? {} : { reasoningEffort: ReasoningEffortId(value) },
                }, signal);
            }
            else {
                throw new AcpModelConfigError(`unknown session config option: ${configId}`);
            }
            return (await this.state(signal)).options;
        });
    }
    /** Keep concurrent client mutations in receive order without wedging after rejection. */
    serialize(operation) {
        const result = this.tail.then(operation);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
    /** Build detached model choices and the dependent reasoning option. */
    async state(signal) {
        const selected = this.selected;
        if (selected === undefined)
            return { choices: new Map(), options: [] };
        let resolved;
        let routeAvailable = true;
        try {
            resolved = await this.resolveSelection(selected, signal);
            this.hasResolvedState = true;
        }
        catch (error) {
            if (!this.hasResolvedState)
                throw error;
            resolved = selected;
            routeAvailable = false;
        }
        const choices = new Map();
        const groups = await Promise.all(this.llm.listProviders().map(async (provider) => {
            try {
                const models = await this.llm.listModels(provider.id);
                const entries = models.map((model) => {
                    const choice = {
                        value: modelValue(provider.id, model.id),
                        selection: { provider: provider.id, model: model.id },
                    };
                    choices.set(choice.value, choice.selection);
                    return {
                        value: choice.value,
                        name: model.name,
                        ...model.description === undefined ? {} : { description: model.description },
                    };
                });
                return { group: provider.id, name: provider.name, options: entries };
            }
            catch (_providerCatalogUnavailable) {
                return { group: provider.id, name: provider.name, options: [] };
            }
        }));
        const currentValue = modelValue(resolved.provider, resolved.model);
        if (!choices.has(currentValue)) {
            choices.set(currentValue, { provider: resolved.provider, model: resolved.model });
            let group = groups.find(item => item.group === resolved.provider);
            if (group === undefined) {
                group = { group: resolved.provider, name: resolved.provider, options: [] };
                groups.push(group);
            }
            group.options.unshift({ value: currentValue, name: resolved.model });
        }
        const options = [{
                id: MODEL_CONFIG_ID,
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue,
                options: groups.filter(group => group.options.length > 0),
            }];
        const info = routeAvailable
            ? await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
            : undefined;
        if (info?.reasoning !== undefined) {
            options.push({
                id: REASONING_CONFIG_ID,
                name: 'Reasoning effort',
                category: 'thought_level',
                type: 'select',
                currentValue: resolved.reasoningEffort === undefined
                    ? PROVIDER_DEFAULT_REASONING_VALUE
                    : String(resolved.reasoningEffort),
                options: [
                    ...info.reasoning.defaultEffort === undefined
                        ? [{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: 'Provider default' }]
                        : [],
                    ...info.reasoning.efforts.map(effort => ({
                        value: String(effort.id),
                        name: effort.name,
                        ...effort.description === undefined ? {} : { description: effort.description },
                    })),
                ],
            });
        }
        return { choices, options };
    }
    /** Validate an exact route and retain only Agent-owned selection fields. */
    async resolveSelection(selection, signal) {
        const resolved = await this.llm.resolveCallConfig(selection, signal);
        return {
            provider: resolved.provider,
            model: resolved.model,
            ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
        };
    }
}
/** Opaque ACP selector value carrying the full route identity. */
function modelValue(provider, model) {
    return JSON.stringify([provider, model]);
}
//# sourceMappingURL=model-control.js.map