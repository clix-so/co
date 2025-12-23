// @bun
// src/context.ts
class CancellableContext {
  controller;
  deadlineMs;
  error;
  values;
  parent;
  constructor(parent = null, deadline, values) {
    this.parent = parent;
    this.controller = new AbortController;
    this.values = values ?? new Map;
    if (parent) {
      const parentDeadline = parent.deadline();
      if (parentDeadline !== undefined && deadline !== undefined) {
        this.deadlineMs = Math.min(parentDeadline, deadline);
      } else {
        this.deadlineMs = deadline ?? parentDeadline;
      }
      if (!parent.done()) {
        parent.signal.addEventListener("abort", () => {
          if (!this.controller.signal.aborted) {
            this.error = parent.err();
            this.controller.abort();
          }
        }, { once: true });
      } else {
        this.error = parent.err();
        this.controller.abort();
      }
    } else {
      this.deadlineMs = deadline;
    }
  }
  deadline() {
    return this.deadlineMs;
  }
  done() {
    return this.controller.signal.aborted;
  }
  err() {
    return this.error;
  }
  value(key) {
    if (this.values.has(key)) {
      return this.values.get(key);
    }
    if (this.parent) {
      return this.parent.value(key);
    }
    return;
  }
  get signal() {
    return this.controller.signal;
  }
  cancel(err) {
    if (this.controller.signal.aborted)
      return;
    this.error = err;
    this.controller.abort();
  }
  getAllValues() {
    const allValues = new Map;
    if (this.parent) {
      for (const [k, v] of this.parent.getAllValues()) {
        allValues.set(k, v);
      }
    }
    for (const [k, v] of this.values) {
      allValues.set(k, v);
    }
    return allValues;
  }
}

class BackgroundContext {
  static instance = null;
  controller = new AbortController;
  static getInstance() {
    if (!BackgroundContext.instance) {
      BackgroundContext.instance = new BackgroundContext;
    }
    return BackgroundContext.instance;
  }
  deadline() {
    return;
  }
  done() {
    return false;
  }
  err() {
    return;
  }
  value(_key) {
    return;
  }
  get signal() {
    return this.controller.signal;
  }
}

class TodoContext {
  static instance = null;
  controller = new AbortController;
  static getInstance() {
    if (!TodoContext.instance) {
      TodoContext.instance = new TodoContext;
    }
    return TodoContext.instance;
  }
  deadline() {
    return;
  }
  done() {
    return false;
  }
  err() {
    return;
  }
  value(_key) {
    return;
  }
  get signal() {
    return this.controller.signal;
  }
}
var context = {
  background() {
    return BackgroundContext.getInstance();
  },
  todo() {
    return TodoContext.getInstance();
  },
  withCancel(parent) {
    const parentCtx = parent instanceof CancellableContext ? parent : new CancellableContext(null, parent.deadline());
    const ctx = new CancellableContext(parentCtx);
    const cancel = (reason) => {
      ctx.cancel({ type: "cancelled", reason });
    };
    return [ctx, cancel];
  },
  withTimeout(parent, timeoutMs) {
    return context.withDeadline(parent, Date.now() + timeoutMs);
  },
  withDeadline(parent, deadline) {
    const parentCtx = parent instanceof CancellableContext ? parent : new CancellableContext(null, parent.deadline());
    const ctx = new CancellableContext(parentCtx, deadline);
    const now = Date.now();
    const effectiveDeadline = ctx.deadline();
    let timeoutId;
    if (effectiveDeadline !== undefined && effectiveDeadline > now) {
      const delay = effectiveDeadline - now;
      timeoutId = setTimeout(() => {
        ctx.cancel({ type: "deadline_exceeded", deadline: effectiveDeadline });
      }, delay);
    } else if (effectiveDeadline !== undefined && effectiveDeadline <= now) {
      ctx.cancel({ type: "deadline_exceeded", deadline: effectiveDeadline });
    }
    const cancel = (reason) => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      ctx.cancel({ type: "cancelled", reason });
    };
    return [ctx, cancel];
  },
  withValue(parent, key, value) {
    const parentCtx = parent instanceof CancellableContext ? parent : new CancellableContext(null, parent.deadline());
    const values = new Map;
    values.set(key, value);
    return new CancellableContext(parentCtx, undefined, values);
  }
};
function isContext(value) {
  return value !== null && typeof value === "object" && "deadline" in value && "done" in value && "err" in value && "value" in value && "signal" in value;
}

