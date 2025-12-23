import type { ContextError, SerializedError } from "./types.ts";
/** Base error class for all Co errors. */
export declare class CoError extends Error {
    constructor(message: string);
}
/** Thrown when a task or context is cancelled. */
export declare class CancelledError extends CoError {
    readonly reason?: string;
    constructor(taskId?: string, reason?: string);
}
/** Thrown when a context deadline is exceeded. */
export declare class DeadlineExceededError extends CoError {
    readonly deadline: number;
    constructor(deadline: number, taskId?: string);
}
/** Thrown when a task times out. */
export declare class TimeoutError extends CoError {
    constructor(taskId?: string, timeoutMs?: number);
}
export declare function contextErrorToError(ctxErr: ContextError, taskId?: string): Error;
/** Thrown when the task queue is at capacity. */
export declare class QueueFullError extends CoError {
    constructor(maxQueue: number);
}
/** Thrown when attempting to submit tasks after pool shutdown. */
export declare class ShutdownError extends CoError {
    constructor();
}
/** Thrown when running outside of Bun runtime. */
export declare class RuntimeError extends CoError {
    constructor();
}
export declare function serializeError(error: unknown): SerializedError;
export declare function deserializeError(serialized: SerializedError): Error;
//# sourceMappingURL=error.d.ts.map