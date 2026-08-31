import { createAcpBridge } from './bridge.js';
export const name = 'acp';
export const inject = ['agents', 'agentDefaultModel'];
/**
 * Mount the ACP bridge on a composed dsh Cordis context.
 *
 * stdout is reserved for ACP frames. The bridge routes diagnostics through
 * Cordis logging and accepts an optional stream only for embedded hosts/tests.
 */
export function apply(ctx, config = {}) {
    createAcpBridge(ctx, config);
}
//# sourceMappingURL=index.js.map