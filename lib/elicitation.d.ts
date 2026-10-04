/** Stable ACP elicitation bridge for dsh's scoped user-question waterfall. */
import type { AgentContext } from '@agentclientprotocol/sdk';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
interface ElicitationBridgeOptions {
    connection(): AgentContext;
    supportsForm(): boolean;
}
/** Translate one dsh user-question request into a stable ACP form elicitation. */
export declare function askViaAcp(options: ElicitationBridgeOptions, request: AskUserQuestionRequest, sessionId: SessionId): Promise<AskUserQuestionAnswer>;
export {};
