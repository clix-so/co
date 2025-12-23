import type { ContextError, SerializedError } from "./types.ts";

/** Base error class for all Co errors. */
export class CoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoError";
  }
}

/** Thrown when a task or context is cancelled. */
export class CancelledError extends CoError {
  readonly reason?: string;

  constructor(taskId?: string, reason?: string) {
    const msg = reason
      ? `Task ${taskId ?? ""} cancelled: ${reason}`.trim()
      : taskId
        ? `Task ${taskId} was cancelled`
        : "Context cancelled";
    super(msg);
    this.name = "CancelledError";
    this.reason = reason;
  }
}

/** Thrown when a context deadline is exceeded. */
export class DeadlineExceededError extends CoError {
  readonly deadline: number;

  constructor(deadline: number, taskId?: string) {
    const msg = taskId
      ? `Task ${taskId} deadline exceeded at ${new Date(deadline).toISOString()}`
      : `Context deadline exceeded at ${new Date(deadline).toISOString()}`;
    super(msg);
    this.name = "DeadlineExceededError";
    this.deadline = deadline;
  }
}

/** Thrown when a task times out. */
export class TimeoutError extends CoError {
  constructor(taskId?: string, timeoutMs?: number) {
    const msg = timeoutMs
      ? `Task ${taskId} timed out after ${timeoutMs}ms`
      : `Task ${taskId ?? ""} timed out`;
    super(msg);
    this.name = "TimeoutError";
  }
}

export function contextErrorToError(
  ctxErr: ContextError,
  taskId?: string,
): Error {
  if (ctxErr.type === "cancelled") {
    return new CancelledError(taskId, ctxErr.reason);
  } else {
    return new DeadlineExceededError(ctxErr.deadline, taskId);
  }
}

/** Thrown when the task queue is at capacity. */
export class QueueFullError extends CoError {
  constructor(maxQueue: number) {
    super(`Task queue is full (max: ${maxQueue})`);
    this.name = "QueueFullError";
  }
}

/** Thrown when attempting to submit tasks after pool shutdown. */
export class ShutdownError extends CoError {
  constructor() {
    super("Worker pool is shutting down");
    this.name = "ShutdownError";
  }
}

/** Thrown when running outside of Bun runtime. */
export class RuntimeError extends CoError {
  constructor() {
    super("Co requires Bun runtime");
    this.name = "RuntimeError";
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause ? serializeError(error.cause) : undefined,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
  if (serialized.cause) {
    error.cause = deserializeError(serialized.cause);
  }
  return error;
}
