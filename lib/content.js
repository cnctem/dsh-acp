/** ACP wire-content admission and projection owned by the ACP adapter. @module */
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment';
/** Raster formats shared by ACP image blocks and the core attachment vocabulary. */
const IMAGE_MEDIA_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
];
/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Error with a stable ACP request-failure category and no raw binary payload. */
export class AcpContentError extends Error {
    /** Whether the bridge should report invalid params or an internal failure. */
    kind;
    /**
     * @param message - safe protocol-facing detail without inline binary data.
     * @param kind - request-failure category.
     * @param options - optional causal chain for diagnostics.
     */
    constructor(message, kind, options) {
        super(message, options);
        this.name = 'AcpContentError';
        this.kind = kind;
    }
}
/** Narrow a wire MIME string to the durable raster vocabulary. */
function imageMediaType(value) {
    return IMAGE_MEDIA_TYPES.includes(value) ? value : undefined;
}
/** Strictly decode one ACP inline image without accepting base64 aliases. */
function decodeImage(block) {
    const mediaType = imageMediaType(block.mimeType);
    if (mediaType === undefined) {
        throw new AcpContentError('image mimeType must be image/png, image/jpeg, image/webp, or image/gif', 'invalid');
    }
    if (!CANONICAL_BASE64.test(block.data)) {
        throw new AcpContentError('image data must be canonical base64', 'invalid');
    }
    const data = Buffer.from(block.data, 'base64');
    if (data.toString('base64') !== block.data) {
        throw new AcpContentError('image data must be canonical base64', 'invalid');
    }
    return { data, mediaType };
}
/** Resolve the exact current route and require explicit image input support. */
async function assertImageRoute(ctx, route, signal) {
    const provider = route?.provider;
    const model = route?.model;
    const llm = ctx.get('llm');
    if (provider === undefined || model === undefined || llm === undefined) {
        throw new AcpContentError('the current model route could not be resolved for image input', 'invalid');
    }
    let info;
    try {
        info = await llm.resolveModelInfo(provider, model, signal);
    }
    catch (error) {
        throw new AcpContentError('the current model route could not be verified for image input', 'internal', { cause: error });
    }
    if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
        throw new AcpContentError(`model "${model}" does not declare image input`, 'invalid');
    }
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
export async function supportsAcpImagePrompts(ctx) {
    const attachments = ctx.get('attachments');
    const llm = ctx.get('llm');
    if (attachments === undefined || llm === undefined)
        return false;
    if (!attachments.imageLimits.mediaTypes.some(mediaType => IMAGE_MEDIA_TYPES.includes(mediaType)))
        return false;
    for (const provider of llm.listProviders()) {
        try {
            const models = await llm.listModels(provider.id);
            if (models.some(model => model.inputModalities?.includes('image') === true))
                return true;
        }
        catch (_providerCatalogUnavailable) {
            // A provider without a usable catalog cannot contribute an image route.
        }
    }
    return false;
}
/** Render one baseline resource link into the core's current text vocabulary. */
function resourceLinkText(block) {
    return `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`;
}
/** Project command text while retaining image blocks for command attachment admission. */
export function acpPromptToText(prompt) {
    return prompt.flatMap((block) => {
        switch (block.type) {
            case 'text': return [block.text];
            case 'resource_link': return [resourceLinkText(block)];
            default: return [];
        }
    }).join('');
}
/** Convert ACP image blocks into the command plane's encoded-image attachment shape. */
export function acpPromptToCommandAttachments(prompt) {
    return prompt.flatMap((block) => block.type === 'image' && imageMediaType(block.mimeType) !== undefined
        ? [{ type: 'image', data: block.data, mediaType: imageMediaType(block.mimeType) }]
        : []);
}
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
export async function admitAcpPrompt(ctx, route, prompt, imageEnabled, signal) {
    const images = [];
    for (const block of prompt) {
        switch (block.type) {
            case 'text':
            case 'resource_link':
                break;
            case 'image':
                if (!imageEnabled)
                    throw new AcpContentError('inline image prompts were not advertised by this connection', 'invalid');
                images.push(decodeImage(block));
                break;
            case 'audio':
                throw new AcpContentError('audio prompt content is not supported', 'invalid');
            case 'resource':
                throw new AcpContentError('embedded resource prompt content is not supported', 'invalid');
            /* v8 ignore next 2 -- ACP ContentBlock is a closed generated union. */
            default:
                throw new AcpContentError('unsupported ACP prompt content', 'invalid');
        }
    }
    let refs = [];
    if (images.length > 0) {
        const attachments = ctx.get('attachments');
        if (attachments === undefined)
            throw new AcpContentError('no attachment store is mounted', 'invalid');
        await assertImageRoute(ctx, route, signal);
        signal.throwIfAborted();
        try {
            refs = await attachments.saveImages(images);
        }
        catch (error) {
            if (isImageAdmissionError(error)) {
                throw new AcpContentError(error.message, 'invalid', { cause: error });
            }
            throw new AcpContentError('unable to persist the prompt image batch', 'internal', { cause: error });
        }
        signal.throwIfAborted();
    }
    const content = [];
    let pendingText = '';
    let imageIndex = 0;
    const flushText = () => {
        if (pendingText.length === 0)
            return;
        content.push({ type: 'text', text: pendingText });
        pendingText = '';
    };
    for (const block of prompt) {
        switch (block.type) {
            case 'text':
                pendingText += block.text;
                break;
            case 'resource_link':
                pendingText += resourceLinkText(block);
                break;
            case 'image': {
                flushText();
                const ref = refs[imageIndex++];
                content.push({ type: 'image', attachment: ref });
                break;
            }
            /* v8 ignore start -- the validation pass above rejects both tags before reconstruction. */
            case 'audio':
            case 'resource':
                break;
            /* v8 ignore stop */
            /* v8 ignore next 2 -- validated by the first closed-union switch. */
            default:
                break;
        }
    }
    flushText();
    if (!content.some(block => block.type === 'image' || (block.type === 'text' && block.text.trim().length > 0))) {
        throw new AcpContentError('empty prompt', 'invalid');
    }
    return content;
}
/**
 * Translate one committed assistant block to ACP wire content.
 * Images are re-read and integrity-verified before inline base64 delivery;
 * unsupported core output blocks stay off the automation wire.
 * @param ctx - bridge context carrying the authoritative attachment store.
 * @param block - committed core assistant block.
 * @returns ACP text/image content, or undefined for non-output blocks.
 */
export async function assistantBlockToAcp(ctx, block) {
    if (block.type === 'text') {
        return block.text.length === 0 ? undefined : { type: 'text', text: block.text };
    }
    if (block.type !== 'image')
        return undefined;
    const attachments = ctx.get('attachments');
    if (attachments === undefined) {
        throw new AcpContentError('cannot deliver assistant image: no attachment store is mounted', 'internal');
    }
    let stored;
    try {
        stored = await attachments.readImage(block.attachment);
    }
    catch (error) {
        throw new AcpContentError('cannot deliver assistant image: the attachment is unavailable or corrupt', 'internal', { cause: error });
    }
    return {
        type: 'image',
        data: Buffer.from(stored.data).toString('base64'),
        mimeType: stored.ref.mediaType,
    };
}
//# sourceMappingURL=content.js.map