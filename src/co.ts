import { context, isContext } from "./context.ts";
import { CancelledError, contextErrorToError, RuntimeError } from "./error.ts";
import { WorkerPool } from "./pool.ts";
import type {
  Co,
  CoConfig,
  CoFn,
  CoHandle,
  Context,
  ContextFn,
  PoolManager,
  PoolStats,
  TaskOptions,
} from "./types.ts";

function assertBunRuntime(): void {
  if (typeof Bun === "undefined") {
    throw new RuntimeError();
  }
}

function generateTaskId(): string {
  return crypto.randomUUID();
}

function serializeFunction(fn: Function): string {
  return fn.toString();
}

let poolInstance: WorkerPool | null = null;

function getPool(): WorkerPool {
  assertBunRuntime();
  if (poolInstance === null) {
    poolInstance = new WorkerPool();
  }
  return poolInstance;
}

function executeTaskWithContext<T, A extends unknown[]>(
  ctx: Context,
  fn: ContextFn<T, A> | CoFn<T, A>,
  args: A,
): CoHandle<T> {
  const pool = getPool();
  const id = generateTaskId();

  if (ctx.done()) {
    const err = ctx.err();
    const error = err ? contextErrorToError(err, id) : new CancelledError(id);
    return {
      id,
      promise: Promise.reject(error),
      cancel: () => {},
    };
  }

  const fnSource = serializeFunction(fn);
  const deadline = ctx.deadline();
  const timeoutMs =
    deadline !== undefined ? Math.max(0, deadline - Date.now()) : undefined;

  const options: TaskOptions = { timeoutMs };
  const promise = pool.submit<T>(id, fnSource, args, options);

  if (!ctx.signal.aborted) {
    ctx.signal.addEventListener(
      "abort",
      () => {
        const err = ctx.err();
        const error = err
          ? contextErrorToError(err, id)
          : new CancelledError(id);
        pool.cancelTask(id, error);
      },
      { once: true },
    );
  }

  const cancel = (reason?: string) => {
    const err = ctx.err();
    const error = err
      ? contextErrorToError(err, id)
      : new CancelledError(id, reason);
    pool.cancelTask(id, error);
  };

  return { id, promise, cancel };
}

function executeTask<T, A extends unknown[]>(
  fn: CoFn<T, A>,
  args: A,
): CoHandle<T> {
  const pool = getPool();
  const id = generateTaskId();
  const fnSource = serializeFunction(fn);
  const promise = pool.submit<T>(id, fnSource, args, {});

  const cancel = (reason?: string) => {
    pool.cancelTask(id, new CancelledError(id, reason));
  };

  return { id, promise, cancel };
}

function createPoolManager(): PoolManager {
  return {
    configure(options: Partial<CoConfig>): void {
      getPool().configure(options);
    },

    async shutdown(options?: { force?: boolean }): Promise<void> {
      if (poolInstance) {
        await poolInstance.shutdown(options);
        poolInstance = null;
      }
    },

    stats(): PoolStats {
      return getPool().stats();
    },
  };
}

function createCo(): Co {
  const poolManager = createPoolManager();

  const coFn = <T, A extends unknown[]>(
    ctxOrFn: Context | CoFn<T, A> | ContextFn<T, A>,
    fnOrFirstArg?: ContextFn<T, A> | A[0],
    ...restArgs: unknown[]
  ): CoHandle<T> => {
    if (isContext(ctxOrFn)) {
      const ctx = ctxOrFn;
      const fn = fnOrFirstArg as ContextFn<T, A>;
      const args = restArgs as unknown as A;
      return executeTaskWithContext(ctx, fn, args);
    } else {
      const fn = ctxOrFn as CoFn<T, A>;
      const args = (fnOrFirstArg !== undefined
        ? [fnOrFirstArg, ...restArgs]
        : []) as unknown as A;
      return executeTask(fn, args);
    }
  };

  const promiseFn = <T, A extends unknown[]>(
    ctxOrFn: Context | CoFn<T, A> | ContextFn<T, A>,
    fnOrFirstArg?: ContextFn<T, A> | A[0],
    ...restArgs: unknown[]
  ): Promise<T> => {
    if (isContext(ctxOrFn)) {
      const ctx = ctxOrFn;
      const fn = fnOrFirstArg as ContextFn<T, A>;
      const args = restArgs as unknown as A;
      return executeTaskWithContext(ctx, fn, args).promise;
    } else {
      const fn = ctxOrFn as CoFn<T, A>;
      const args = (fnOrFirstArg !== undefined
        ? [fnOrFirstArg, ...restArgs]
        : []) as unknown as A;
      return executeTask(fn, args).promise;
    }
  };

  (coFn as Co).promise = promiseFn as Co["promise"];
  Object.defineProperty(coFn, "pool", {
    value: poolManager,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  return coFn as Co;
}

export const co = createCo();
export { context };