// src/error.ts
class CoError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoError";
  }
}

class CancelledError extends CoError {
  reason;
  constructor(taskId, reason) {
    const msg = reason ? `Task ${taskId ?? ""} cancelled: ${reason}`.trim() : taskId ? `Task ${taskId} was cancelled` : "Context cancelled";
    super(msg);
    this.name = "CancelledError";
    this.reason = reason;
  }
}

class DeadlineExceededError extends CoError {
  deadline;
  constructor(deadline, taskId) {
    const msg = taskId ? `Task ${taskId} deadline exceeded at ${new Date(deadline).toISOString()}` : `Context deadline exceeded at ${new Date(deadline).toISOString()}`;
    super(msg);
    this.name = "DeadlineExceededError";
    this.deadline = deadline;
  }
}

class TimeoutError extends CoError {
  constructor(taskId, timeoutMs) {
    const msg = timeoutMs ? `Task ${taskId} timed out after ${timeoutMs}ms` : `Task ${taskId ?? ""} timed out`;
    super(msg);
    this.name = "TimeoutError";
  }
}
function contextErrorToError(ctxErr, taskId) {
  if (ctxErr.type === "cancelled") {
    return new CancelledError(taskId, ctxErr.reason);
  } else {
    return new DeadlineExceededError(ctxErr.deadline, taskId);
  }
}

class QueueFullError extends CoError {
  constructor(maxQueue) {
    super(`Task queue is full (max: ${maxQueue})`);
    this.name = "QueueFullError";
  }
}

class ShutdownError extends CoError {
  constructor() {
    super("Worker pool is shutting down");
    this.name = "ShutdownError";
  }
}

class RuntimeError extends CoError {
  constructor() {
    super("Co requires Bun runtime");
    this.name = "RuntimeError";
  }
}
function deserializeError(serialized) {
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

// src/workerScript.ts
function workerMain() {
  const inflight = new Map;
  function serializeError(error) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause ? serializeError(error.cause) : undefined
      };
    }
    return { name: "Error", message: String(error) };
  }
  self.onmessage = async (event) => {
    const message = event.data;
    if (message.type === "run") {
      const { id, fnSource, args, timeoutMs } = message;
      const controller = new AbortController;
      inflight.set(id, controller);
      try {
        const fn = new Function(`return (${fnSource})`)();
        let timeoutId;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            controller.abort(new Error("Timeout"));
          }, timeoutMs);
        }
        const result = await fn(...args);
        if (timeoutId)
          clearTimeout(timeoutId);
        if (controller.signal.aborted) {
          throw controller.signal.reason || new Error("Cancelled");
        }
        self.postMessage({ type: "ok", id, value: result });
      } catch (error) {
        self.postMessage({ type: "err", id, error: serializeError(error) });
      } finally {
        inflight.delete(id);
      }
    } else if (message.type === "cancel") {
      const { id } = message;
      const controller = inflight.get(id);
      if (controller) {
        controller.abort(new Error("Cancelled"));
      }
    }
  };
  self.postMessage({ type: "ready" });
}
var WORKER_SCRIPT = `(${workerMain.toString()})();`;
var workerBlobUrl = null;
function getWorkerBlobUrl() {
  if (workerBlobUrl === null) {
    const blob = new Blob([WORKER_SCRIPT], { type: "application/javascript" });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}
function revokeWorkerBlobUrl() {
  if (workerBlobUrl !== null) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
  }
}

// src/pool.ts
var DEFAULT_CONFIG = {
  poolSize: Math.max(1, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) - 1),
  maxQueue: 1000,
  idleTerminateMs: 30000
};

