/** ACP session updates derived from committed DSH session events and editor-facing tool events. */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assistantBlockToAcp } from './content.js';
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const TERMINAL_TOOLS = new Set(['bash', 'pwsh']);
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isToolDiffPayload(value) {
    return isRecord(value)
        && typeof value.path === 'string'
        && (typeof value.oldText === 'string' || value.oldText === null)
        && typeof value.newText === 'string';
}
function parseToolArguments(value) {
    try {
        return JSON.parse(value);
    }
    catch (_invalidModelJson) {
        return value;
    }
}
function toolArguments(value) {
    return isRecord(value) ? value : {};
}
function toolPath(args) {
    if (typeof args.path === 'string')
        return args.path;
    if (typeof args.file_path === 'string')
        return args.file_path;
    return undefined;
}
function toolTitle(name, args) {
    if ((name === 'bash' || name === 'pwsh') && typeof args.command === 'string') {
        const command = args.command.trim();
        return command.length > 120 ? `${command.slice(0, 120)}…` : command;
    }
    return name;
}
/** Map a DSH tool name to the closest ACP presentation kind. */
export function toolKind(name) {
    switch (name) {
        case 'read':
        case 'read_image':
        case 'glob':
        case 'grep':
            return 'read';
        case 'write':
        case 'edit':
        case 'str_replace_editor':
            return 'edit';
        case 'bash':
        case 'pwsh':
            return 'execute';
        default:
            return 'other';
    }
}
/** Whether the tool mutates one path and benefits from a before-image snapshot. */
export function isMutatingTool(name) {
    return MUTATING_TOOLS.has(name);
}
/** Extract a path shared by file tools. */
export function getToolPath(args) {
    return toolPath(toolArguments(args));
}
/** Extract the unique old text inserted by an edit, used to infer an ACP line location. */
export function getEditNeedle(name, args) {
    const value = toolArguments(args);
    if (name === 'edit' && typeof value.old_string === 'string')
        return value.old_string;
    if (name === 'str_replace_editor' && typeof value.old_str === 'string')
        return value.old_str;
    return undefined;
}
/** Resolve a possibly relative tool path against the ACP session workspace. */
export function resolveToolPath(path, cwd) {
    return isAbsolute(path) ? path : resolve(cwd, path);
}
/** Read a pre-mutation snapshot, or preserve a null old image when the file did not exist. */
export function snapshotToolFile(name, args, cwd) {
    if (!isMutatingTool(name))
        return undefined;
    const path = getToolPath(args);
    if (path === undefined)
        return undefined;
    try {
        return { path, oldText: readFileSync(resolveToolPath(path, cwd), 'utf8') };
    }
    catch {
        return { path, oldText: null };
    }
}
/** Find the unique one-based line number containing an exact edit needle. */
export function findUniqueLineNumber(text, needle) {
    if (!needle)
        return undefined;
    const first = text.indexOf(needle);
    if (first < 0 || text.indexOf(needle, first + needle.length) >= 0)
        return undefined;
    let line = 1;
    for (let index = 0; index < first; index += 1) {
        if (text.charCodeAt(index) === 10)
            line += 1;
    }
    return line;
}
/** Convert one committed assistant message and its context usage in block order. */
export async function assistantUpdates(ctx, session, event, options = {}) {
    const updates = [];
    for (const block of event.data.message.content) {
        if (block.type === 'reasoning') {
            if (!options.skipReasoning && block.text.length > 0) {
                updates.push({
                    sessionUpdate: 'agent_thought_chunk',
                    messageId: event.data.message.id,
                    content: { type: 'text', text: block.text },
                });
            }
            continue;
        }
        if (options.skipText && block.type === 'text')
            continue;
        const content = await assistantBlockToAcp(ctx, block);
        if (content !== undefined) {
            updates.push({
                sessionUpdate: 'agent_message_chunk',
                messageId: event.data.message.id,
                content,
            });
        }
    }
    const usage = usageUpdate(ctx, session, event);
    if (usage !== undefined)
        updates.push(usage);
    return updates;
}
/** Start one ACP tool lifecycle with title, kind, path location, raw input and terminal content. */
export function toolCallUpdate(event, cwd, line) {
    const rawInput = parseToolArguments(event.data.arguments);
    const args = toolArguments(rawInput);
    const path = toolPath(args);
    const resolvedPath = path === undefined ? undefined : resolveToolPath(path, cwd);
    const terminal = TERMINAL_TOOLS.has(event.data.name);
    return {
        sessionUpdate: 'tool_call',
        toolCallId: event.data.callId,
        title: toolTitle(event.data.name, args),
        kind: toolKind(event.data.name),
        status: 'in_progress',
        ...resolvedPath === undefined
            ? {}
            : { locations: [{ path: resolvedPath, ...(line === undefined ? {} : { line }) }] },
        rawInput,
        ...terminal
            ? {
                content: [{ type: 'terminal', terminalId: event.data.callId }],
                _meta: { terminal_info: { terminal_id: event.data.callId, cwd } },
            }
            : {},
    };
}
/** Finish one tool lifecycle, preferring native hunks, then a snapshot diff, then rendered text. */
export async function toolResultUpdate(ctx, event, cwd, snapshot) {
    const message = event.data.message;
    const callId = message.toolCallId;
    const isError = event.data.error !== undefined || message.isError === true;
    const renderedText = resultText(message.content);
    const terminal = terminalMeta(event);
    if (terminal) {
        const meta = isRecord(event.data.meta) ? event.data.meta : undefined;
        const output = typeof meta?.output === 'string' ? meta.output : renderedText;
        const exitCode = typeof meta?.exitCode === 'number' ? meta.exitCode : isError ? 1 : 0;
        const signal = typeof meta?.signal === 'string' ? meta.signal : null;
        return {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: isError ? 'failed' : 'completed',
            _meta: {
                terminal_output: { terminal_id: callId, data: output },
                terminal_exit: { terminal_id: callId, exit_code: exitCode, signal },
            },
        };
    }
    let content;
    const metaDiffs = isRecord(event.data.meta) && Array.isArray(event.data.meta.diffs)
        ? event.data.meta.diffs.flatMap(value => isToolDiffPayload(value) ? [value] : [])
        : [];
    if (metaDiffs.length > 0) {
        content = metaDiffs.map(diff => ({ type: 'diff', path: diff.path, oldText: diff.oldText, newText: diff.newText }));
    }
    else if (snapshot !== undefined) {
        try {
            const newText = readFileSync(resolveToolPath(snapshot.path, cwd), 'utf8');
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
                content = [{ type: 'diff', path: snapshot.path, oldText: snapshot.oldText, newText }];
            }
        }
        catch {
            // fall through to the rendered result text
        }
    }
    if (content === undefined) {
        const converted = [];
        for (const block of message.content) {
            const item = await assistantBlockToAcp(ctx, block);
            if (item !== undefined)
                converted.push({ type: 'content', content: item });
        }
        if (converted.length > 0)
            content = converted;
    }
    if (content === undefined && renderedText.length > 0) {
        content = [{ type: 'content', content: { type: 'text', text: renderedText } }];
    }
    return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: isError ? 'failed' : 'completed',
        ...content === undefined ? {} : { content },
    };
}
/** Convert a complete todo/write snapshot into the stable ACP plan update. */
export function planUpdate(todos) {
    return {
        sessionUpdate: 'plan',
        entries: todos.map(todo => ({ content: todo.content, priority: 'medium', status: todo.status })),
    };
}
/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(ctx, session, event) {
    if (event.data.usage === undefined)
        return undefined;
    const size = session.requestContext()?.contextWindow;
    const meter = ctx.get('tokenMeter');
    if (size === undefined || meter === undefined)
        return undefined;
    return {
        sessionUpdate: 'usage_update',
        used: meter.measure(session).totalTokens,
        size,
    };
}
function terminalMeta(event) {
    return isRecord(event.data.meta) && event.data.meta.card === 'terminal';
}
function resultText(blocks) {
    return blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('');
}
//# sourceMappingURL=updates.js.map