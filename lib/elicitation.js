import { UserQuestionError } from '@deepseek-ai/dsh-user-questions';
function buildQuestionElicitation(questions) {
    const properties = {};
    const required = [];
    for (const question of questions) {
        const options = question.options ?? [];
        const base = { title: question.header ?? question.id, description: question.question };
        if (question.multiSelect === true && options.length > 0) {
            properties[question.id] = {
                ...base,
                type: 'array',
                items: { type: 'string', enum: options.map((option) => option.label) },
            };
        }
        else if (options.length > 0) {
            properties[question.id] = {
                ...base,
                type: 'string',
                oneOf: options.map((option) => ({ const: option.label, title: option.label })),
            };
        }
        else {
            properties[question.id] = { ...base, type: 'string' };
            required.push(question.id);
            continue;
        }
        properties[`${question.id}__other`] = {
            type: 'string',
            title: 'Other',
            description: 'Type your own answer instead of choosing an option above.',
        };
    }
    return {
        message: questions.length === 1 ? questions[0].question : `Input requested (${questions.length} questions)`,
        requestedSchema: { type: 'object', properties, required },
    };
}
function convertElicitationAnswers(questions, content) {
    const answers = [];
    for (const question of questions) {
        const options = question.options ?? [];
        const picked = content[question.id];
        if (options.length === 0) {
            if (picked === undefined)
                continue;
            answers.push({
                id: question.id,
                selected: [],
                custom: Array.isArray(picked) ? picked.map(String).join(', ') : String(picked),
            });
            continue;
        }
        const other = content[`${question.id}__other`];
        const custom = other === undefined ? undefined : (Array.isArray(other) ? other.map(String).join(', ') : String(other));
        if (question.multiSelect === true) {
            const selected = Array.isArray(picked) ? picked.map(String) : picked === undefined ? [] : [String(picked)];
            if (selected.length === 0 && custom === undefined)
                continue;
            answers.push({ id: question.id, selected, ...(custom === undefined ? {} : { custom }) });
        }
        else {
            const selected = custom === undefined && picked !== undefined ? [String(picked)] : [];
            if (selected.length === 0 && custom === undefined)
                continue;
            answers.push({ id: question.id, selected, ...(custom === undefined ? {} : { custom }) });
        }
    }
    return answers;
}
function askElicitation(connection, params, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => {
            if (settled)
                return;
            settled = true;
            fn(value);
        };
        const onAbort = () => settle(reject, new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'));
        signal?.addEventListener('abort', onAbort, { once: true });
        connection.unstable_createElicitation(params).then((response) => settle(resolve, response), (error) => settle(reject, error));
    });
}
export function createElicitationProvider(options) {
    return async function askViaAcp(request) {
        const record = request.agent === undefined ? undefined : options.ownedRecord(request.agent);
        if (record === undefined) {
            throw new UserQuestionError('human interaction is unavailable for this agent', 'CALLER_NOT_LIVE');
        }
        if (!options.supportsForm()) {
            throw new UserQuestionError('the ACP client does not support user questions (missing elicitation capability); include the unresolved question or decision in your final result', 'ELICITATION_UNSUPPORTED');
        }
        const { message, requestedSchema } = buildQuestionElicitation(request.questions);
        const toolCallId = record.questionCallIds.shift();
        let response;
        try {
            response = await askElicitation(options.connection(), {
                sessionId: record.agent.session.id,
                ...(toolCallId === undefined ? {} : { toolCallId }),
                mode: 'form',
                message,
                requestedSchema,
            }, request.signal);
        }
        catch (error) {
            if (String(error).includes('elicitation/create')) {
                throw new UserQuestionError('the ACP client does not support user questions (elicitation/create failed); include the unresolved question or decision in your final result', 'ELICITATION_UNSUPPORTED');
            }
            throw error;
        }
        if (response.action === 'accept') {
            return { answers: convertElicitationAnswers(request.questions, response.content ?? {}) };
        }
        if (response.action === 'decline') {
            throw new UserQuestionError('the user declined ask_user_question', 'ASK_CANCELLED');
        }
        throw new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED');
    };
}
//# sourceMappingURL=elicitation.js.map