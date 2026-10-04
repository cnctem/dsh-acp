/** ACP session updates derived from committed DSH session events and editor-facing tool events. */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionUpdate, ToolKind } from '@agentclientprotocol/sdk';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** One persisted file snapshot used to synthesize a diff when a tool omits structured hunks. */
export interface FileSnapshot {
    path: string;
    oldText: string | null;
}
/** ACP update options used to suppress committed content already delivered by the live stream. */
export interface AssistantUpdateOptions {
    skipText?: boolean;
    skipReasoning?: boolean;
}
/** One todo row as persisted by dsh-tool-todo. */
export interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}
/** Map a DSH tool name to the closest ACP presentation kind. */
export declare function toolKind(name: string): ToolKind;
/** Whether the tool mutates one path and benefits from a before-image snapshot. */
export declare function isMutatingTool(name: string): boolean;
/** Extract a path shared by file tools. */
export declare function getToolPath(args: unknown): string | undefined;
/** Extract the unique old text inserted by an edit, used to infer an ACP line location. */
export declare function getEditNeedle(name: string, args: unknown): string | undefined;
/** Resolve a possibly relative tool path against the ACP session workspace. */
export declare function resolveToolPath(path: string, cwd: string): string;
/** Read a pre-mutation snapshot, or preserve a null old image when the file did not exist. */
export declare function snapshotToolFile(name: string, args: unknown, cwd: string): FileSnapshot | undefined;
/** Find the unique one-based line number containing an exact edit needle. */
export declare function findUniqueLineNumber(text: string, needle: string | undefined): number | undefined;
/** Convert one committed assistant message and its context usage in block order. */
export declare function assistantUpdates(ctx: Context, session: Session, event: SessionEvent<'assistant/message'>, options?: AssistantUpdateOptions): Promise<SessionUpdate[]>;
/** Start one ACP tool lifecycle with title, kind, path location, raw input and terminal content. */
export declare function toolCallUpdate(event: SessionEvent<'tool/call'>, cwd: string, line?: number): SessionUpdate;
/** Finish one tool lifecycle, preferring native hunks, then a snapshot diff, then rendered text. */
export declare function toolResultUpdate(ctx: Context, event: SessionEvent<'tool/result'>, cwd: string, snapshot?: FileSnapshot): Promise<SessionUpdate>;
/** Convert a complete todo/write snapshot into the stable ACP plan update. */
export declare function planUpdate(todos: readonly TodoItem[]): SessionUpdate;
