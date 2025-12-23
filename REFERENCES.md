# Co Internal References

Technical documentation for Co's internal architecture and implementation details.

## Table of Contents

- [Architecture](#architecture)
  - [System Overview](#system-overview)
  - [Internal Components](#internal-components)
  - [Memory Model](#memory-model)
  - [Performance Characteristics](#performance-characteristics)
- [Comparison: Bun Workers vs Go Goroutines](#comparison-bun-workers-vs-go-goroutines)
- [Comparison with Go](#comparison-with-go)

---

## Architecture

Co is built on [Bun Workers](https://bun.sh/docs/api/workers), which implements the Web Workers API with server-side extensions. Workers run on separate OS threads, providing true parallelism for CPU-intensive tasks.

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Main Thread                                  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   co(ctx, fn, args)                                                      │
│         │                                                                │
│         ▼                                                                │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                        WorkerPool                                │   │
│   │  ┌─────────────────┐  ┌──────────────┐  ┌───────────────────┐  │   │
│   │  │  Configuration  │  │  Task Queue  │  │  Inflight Tasks   │  │   │
│   │  │  - poolSize     │  │  [Pending]   │  │  Map<id, task>    │  │   │
│   │  │  - maxQueue     │  │  [Pending]   │  │                   │  │   │
│   │  │  - idleTimeout  │  │  [Pending]   │  │                   │  │   │
│   │  └─────────────────┘  └──────────────┘  └───────────────────┘  │   │
│   │                              │                                   │   │
│   │              ┌───────────────┼───────────────┐                  │   │
│   │              ▼               ▼               ▼                  │   │
│   │  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐  │   │
│   │  │  PoolWorker[0]  │ │  PoolWorker[1]  │ │  PoolWorker[N]  │  │   │
│   │  │  state: idle    │ │  state: busy    │ │  state: idle    │  │   │
│   │  │  taskId: null   │ │  taskId: "abc"  │ │  taskId: null   │  │   │
│   │  └────────┬────────┘ └────────┬────────┘ └────────┬────────┘  │   │
│   └───────────┼───────────────────┼───────────────────┼────────────┘   │
│               │                   │                   │                │
└───────────────┼───────────────────┼───────────────────┼────────────────┘
                │ postMessage       │ postMessage       │ postMessage
                ▼                   ▼                   ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│   Bun Worker Thread   │ │   Bun Worker Thread   │ │   Bun Worker Thread   │
│  ┌─────────────────┐  │ │  ┌─────────────────┐  │ │  ┌─────────────────┐  │
│  │  Task Executor  │  │ │  │  Task Executor  │  │ │  │  Task Executor  │  │
│  │  - fn.toString  │  │ │  │  - new Function │  │ │  │  - AbortCtrl    │  │
│  │  - new Function │  │ │  │  - execute      │  │ │  │  - timeout      │  │
│  └─────────────────┘  │ │  └─────────────────┘  │ │  └─────────────────┘  │
│  Isolated Memory      │ │  Isolated Memory      │ │  Isolated Memory      │
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘
```

### Internal Components

#### 1. Worker Script & Blob URL

The worker script is written as a TypeScript function, converted to a string via `toString()`, and then transformed into a Blob URL at runtime. This approach works correctly even in single binaries created with `bun build --compile`.

```typescript
// workerScript.ts - Worker code defined as TypeScript function
function workerMain() {
  const inflight = new Map<string, AbortController>();

  function serializeError(error: unknown): SerializedError {
    // ...
  }

  self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;

    if (message.type === "run") {
      const { id, fnSource, args, timeoutMs } = message;
      const controller = new AbortController();
      inflight.set(id, controller);

      try {
        // Reconstruct function from string
        const fn = new Function(`return (${fnSource})`)();

        // Set timeout
        let timeoutId;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        }

        // Execute function
        const result = await fn(...args);

        if (timeoutId) clearTimeout(timeoutId);

        self.postMessage({ type: "ok", id, value: result });
      } catch (error) {
        self.postMessage({ type: "err", id, error: serializeError(error) });
      } finally {
        inflight.delete(id);
      }
    } else if (message.type === "cancel") {
      inflight.get(id)?.abort();
    }
  };

  self.postMessage({ type: "ready" });
}

// Convert to string via toString()
export const WORKER_SCRIPT = `(${workerMain.toString()})();`;

// Create Blob URL (lazy initialization)
function getWorkerBlobUrl(): string {
  const blob = new Blob([WORKER_SCRIPT], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}
```

**Why use Blob URL:**
- External file references not available with `bun build --compile`
- Embedding worker script in code ensures single binary compatibility
- Enables dynamic worker creation at runtime

#### 2. Worker Pool Management

```typescript
// pool.ts - Worker pool management
class WorkerPool {
  private workers: PoolWorker[] = [];        // Active workers list
  private pendingQueue: PendingTask[] = [];  // Pending tasks
  private inflightTasks: Map<string, InflightTask> = new Map();  // Running tasks

  // Create worker
  private createWorker(): PoolWorker {
    const blobUrl = getWorkerBlobUrl();
    const worker = new Worker(blobUrl);  // Bun Worker API

    worker.onmessage = (event) => {
      this.handleWorkerMessage(poolWorker, event.data);
    };

    worker.onerror = (error) => {
      this.handleWorkerError(poolWorker, error);
    };

    return { worker, state: "starting", currentTaskId: null, ... };
  }

  // Submit task
  submit<T>(id: string, fnSource: string, args: unknown[], options: TaskOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = { id, fnSource, args, options, resolve, reject };

      // Dispatch immediately if idle worker available
      const idleWorker = this.workers.find(w => w.state === "idle");
      if (idleWorker) {
        this.dispatchToWorker(task, idleWorker);
      } else if (this.workers.length < this.config.poolSize) {
        // Create new worker if below poolSize
        this.workers.push(this.createWorker());
        this.pendingQueue.push(task);
      } else {
        // Add to queue
        this.pendingQueue.push(task);
      }
    });
  }
}
```

**Worker Pool Behavior:**

1. **Lazy Initialization**: Workers created on first task submission
2. **Worker Reuse**: Workers transition to idle state after task completion and are reused
3. **Dynamic Scaling**: Worker count automatically increases up to `poolSize`
4. **Idle Termination**: Idle workers terminated after `idleTerminateMs` (minimum 1 worker retained)

#### 3. Function Serialization

Functions are converted to source code strings via `fn.toString()` and sent to workers:

```typescript
// Main Thread
const fn = (x, y) => x + y;
const fnSource = fn.toString();  // "(x, y) => x + y"

worker.postMessage({
  type: "run",
  id: "task-123",
  fnSource: fnSource,  // Sent as string
  args: [2, 3]
});
```

```typescript
// Worker Thread
self.onmessage = async (event) => {
  const { fnSource, args } = event.data;

  // Reconstruct function from string
  const fn = new Function("return (" + fnSource + ")")();

  // Execute
  const result = await fn(...args);  // 5
};
```

**Constraints:**
- Functions must be self-contained
- No closures (external variable references) - external variables don't exist in worker
- Cannot reference modules/functions imported in main thread
- However, dynamic imports (`await import()`) are supported inside workers

#### 4. Message Passing with Structured Clone

Bun Workers use the [Structured Clone Algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) for message passing.

```typescript
// Main → Worker message
type MainToWorkerMessage =
  | { type: "run"; id: string; fnSource: string; args: unknown[]; timeoutMs?: number }
  | { type: "cancel"; id: string }

// Worker → Main message
type WorkerToMainMessage =
  | { type: "ready" }                                    // Worker initialization complete
  | { type: "ok"; id: string; value: unknown }           // Success
  | { type: "err"; id: string; error: SerializedError }  // Failure
```

**Bun's Optimized Message Passing:**

```typescript
// Fast path - pure string (bypasses structured clone)
postMessage("Hello");  // ~648ns

// Fast path - simple object (primitive values only)
postMessage({ message: "Hello", count: 42 });  // ~648ns

// Standard path - complex object
postMessage({
  nested: { deep: true },
  date: new Date(),
  buffer: new ArrayBuffer(8)
});  // Uses structured clone
```

#### 5. Task Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Task Lifecycle                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. SUBMIT                                                              │
│     co(ctx, fn, args)                                                   │
│         │                                                               │
│         ├── Check context (already cancelled?)                          │
│         │       └── Yes → Reject immediately                            │
│         │                                                               │
│         ├── Generate Task ID (crypto.randomUUID)                        │
│         │                                                               │
│         └── WorkerPool.submit()                                         │
│                 │                                                       │
│  2. QUEUE       ├── Idle worker available? → Dispatch immediately       │
│                 │                                                       │
│                 └── None? → Add to pendingQueue                         │
│                                                                         │
│  3. DISPATCH                                                            │
│     dispatchToWorker(task, worker)                                      │
│         │                                                               │
│         ├── worker.state = "busy"                                       │
│         ├── inflightTasks.set(id, task)                                 │
│         │                                                               │
│         └── worker.postMessage({ type: "run", ... })                    │
│                         │                                               │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ (Thread Boundary)     │
│                         ▼                                               │
│  4. EXECUTE (Worker Thread)                                             │
│     self.onmessage                                                      │
│         │                                                               │
│         ├── Create AbortController                                      │
│         ├── inflight.set(id, controller)                                │
│         │                                                               │
│         ├── new Function("return (" + fnSource + ")")()                 │
│         │                                                               │
│         ├── timeoutMs? → setTimeout(abort, timeoutMs)                   │
│         │                                                               │
│         └── await fn(...args)                                           │
│                 │                                                       │
│  ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ (Thread Boundary)        │
│                 ▼                                                       │
│  5. COMPLETE                                                            │
│     handleWorkerMessage({ type: "ok", id, value })                      │
│         │                                                               │
│         ├── inflightTasks.delete(id)                                    │
│         ├── task.resolve(value)                                         │
│         │                                                               │
│         └── markWorkerIdle(worker)                                      │
│                 │                                                       │
│                 └── processQueue() → Dispatch pending tasks             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 6. Cancellation Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Cancellation Flow                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Context Cancel                          Handle Cancel                  │
│  ─────────────────                       ─────────────────              │
│  context.withCancel()                    handle.cancel("reason")        │
│       │                                         │                       │
│       ▼                                         │                       │
│  Call cancel()                                  │                       │
│       │                                         │                       │
│       ▼                                         │                       │
│  AbortController.abort()                        │                       │
│       │                                         │                       │
│       ▼                                         │                       │
│  ctx.signal "abort" event ──────────────────────┤                       │
│       │                                         │                       │
│       ▼                                         ▼                       │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    pool.cancelTask(id, error)                    │   │
│  │                                                                  │   │
│  │  1. In pendingQueue?                                             │   │
│  │     └── Yes → Remove from queue, reject(error)                   │   │
│  │                                                                  │   │
│  │  2. In inflightTasks?                                            │   │
│  │     └── Yes →                                                    │   │
│  │         ├── worker.postMessage({ type: "cancel", id })           │   │
│  │         ├── Reject immediately  // Don't wait for worker         │   │
│  │         └── markWorkerIdle(worker)                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                         │                                               │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ (Thread Boundary)         │
│                         ▼                                               │
│  Worker Thread:                                                         │
│  self.onmessage({ type: "cancel", id })                                │
│       │                                                                 │
│       └── inflight.get(id)?.abort()                                    │
│               │                                                         │
│               └── AbortController interrupts running Promise            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 7. Worker State Machine

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌─────────┴──────┐
│ STARTING │───▶│   IDLE   │───▶│   BUSY   │───▶│  TERMINATING   │
└──────────┘    └──────────┘    └──────────┘    └────────────────┘
     │               │  ▲            │
     │               │  │            │
     │               │  └────────────┘
     │               │   Complete/Error
     │               │
     │               └──────────────────────┐
     │                 idleTerminateMs      │
     │                 elapsed              │
     │                 (workers > 1)        │
     │                                      ▼
     │                            ┌────────────────┐
     └────────────────────────────│  TERMINATING   │
              (Error occurred)    └────────────────┘

State Transitions:
─────────────────
STARTING → IDLE      : "ready" message received
IDLE → BUSY          : Task dispatched
BUSY → IDLE          : Task completed (ok/err)
IDLE → TERMINATING   : Idle timeout & workers > 1
STARTING → TERMINATING: Error occurred
BUSY → TERMINATING   : Error occurred (replaced with new worker)
```

### Memory Model

Bun Workers have isolated memory spaces:

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│         Main Thread             │   │        Worker Thread            │
│                                 │   │                                 │
│  const data = { value: 42 };   │   │  // Separate memory space       │
│                                 │   │  // Cannot access Main Thread  │
│  worker.postMessage(data);     │──▶│                                 │
│  // Copy of data is sent        │   │  self.onmessage = (e) => {     │
│                                 │   │    const copy = e.data;        │
│  console.log(data.value);      │   │    // copy is a copy of data   │
│  // 42 (original unchanged)     │   │    copy.value = 100;           │
│                                 │   │    // Does not affect Main     │
└─────────────────────────────────┘   └─────────────────────────────────┘
```

**Key Characteristics:**
- No shared memory between workers (except SharedArrayBuffer)
- All data copied via Structured Clone
- Pass-by-value, not pass-by-reference

### Performance Characteristics

| Item | Value | Description |
|------|-------|-------------|
| Worker Creation | ~1-5ms | Worker creation from Blob URL |
| Message Passing (simple) | ~648ns | String or simple object |
| Message Passing (complex) | ~1-10µs | Nested objects, Date, ArrayBuffer, etc. |
| Context Switching | OS dependent | Uses actual OS threads |
| Memory Overhead | ~2-5MB/worker | Depends on V8/JSC heap size |

---

## Comparison: Bun Workers vs Go Goroutines

| Characteristic | Bun Workers | Go Goroutines |
|----------------|-------------|---------------|
| **Implementation** | OS threads (1:1) | M:N scheduling (lightweight threads) |
| **Memory** | ~2-5MB/worker | ~2KB/goroutine |
| **Creation Cost** | High (mitigated by pool) | Very low |
| **Parallelism** | True parallel execution | True parallel execution |
| **Communication** | postMessage (copy) | Channels (can pass references) |
| **Concurrency Count** | ~tens recommended | Hundreds of thousands possible |

---

## Comparison with Go

| Go | Co | Notes |
|----|-----|-------|
| `go func() {}()` | `co(() => {})` | Fire-and-forget execution |
| `context.Background()` | `context.background()` | Root context |
| `context.TODO()` | `context.todo()` | Placeholder context |
| `context.WithCancel(ctx)` | `context.withCancel(ctx)` | Returns `[ctx, cancel]` |
| `context.WithTimeout(ctx, 5*time.Second)` | `context.withTimeout(ctx, 5000)` | Duration in ms |
| `context.WithDeadline(ctx, deadline)` | `context.withDeadline(ctx, deadline)` | Deadline as epoch ms |
| `context.WithValue(ctx, key, val)` | `context.withValue(ctx, key, val)` | Key must be Symbol |
| `ctx.Done()` | `ctx.done()` | Returns boolean (not channel) |
| `ctx.Err()` | `ctx.err()` | Returns ContextError object |
| `ctx.Deadline()` | `ctx.deadline()` | Returns number or undefined |
| `ctx.Value(key)` | `ctx.value(key)` | Type-safe with ContextKey |
| `defer cancel()` | `finally { cancel() }` | Cleanup pattern |
| `select { case <-ctx.Done(): }` | `if (ctx.done())` | Polling instead of channel |

**Key Differences:**

1. **No Channels**: JavaScript doesn't have Go channels. Use `ctx.done()` for polling or `ctx.signal` with AbortController patterns.

2. **Return Values**: Go uses `result, err` pattern. JavaScript uses `Promise` with try/catch.

3. **Goroutines vs Workers**: Go goroutines are lightweight (2KB stack). Workers are OS threads (heavier but true parallelism).

4. **Context Keys**: Go uses empty structs. JavaScript uses branded Symbols for type safety.
