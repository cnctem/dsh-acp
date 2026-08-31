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
import type { Context } from '@deepseek-ai/cordis';
import type { ApplyConfig } from './types.js';
/**
 * Mount the automation-only ACP server.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context carrying the agent factory and session events.
 * @param {{provider?: string, model?: string}} config - Initial provider/model selection.
 */
export declare function createAcpBridge(ctx: Context, config?: ApplyConfig): void;
