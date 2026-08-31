/** ACP Cordis plugin public entrypoint. */
import type { Context } from '@deepseek-ai/cordis';
import type { ApplyConfig } from './types.js';
export declare const name = "acp";
export declare const inject: string[];
/**
 * Mount the ACP bridge on a composed dsh Cordis context.
 *
 * stdout is reserved for ACP frames. The bridge routes diagnostics through
 * Cordis logging and accepts an optional stream only for embedded hosts/tests.
 */
export declare function apply(ctx: Context, config?: ApplyConfig): void;
export type { ApplyConfig } from './types.js';
