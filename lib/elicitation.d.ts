import type { Agent as DshAgent } from '@deepseek-ai/dsh-agent';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
import type { SessionRecord } from './types.js';
interface ElicitationBridgeOptions {
    connection(): AgentSideConnection;
    supportsForm(): boolean;
    ownedRecord(agent: DshAgent): SessionRecord | undefined;
}
export declare function createElicitationProvider(options: ElicitationBridgeOptions): (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>;
export {};
