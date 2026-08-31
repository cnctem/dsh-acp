import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock, PlanEntry, StopReason, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk';
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { TurnEndReason } from '@deepseek-ai/dsh-session';
import type { BridgeLogger } from './types.js';
export type ToolArguments = Record<string, unknown>;
interface ToolResultBlock {
    type?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: readonly {
        type?: string;
        text?: string;
    }[];
}
interface ToolResultMessage {
    content?: readonly ToolResultBlock[];
}
interface ImageAttachment {
    name?: string;
    mediaType?: string;
    width?: number;
    height?: number;
}
export interface TodoItem {
    content: string;
    status: PlanEntry['status'];
}
export interface SessionParams {
    cwd: string;
    additionalDirectories?: readonly unknown[];
    mcpServers?: readonly unknown[];
}
export declare const MUTATING_TOOLS: Set<string>;
export declare function invalidParams(detail: string): RequestError;
export declare function internalError(detail: string): RequestError;
export declare function turnEndToStopReason(reason: TurnEndReason): StopReason;
export declare function acpPromptToText(prompt: readonly ContentBlock[]): string;
export declare function promptHasUnsupportedContent(prompt: readonly ContentBlock[]): boolean;
export declare function acpImagesToEncoded(prompt: readonly ContentBlock[]): EncodedImageAttachment[];
export declare function validateSessionParams(params: SessionParams, logger: Pick<BridgeLogger, 'debug'>): void;
export declare function isTerminalTool(name: string): boolean;
export declare function toToolKind(name: string): ToolKind;
export declare function getToolPath(args: ToolArguments | undefined): string | undefined;
export declare function toolTitle(name: string, args: ToolArguments): string;
export declare function toToolCallLocations(args: ToolArguments, cwd: string): ToolCallLocation[] | undefined;
export declare function getEditNeedle(name: string, args: ToolArguments): string | undefined;
export declare function findUniqueLineNumber(text: string, needle: string | undefined): number | undefined;
export declare function permissionLabel(name: string): string;
export declare function parseToolArguments(raw: string | undefined): ToolArguments;
export declare function toolResultToText(message: ToolResultMessage | undefined): string;
export declare function imageMarker(attachment: ImageAttachment | undefined): string;
export declare function toPlanEntries(todos: readonly TodoItem[]): PlanEntry[];
export {};
