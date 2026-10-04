/** Stable ACP elicitation bridge for dsh's scoped user-question waterfall. */
import { methods } from '@agentclientprotocol/sdk';
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
                items: { type: 'string', enum: options.map(option => option.label) },
            };
        }
        else if (options.length > 0) {
            properties[question.id] = {
                ...base,
                type: 'string',
                oneOf: options.map(option => ({ const: option.label, title: option.label })),
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
function elicitationRequest(sessionId, callId, payload) {
    return {
        sessionId,
        mode: 'form',
        ...(callId === undefined ? {} : { toolCallId: callId }),
        message: payload.message,
        requestedSchema: payload.requestedSchema,
    };
}
/** Translate one dsh user-question request into a stable ACP form elicitation. */
export async function askViaAcp(options, request, sessionId) {
    if (!options.supportsForm()) {
        throw new UserQuestionError('the ACP client does not support user questions (missing elicitation capability); include the unresolved question or decision in your final result', 'ELICITATION_UNSUPPORTED');
    }
    const payload = buildQuestionElicitation(request.questions);
    const params = elicitationRequest(sessionId, request.wait?.callId, payload);
    let response;
    try {
        response = await withAbort(options.connection().request(methods.client.elicitation.create, params), request.signal);
    }
    catch (error) {
        if (error instanceof UserQuestionError)
            throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (/method not found|-32601/iu.test(detail)) {
            throw new UserQuestionError('the ACP client does not implement elicitation/create; include the unresolved question or decision in your final result', 'ELICITATION_UNSUPPORTED', { cause: error });
        }
        throw error;
    }
    if (response.action !== 'accept') {
        throw new UserQuestionError('the user declined or cancelled the question', 'ASK_CANCELLED');
    }
    const content = (response.content ?? {});
    return { answers: convertElicitationAnswers(request.questions, content) };
}
function withAbort(promise, signal) {
    if (signal === undefined)
        return promise;
    if (signal.aborted) {
        return Promise.reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
//# sourceMappingURL=elicitation.js.map