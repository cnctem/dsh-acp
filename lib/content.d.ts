/** ACP wire-content admission and projection owned by the ACP adapter. @module */
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk';
import type { Context } from '@deepseek-ai/cordis';
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/** Content-admission failure category used by the protocol handler. */
export type AcpContentFailureKind = 'invalid' | 'internal';
/** Error with a stable ACP request-failure category and no raw binary payload. */
export declare class AcpContentError extends Error {
    /** Whether the bridge should report invalid params or an internal failure. */
    readonly kind: AcpContentFailureKind;
    /**
     * @param message - safe protocol-facing detail without inline binary data.
     * @param kind - request-failure category.
     * @param options - optional causal chain for diagnostics.
     */
    constructor(message: string, kind: AcpContentFailureKind, options?: ErrorOptions);
}
/**
 * Determine whether initialization may truthfully advertise inline image prompts.
 * A connection accepts images when the attachment store handles a raster format and
 * any selectable model route declares image input; the client may switch models after
 * initialization, so the exact pinned route is validated again per prompt. Unknown
 * service, catalog, or deployment media support is negative.
 * @param ctx - bridge context carrying optional attachment and model services.
 * @returns whether at least one selectable route can admit images.
 */
export declare function supportsAcpImagePrompts(ctx: Context): Promise<boolean>;
/** Project command text while retaining image blocks for command attachment admission. */
export declare function acpPromptToText(prompt: readonly AcpContentBlock[]): string;
/** Convert ACP image blocks into the command plane's encoded-image attachment shape. */
export declare function acpPromptToCommandAttachments(prompt: readonly AcpContentBlock[]): readonly {
    type: 'image';
    data: string;
    mediaType: ImageMediaType;
}[];
/**
 * Admit one ACP prompt into ordered durable core content.
 * Every wire block and image is validated before the ordered image batch starts
 * writing; cancellation after a successful content-addressed write may leave an
 * unreachable object but never queues a late user message.
 * @param ctx - bridge context carrying attachment and model services.
 * @param route - selection pinned to the accepted prompt.
 * @param prompt - untrusted ACP prompt blocks in wire order.
 * @param imageEnabled - connection-level capability advertised during initialization.
 * @param signal - admission cancellation signal.
 * @returns core content with durable image references in wire order.
 */
export declare function admitAcpPrompt(ctx: Context, route: ModelSelection | undefined, prompt: readonly AcpContentBlock[], imageEnabled: boolean, signal: AbortSignal): Promise<ContentBlock[]>;
/**
 * Translate one committed assistant block to ACP wire content.
 * Images are re-read and integrity-verified before inline base64 delivery;
 * unsupported core output blocks stay off the automation wire.
 * @param ctx - bridge context carrying the authoritative attachment store.
 * @param block - committed core assistant block.
 * @returns ACP text/image content, or undefined for non-output blocks.
 */
export declare function assistantBlockToAcp(ctx: Context, block: ContentBlock): Promise<AcpContentBlock | undefined>;
