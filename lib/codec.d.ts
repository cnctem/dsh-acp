/**
 * Pure translation between the harness lifecycle and the ACP wire.
 * @module @cnctem/dsh-acp/codec
 */
import type { StopReason } from '@agentclientprotocol/sdk';
import type { TurnEndReason } from '@deepseek-ai/dsh-session';
/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export declare function turnEndToStopReason(reason: TurnEndReason): StopReason;