class WorkerPool {
  config;
  workers = [];
  pendingQueue = [];
  inflightTasks = new Map;
  isShuttingDown = false;
  idleTimers = new Map;
  constructor(initialConfig) {
    this.config = { ...DEFAULT_CONFIG, ...initialConfig };
  }
  stats() {
    const idle = this.workers.filter((w) => w.state === "idle").length;
    const busy = this.workers.filter((w) => w.state === "busy").length;
    return {
      workers: this.workers.length,
      idle,
      busy,
      queued: this.pendingQueue.length
    };
  }
  configure(options) {
    if (this.isShuttingDown) {
      throw new ShutdownError;
    }
    if (options.poolSize !== undefined) {
      this.config.poolSize = Math.max(1, options.poolSize);
    }
    if (options.maxQueue !== undefined) {
      this.config.maxQueue = Math.max(0, options.maxQueue);
    }
    if (options.idleTerminateMs !== undefined) {
      this.config.idleTerminateMs = Math.max(0, options.idleTerminateMs);
    }
  }
  submit(id, fnSource, args, options) {
    if (this.isShuttingDown) {
      return Promise.reject(new ShutdownError);
    }
    if (this.pendingQueue.length >= this.config.maxQueue) {
      return Promise.reject(new QueueFullError(this.config.maxQueue));
    }
    return new Promise((resolve, reject) => {
      const task = {
        id,
        fnSource,
        args,
        options,
        resolve,
        reject
      };
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        task.timeoutId = setTimeout(() => {
          this.cancelTask(id, new TimeoutError(id, options.timeoutMs));
        }, options.timeoutMs);
      }
      if (options.signal) {
        if (options.signal.aborted) {
          reject(new CancelledError(id));
          return;
        }
        options.signal.addEventListener("abort", () => {
          this.cancelTask(id, new CancelledError(id));
        }, { once: true });
      }
      this.dispatchOrQueue(task);
    });
  }
  cancelTask(id, error) {
    const cancelError = error || new CancelledError(id);
    const pendingIndex = this.pendingQueue.findIndex((t) => t.id === id);
    if (pendingIndex !== -1) {
      const task = this.pendingQueue.splice(pendingIndex, 1)[0];
      if (task) {
        if (task.timeoutId)
          clearTimeout(task.timeoutId);
        task.reject(cancelError);
      }
      return;
    }
    const inflight = this.inflightTasks.get(id);
    if (inflight) {
      const message = { type: "cancel", id };
      inflight.worker.worker.postMessage(message);
      if (inflight.timeoutId)
        clearTimeout(inflight.timeoutId);
      inflight.reject(cancelError);
      this.inflightTasks.delete(id);
      this.markWorkerIdle(inflight.worker);
    }
  }
  async shutdown(options) {
    if (this.isShuttingDown)
      return;
    this.isShuttingDown = true;
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    for (const task of this.pendingQueue) {
      if (task.timeoutId)
        clearTimeout(task.timeoutId);
      task.reject(new ShutdownError);
    }
    this.pendingQueue = [];
    if (options?.force) {
      for (const inflight of this.inflightTasks.values()) {
        if (inflight.timeoutId)
          clearTimeout(inflight.timeoutId);
        inflight.reject(new ShutdownError);
      }
      this.inflightTasks.clear();
      for (const poolWorker of this.workers) {
        poolWorker.worker.terminate();
      }
      this.workers = [];
    } else {
      if (this.inflightTasks.size > 0) {
        await Promise.allSettled(Array.from(this.inflightTasks.values()).map((t) => new Promise((resolve) => {
          const originalResolve = t.resolve;
          const originalReject = t.reject;
          t.resolve = (v) => {
            originalResolve(v);
            resolve();
          };
          t.reject = (e) => {
            originalReject(e);
            resolve();
          };
        })));
      }
      for (const poolWorker of this.workers) {
        poolWorker.worker.terminate();
      }
      this.workers = [];
    }
    revokeWorkerBlobUrl();
  }
  dispatchOrQueue(task) {
    const idleWorker = this.workers.find((w) => w.state === "idle");
    if (idleWorker) {
      this.dispatchToWorker(task, idleWorker);
    } else if (this.workers.length < this.config.poolSize) {
      const newWorker = this.createWorker();
      this.workers.push(newWorker);
      this.pendingQueue.push(task);
    } else {
      this.pendingQueue.push(task);
    }
  }
  dispatchToWorker(task, poolWorker) {
    const idleTimer = this.idleTimers.get(poolWorker);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(poolWorker);
    }
    poolWorker.state = "busy";
    poolWorker.currentTaskId = task.id;
    const inflightTask = {
      ...task,
      worker: poolWorker
    };
    this.inflightTasks.set(task.id, inflightTask);
    const pendingIndex = this.pendingQueue.findIndex((t) => t.id === task.id);
    if (pendingIndex !== -1) {
      this.pendingQueue.splice(pendingIndex, 1);
    }
    const message = {
      type: "run",
      id: task.id,
      fnSource: task.fnSource,
      args: task.args,
      timeoutMs: task.options.timeoutMs
    };
    try {
      poolWorker.worker.postMessage(message, task.options.transfer || []);
    } catch (error) {
      if (task.timeoutId)
        clearTimeout(task.timeoutId);
      task.reject(error instanceof Error ? error : new Error(String(error)));
      this.inflightTasks.delete(task.id);
      this.markWorkerIdle(poolWorker);
    }
  }
  createWorker() {
    const blobUrl = getWorkerBlobUrl();
    const worker = new Worker(blobUrl);
    const poolWorker = {
      worker,
      state: "starting",
      currentTaskId: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };
    worker.onmessage = (event) => {
      this.handleWorkerMessage(poolWorker, event.data);
    };
    worker.onerror = (error) => {
      console.error("[co] Worker error:", error);
      this.handleWorkerError(poolWorker, error);
    };
    return poolWorker;
  }
  handleWorkerMessage(poolWorker, message) {
    if (message.type === "ready") {
      poolWorker.state = "idle";
      this.processQueue();
    } else if (message.type === "ok") {
      const { id, value } = message;
      const inflight = this.inflightTasks.get(id);
      if (inflight) {
        if (inflight.timeoutId)
          clearTimeout(inflight.timeoutId);
        inflight.resolve(value);
        this.inflightTasks.delete(id);
      }
      this.markWorkerIdle(poolWorker);
    } else if (message.type === "err") {
      const { id, error } = message;
      const inflight = this.inflightTasks.get(id);
      if (inflight) {
        if (inflight.timeoutId)
          clearTimeout(inflight.timeoutId);
        inflight.reject(deserializeError(error));
        this.inflightTasks.delete(id);
      }
      this.markWorkerIdle(poolWorker);
    }
  }
  handleWorkerError(poolWorker, error) {
    if (poolWorker.currentTaskId) {
      const inflight = this.inflightTasks.get(poolWorker.currentTaskId);
      if (inflight) {
        if (inflight.timeoutId)
          clearTimeout(inflight.timeoutId);
        inflight.reject(new Error(`Worker error: ${error.message}`));
        this.inflightTasks.delete(poolWorker.currentTaskId);
      }
    }
    const index = this.workers.indexOf(poolWorker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    if (!this.isShuttingDown) {
      const newWorker = this.createWorker();
      this.workers.push(newWorker);
    }
  }
  markWorkerIdle(poolWorker) {
    poolWorker.state = "idle";
    poolWorker.currentTaskId = null;
    poolWorker.lastActiveAt = Date.now();
    this.processQueue();
    if (poolWorker.state === "idle" && this.workers.length > 1 && this.config.idleTerminateMs > 0) {
      const timer = setTimeout(() => {
        this.terminateIdleWorker(poolWorker);
      }, this.config.idleTerminateMs);
      this.idleTimers.set(poolWorker, timer);
    }
  }
  terminateIdleWorker(poolWorker) {
    if (poolWorker.state !== "idle")
      return;
    if (this.workers.length <= 1)
      return;
    poolWorker.state = "terminating";
    poolWorker.worker.terminate();
    const index = this.workers.indexOf(poolWorker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    this.idleTimers.delete(poolWorker);
  }
  processQueue() {
    while (this.pendingQueue.length > 0) {
      const idleWorker = this.workers.find((w) => w.state === "idle");
      if (!idleWorker)
        break;
      const task = this.pendingQueue.shift();
      if (task) {
        this.dispatchToWorker(task, idleWorker);
      }
    }
  }
}

// src/co.ts
function assertBunRuntime() {
  if (typeof Bun === "undefined") {
    throw new RuntimeError;
  }
}
function generateTaskId() {
  return crypto.randomUUID();
}
function serializeFunction(fn) {
  return fn.toString();
}
var poolInstance = null;
function getPool() {
  assertBunRuntime();
  if (poolInstance === null) {
    poolInstance = new WorkerPool;
  }
  return poolInstance;
}
function executeTaskWithContext(ctx, fn, args) {
  const pool = getPool();
  const id = generateTaskId();
  if (ctx.done()) {
    const err = ctx.err();
    const error = err ? contextErrorToError(err, id) : new CancelledError(id);
    return {
      id,
      promise: Promise.reject(error),
      cancel: () => {}
    };
  }
  const fnSource = serializeFunction(fn);
  const deadline = ctx.deadline();
  const timeoutMs = deadline !== undefined ? Math.max(0, deadline - Date.now()) : undefined;
  const options = { timeoutMs };
  const promise = pool.submit(id, fnSource, args, options);
  if (!ctx.signal.aborted) {
    ctx.signal.addEventListener("abort", () => {
      const err = ctx.err();
      const error = err ? contextErrorToError(err, id) : new CancelledError(id);
      pool.cancelTask(id, error);
    }, { once: true });
  }
  const cancel = (reason) => {
    const err = ctx.err();
    const error = err ? contextErrorToError(err, id) : new CancelledError(id, reason);
    pool.cancelTask(id, error);
  };
  return { id, promise, cancel };
}
function executeTask(fn, args) {
  const pool = getPool();
  const id = generateTaskId();
  const fnSource = serializeFunction(fn);
  const promise = pool.submit(id, fnSource, args, {});
  const cancel = (reason) => {
    pool.cancelTask(id, new CancelledError(id, reason));
  };
  return { id, promise, cancel };
}
function createPoolManager() {
  return {
    configure(options) {
      getPool().configure(options);
    },
    async shutdown(options) {
      if (poolInstance) {
        await poolInstance.shutdown(options);
        poolInstance = null;
      }
    },
    stats() {
      return getPool().stats();
    }
  };
}
function createCo() {
  const poolManager = createPoolManager();
  const coFn = (ctxOrFn, fnOrFirstArg, ...restArgs) => {
    if (isContext(ctxOrFn)) {
      const ctx = ctxOrFn;
      const fn = fnOrFirstArg;
      const args = restArgs;
      return executeTaskWithContext(ctx, fn, args);
    } else {
      const fn = ctxOrFn;
      const args = fnOrFirstArg !== undefined ? [fnOrFirstArg, ...restArgs] : [];
      return executeTask(fn, args);
    }
  };
  const promiseFn = (ctxOrFn, fnOrFirstArg, ...restArgs) => {
    if (isContext(ctxOrFn)) {
      const ctx = ctxOrFn;
      const fn = fnOrFirstArg;
      const args = restArgs;
      return executeTaskWithContext(ctx, fn, args).promise;
    } else {
      const fn = ctxOrFn;
      const args = fnOrFirstArg !== undefined ? [fnOrFirstArg, ...restArgs] : [];
      return executeTask(fn, args).promise;
    }
  };
  coFn.promise = promiseFn;
  Object.defineProperty(coFn, "pool", {
    value: poolManager,
    writable: false,
    enumerable: true,
    configurable: false
  });
  return coFn;
}
var co = createCo();
export {
  context,
  co,
  TimeoutError,
  ShutdownError,
  RuntimeError,
  QueueFullError,
  DeadlineExceededError,
  CoError,
  CancelledError
};
