/**
 * Context carries deadlines, cancellation signals, and request-scoped values.
 * Inspired by Go's context.Context.
 */
export interface Context {
  /** Returns the deadline time (ms since epoch), or undefined if no deadline */
  deadline(): number | undefined;

  /** Returns true if the context has been cancelled or timed out */
  done(): boolean;

  /** Returns the reason for cancellation, or undefined if not cancelled */
  err(): ContextError | undefined;

  /** Returns a value from the context by key */
  value<T>(key: ContextKey<T>): T | undefined;

  /** The underlying AbortSignal for interop with Web APIs */
  readonly signal: AbortSignal;
}

/** Key type for context values (branded symbol for type safety) */
export type ContextKey<T> = symbol & { __type?: T };

/** Function to cancel a context */
export type CancelFunc = (reason?: string) => void;

/** Context-related errors */
export type ContextError =
  | { type: "cancelled"; reason?: string }
  | { type: "deadline_exceeded"; deadline: number };

/** Context factory functions */
export interface ContextFactory {
  /** Creates a root context that is never cancelled */
  background(): Context;

  /** Creates a root context for operations where context is not yet determined */
  todo(): Context;

  /** Creates a child context that can be manually cancelled */
  withCancel(parent: Context): [Context, CancelFunc];

  /** Creates a child context that cancels after the duration (ms) */
  withTimeout(parent: Context, timeoutMs: number): [Context, CancelFunc];

  /** Creates a child context that cancels at the deadline (ms since epoch) */
  withDeadline(parent: Context, deadline: number): [Context, CancelFunc];

  /** Creates a child context with an attached value */
  withValue<T>(parent: Context, key: ContextKey<T>, value: T): Context;
}

/** Function that receives context as first parameter. */
export type ContextFn<T, A extends unknown[]> = (
  ctx: Context,
  ...args: A
) => T | Promise<T>;

/** Function without context. */
export type CoFn<T, A extends unknown[]> = (...args: A) => T | Promise<T>;

/** Handle returned from co() calls. */
export type CoHandle<T> = {
  /** Unique task identifier */
  readonly id: string;
  /** Promise that resolves with the result */
  readonly promise: Promise<T>;
  /** Cancel the task */
  cancel: (reason?: string) => void;
};

/** Pool configuration. */
export type CoConfig = {
  poolSize: number;
  maxQueue: number;
  idleTerminateMs: number;
};

/** Pool statistics */
export type PoolStats = {
  workers: number;
  idle: number;
  busy: number;
  queued: number;
};

/** Pool manager interface */
export interface PoolManager {
  /** Configure pool settings */
  configure(options: Partial<CoConfig>): void;
  /** Shutdown the pool */
  shutdown(options?: { force?: boolean }): Promise<void>;
  /** Get current pool statistics */
  stats(): PoolStats;
}

/** Main co interface. */
export interface Co {
  <T, A extends unknown[]>(
    ctx: Context,
    fn: ContextFn<T, A>,
    ...args: A
  ): CoHandle<T>;

  <T, A extends unknown[]>(fn: CoFn<T, A>, ...args: A): CoHandle<T>;

  /** Shorthand to get just the promise */
  promise: {
    <T, A extends unknown[]>(
      ctx: Context,
      fn: ContextFn<T, A>,
      ...args: A
    ): Promise<T>;
    <T, A extends unknown[]>(fn: CoFn<T, A>, ...args: A): Promise<T>;
  };

  /** Pool management */
  readonly pool: PoolManager;
}

export type RunMessage = {
  type: "run";
  id: string;
  fnSource: string;
  args: unknown[];
  timeoutMs?: number;
  contextValues?: Array<[symbol, unknown]>;
};

export type CancelMessage = {
  type: "cancel";
  id: string;
};

export type MainToWorkerMessage = RunMessage | CancelMessage;

export type ReadyMessage = {
  type: "ready";
};

export type OkMessage = {
  type: "ok";
  id: string;
  value: unknown;
};

export type ErrMessage = {
  type: "err";
  id: string;
  error: SerializedError;
};

export type WorkerToMainMessage = ReadyMessage | OkMessage | ErrMessage;

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
};

export type WorkerState = "starting" | "idle" | "busy" | "terminating";

export type PoolWorker = {
  worker: Worker;
  state: WorkerState;
  currentTaskId: string | null;
  createdAt: number;
  lastActiveAt: number;
};

export type TaskOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  transfer?: Transferable[];
};

export type PendingTask = {
  id: string;
  fnSource: string;
  args: unknown[];
  options: TaskOptions;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

export type InflightTask = PendingTask & {
  worker: PoolWorker;
};
