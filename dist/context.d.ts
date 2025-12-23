import type { Context, ContextFactory } from "./types.ts";
/**
 * Context factory providing Go-style context creation functions.
 */
export declare const context: ContextFactory;
export declare function isContext(value: unknown): value is Context;
export declare function getContextValues(ctx: Context): Map<symbol, unknown>;
//# sourceMappingURL=context.d.ts.map