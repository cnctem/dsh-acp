/**
 * Editor-enhanced Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge implements the standard automation surface and adds the plan,
 * command, elicitation, diff, terminal, usage, and replay behavior used by Zed.
 *
 * @module @cnctem/dsh-acp
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type Stream } from '@agentclientprotocol/sdk';
export declare const name = "acp";
/** Core services required by the standard automation controls. */
export declare const inject: string[];
/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
    /** Provider route for created agents. */
    provider?: string;
    /** Model name for created agents. */
    model?: string;
    /** Deployment-selected preset mounted for each new session. */
    preset?: string;
    /** Maximum summaries returned by one session/list page. */
    sessionListPageSize?: number;
    /** Runtime-only transport override; production uses stdio. */
    stream?: Stream;
}
export declare const Config: Schema<AcpConfig>;
/**
 * Mount the editor-enhanced ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
export declare function apply(ctx: Context, config?: AcpConfig): void;
