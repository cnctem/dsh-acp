import type { Agent as AcpAgent, AgentSideConnection, ClientCapabilities, Stream } from '@agentclientprotocol/sdk';
import type { Agent as DshAgent, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session';
export interface ApplyConfig {
    provider?: string;
    model?: string;
    preset?: string;
    stream?: Stream;
}
export interface BridgeLogger {
    debug(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export interface FileSnapshot {
    path: string;
    oldText: string | null;
}
export interface InflightPrompt {
    resolve(reason: import('@agentclientprotocol/sdk').StopReason): void;
    reject(error: unknown): void;
    messageId: string;
    turn?: number;
    endReason?: TurnEndReason;
}
export interface SessionRecord {
    agent: DshAgent;
    cwd: string;
    dispose(): Promise<void>;
    inflight?: InflightPrompt;
    abort?: AbortController;
    streamedSteps: Set<string>;
    questionCallIds: string[];
    planKnown: boolean;
    selectionRef: AcpModelSelectionRef;
    presetId: string;
}
export interface BridgeState {
    sessions: Map<SessionId, SessionRecord>;
    fileSnapshots: Map<string, FileSnapshot>;
    terminalToolCallIds: Set<string>;
    emitChain: Promise<void>;
    closed: boolean;
    connection?: AgentSideConnection;
    clientCapabilities: ClientCapabilities | null;
    quiescing?: Promise<void>;
}
export interface AcpModelSelection extends ModelSelection {
    supportedReasoningEfforts?: readonly ReasoningEffortId[];
}
export interface AcpModelSelectionRef {
    current: AcpModelSelection | undefined;
    assembled: ModelSelection | undefined;
}
export type AcpAgentHandler = AcpAgent;
