/** ACP Cordis plugin public entrypoint. */
import type { Context } from '@deepseek-ai/cordis'
import { createAcpBridge } from './bridge.js'
import type { ApplyConfig } from './types.js'

export const name = 'acp'
export const inject = ['agents', 'agentDefaultModel']

/**
 * Mount the ACP bridge on a composed dsh Cordis context.
 *
 * stdout is reserved for ACP frames. The bridge routes diagnostics through
 * Cordis logging and accepts an optional stream only for embedded hosts/tests.
 */
export function apply(ctx: Context, config: ApplyConfig = {}): void {
  createAcpBridge(ctx, config)
}

export type { ApplyConfig } from './types.js'
