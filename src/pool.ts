import {
  CancelledError,
  deserializeError,
  QueueFullError,
  ShutdownError,
  TimeoutError,
} from "./error.ts";
import type {
  CoConfig,
  InflightTask,
  MainToWorkerMessage,
  PendingTask,
  PoolStats,
  PoolWorker,
  TaskOptions,
  WorkerToMainMessage,
} from "./types.ts";
import { getWorkerBlobUrl, revokeWorkerBlobUrl } from "./workerScript.ts";

const DEFAULT_CONFIG: CoConfig = {
  poolSize: Math.max(
    1,
    (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) - 1,
  ),
  maxQueue: 1000,
  idleTerminateMs: 30000,
};

export class WorkerPool {
  private config: CoConfig;
  private workers: PoolWorker[] = [];
  private pendingQueue: PendingTask[] = [];
  private inflightTasks: Map<string, InflightTask> = new Map();
  private isShuttingDown = false;
  private idleTimers: Map<PoolWorker, ReturnType<typeof setTimeout>> =
    new Map();

  constructor(initialConfig?: Partial<CoConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...initialConfig };
  }

  stats(): PoolStats {
    const idle = this.workers.filter((w) => w.state === "idle").length;
    const busy = this.workers.filter((w) => w.state === "busy").length;
    return {
      workers: this.workers.length,
      idle,
      busy,
      queued: this.pendingQueue.length,
    };
  }

  configure(options: Partial<CoConfig>): void {
    if (this.isShuttingDown) {
      throw new ShutdownError();
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

  submit<T>(
    id: string,
    fnSource: string,
    args: unknown[],
    options: TaskOptions,
  ): Promise<T> {
    if (this.isShuttingDown) {
      return Promise.reject(new ShutdownError());
    }
    if (this.pendingQueue.length >= this.config.maxQueue) {
      return Promise.reject(new QueueFullError(this.config.maxQueue));
    }

    return new Promise<T>((resolve, reject) => {
      const task: PendingTask = {
        id,
        fnSource,
        args,
        options,
        resolve: resolve as (value: unknown) => void,
        reject,
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
        options.signal.addEventListener(
          "abort",
          () => {
            this.cancelTask(id, new CancelledError(id));
          },
          { once: true },
        );
      }

      this.dispatchOrQueue(task);
    });
  }

  cancelTask(id: string, error?: Error): void {
    const cancelError = error || new CancelledError(id);

    const pendingIndex = this.pendingQueue.findIndex((t) => t.id === id);
    if (pendingIndex !== -1) {
      const task = this.pendingQueue.splice(pendingIndex, 1)[0];
      if (task) {
        if (task.timeoutId) clearTimeout(task.timeoutId);
        task.reject(cancelError);
      }
      return;
    }

    const inflight = this.inflightTasks.get(id);
    if (inflight) {
      const message: MainToWorkerMessage = { type: "cancel", id };
      inflight.worker.worker.postMessage(message);
      if (inflight.timeoutId) clearTimeout(inflight.timeoutId);
      inflight.reject(cancelError);
      this.inflightTasks.delete(id);
      this.markWorkerIdle(inflight.worker);
    }
  }

  async shutdown(options?: { force?: boolean }): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    for (const task of this.pendingQueue) {
      if (task.timeoutId) clearTimeout(task.timeoutId);
      task.reject(new ShutdownError());
    }
    this.pendingQueue = [];

    if (options?.force) {
      for (const inflight of this.inflightTasks.values()) {
        if (inflight.timeoutId) clearTimeout(inflight.timeoutId);
        inflight.reject(new ShutdownError());
      }
      this.inflightTasks.clear();

      for (const poolWorker of this.workers) {
        poolWorker.worker.terminate();
      }
      this.workers = [];
    } else {
      if (this.inflightTasks.size > 0) {
        await Promise.allSettled(
          Array.from(this.inflightTasks.values()).map(
            (t) =>
              new Promise<void>((resolve) => {
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
              }),
          ),
        );
      }

      for (const poolWorker of this.workers) {
        poolWorker.worker.terminate();
      }
      this.workers = [];
    }

    revokeWorkerBlobUrl();
  }

  private dispatchOrQueue(task: PendingTask): void {
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

  private dispatchToWorker(task: PendingTask, poolWorker: PoolWorker): void {
    const idleTimer = this.idleTimers.get(poolWorker);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(poolWorker);
    }

    poolWorker.state = "busy";
    poolWorker.currentTaskId = task.id;

    const inflightTask: InflightTask = {
      ...task,
      worker: poolWorker,
    };
    this.inflightTasks.set(task.id, inflightTask);

    const pendingIndex = this.pendingQueue.findIndex((t) => t.id === task.id);
    if (pendingIndex !== -1) {
      this.pendingQueue.splice(pendingIndex, 1);
    }

    const message: MainToWorkerMessage = {
      type: "run",
      id: task.id,
      fnSource: task.fnSource,
      args: task.args,
      timeoutMs: task.options.timeoutMs,
    };

    try {
      poolWorker.worker.postMessage(message, task.options.transfer || []);
    } catch (error) {
      if (task.timeoutId) clearTimeout(task.timeoutId);
      task.reject(error instanceof Error ? error : new Error(String(error)));
      this.inflightTasks.delete(task.id);
      this.markWorkerIdle(poolWorker);
    }
  }

  private createWorker(): PoolWorker {
    const blobUrl = getWorkerBlobUrl();
    const worker = new Worker(blobUrl);

    const poolWorker: PoolWorker = {
      worker,
      state: "starting",
      currentTaskId: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      this.handleWorkerMessage(poolWorker, event.data);
    };

    worker.onerror = (error) => {
      console.error("[co] Worker error:", error);
      this.handleWorkerError(poolWorker, error);
    };

    return poolWorker;
  }

  private handleWorkerMessage(
    poolWorker: PoolWorker,
    message: WorkerToMainMessage,
  ): void {
    if (message.type === "ready") {
      poolWorker.state = "idle";
      this.processQueue();
    } else if (message.type === "ok") {
      const { id, value } = message;
      const inflight = this.inflightTasks.get(id);
      if (inflight) {
        if (inflight.timeoutId) clearTimeout(inflight.timeoutId);
        inflight.resolve(value);
        this.inflightTasks.delete(id);
      }
      this.markWorkerIdle(poolWorker);
    } else if (message.type === "err") {
      const { id, error } = message;
      const inflight = this.inflightTasks.get(id);
      if (inflight) {
        if (inflight.timeoutId) clearTimeout(inflight.timeoutId);
        inflight.reject(deserializeError(error));
        this.inflightTasks.delete(id);
      }
      this.markWorkerIdle(poolWorker);
    }
  }

  private handleWorkerError(poolWorker: PoolWorker, error: ErrorEvent): void {
    if (poolWorker.currentTaskId) {
      const inflight = this.inflightTasks.get(poolWorker.currentTaskId);
      if (inflight) {
        if (inflight.timeoutId) clearTimeout(inflight.timeoutId);
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

  private markWorkerIdle(poolWorker: PoolWorker): void {
    poolWorker.state = "idle";
    poolWorker.currentTaskId = null;
    poolWorker.lastActiveAt = Date.now();

    this.processQueue();

    if (
      poolWorker.state === "idle" &&
      this.workers.length > 1 &&
      this.config.idleTerminateMs > 0
    ) {
      const timer = setTimeout(() => {
        this.terminateIdleWorker(poolWorker);
      }, this.config.idleTerminateMs);
      this.idleTimers.set(poolWorker, timer);
    }
  }

  private terminateIdleWorker(poolWorker: PoolWorker): void {
    if (poolWorker.state !== "idle") return;
    if (this.workers.length <= 1) return;

    poolWorker.state = "terminating";
    poolWorker.worker.terminate();

    const index = this.workers.indexOf(poolWorker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    this.idleTimers.delete(poolWorker);
  }

  private processQueue(): void {
    while (this.pendingQueue.length > 0) {
      const idleWorker = this.workers.find((w) => w.state === "idle");
      if (!idleWorker) break;

      const task = this.pendingQueue.shift();
      if (task) {
        this.dispatchToWorker(task, idleWorker);
      }
    }
  }
}
