# Co

Go-style goroutine execution API for Bun Workers.

Execute functions in parallel using Bun's native worker threads with a simple, Go-inspired API featuring context-based cancellation and timeout management.

## Table of Contents

- [Installation](#installation)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [Worker Execution Model](#worker-execution-model)
  - [Context Pattern](#context-pattern)
- [API Reference](#api-reference)
  - [co](#co)
  - [co.promise](#copromise)
  - [co.pool](#copool)
  - [context](#context)
  - [Context Interface](#context-interface)
- [Type Definitions](#type-definitions)
- [Error Reference](#error-reference)
- [Usage Examples](#usage-examples)
  - [Basic Execution](#basic-execution)
  - [Context with Cancellation](#context-with-cancellation)
  - [Context with Timeout](#context-with-timeout)
  - [Context with Deadline](#context-with-deadline)
  - [Context Values](#context-values)
  - [Context Inheritance](#context-inheritance)
  - [Error Handling](#error-handling)
  - [Pool Management](#pool-management)
- [Advanced Patterns](#advanced-patterns)
  - [Request-scoped Context](#request-scoped-context)
  - [Parallel Execution with Shared Context](#parallel-execution-with-shared-context)
  - [Nested Timeouts](#nested-timeouts)
  - [Graceful Shutdown Pattern](#graceful-shutdown-pattern)
- [Limitations](#limitations)
- [Binary Compilation](#binary-compilation)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [References](#internal-references)
- [License](#license)

---

## Installation

```bash
bun add @clix-so/co
```

Or install directly from GitHub:

```bash
bun add github:clix-so/co
```

## Requirements

- **Bun** >= 1.0.0
- Co is Bun-only and will not work in Node.js or browsers

---

## Quick Start

```typescript
import { co, context } from "@clix-so/co";

// Basic execution (like Go's `go func() {}`)
co(() => console.log("Running in worker"));

// Get result
const result = await co.promise((a, b) => a + b, 2, 3); // 5

// With timeout (like Go's context.WithTimeout)
const [ctx, cancel] = context.withTimeout(context.background(), 5000);
try {
  await co.promise(ctx, async () => {
    // Long running task
  });
} finally {
  cancel();
}
```

---

## Core Concepts

### Worker Execution Model

Co executes functions in Bun's native Worker threads, providing true parallelism. Key characteristics:

1. **Isolated Execution**: Each task runs in an isolated worker context
2. **Function Serialization**: Functions are serialized via `fn.toString()` and reconstructed in workers
3. **Structured Clone**: Arguments are passed using the structured clone algorithm
4. **Worker Pool**: A pool of reusable workers is maintained for efficiency

```
┌─────────────────┐     ┌─────────────────────────────────────┐
│   Main Thread   │     │           Worker Pool               │
│                 │     │  ┌─────────┐ ┌─────────┐ ┌───────┐  │
│  co(fn, args)   │────▶│  │ Worker1 │ │ Worker2 │ │ ... N │  │
│                 │◀────│  └─────────┘ └─────────┘ └───────┘  │
│   Promise<T>    │     │                                     │
└─────────────────┘     └─────────────────────────────────────┘
```

### Context Pattern

Inspired by Go's `context` package, contexts provide:

- **Cancellation propagation**: Cancel operations across the call tree
- **Deadline management**: Automatic timeout handling
- **Request-scoped values**: Pass values through the context chain

```
context.background()
    │
    ├── context.withCancel() ──▶ [ctx, cancel]
    │       │
    │       └── context.withTimeout() ──▶ [ctx, cancel]
    │
    └── context.withValue() ──▶ ctx (with attached value)
```

---

## API Reference

### co

Execute a function in a worker thread.

#### Signatures

```typescript
// With Context (recommended)
function co<T, A extends unknown[]>(
  ctx: Context,
  fn: (ctx: Context, ...args: A) => T | Promise<T>,
  ...args: A
): CoHandle<T>

// Without Context (uses background context internally)
function co<T, A extends unknown[]>(
  fn: (...args: A) => T | Promise<T>,
  ...args: A
): CoHandle<T>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `ctx` | `Context` | Optional. The context for cancellation/timeout control |
| `fn` | `Function` | The function to execute in a worker. Must be self-contained (no closures) |
| `args` | `unknown[]` | Arguments to pass to the function. Must be structured-clone compatible |

#### Returns

`CoHandle<T>` - A handle to the running task:

```typescript
type CoHandle<T> = {
  readonly id: string;        // Unique task identifier (UUID)
  readonly promise: Promise<T>; // Promise that resolves with the result
  cancel: (reason?: string) => void; // Cancel the task
}
```

#### Example

```typescript
// Basic usage
const handle = co((x: number) => x * 2, 21);
console.log(handle.id);  // "550e8400-e29b-41d4-a716-446655440000"
const result = await handle.promise;  // 42

// With context
const [ctx, cancel] = context.withTimeout(context.background(), 5000);
const handle = co(ctx, async (ctx, url: string) => {
  const res = await fetch(url);
  return res.json();
}, "https://api.example.com");

// Cancel if needed
handle.cancel("user requested");
```

---

### co.promise

Shorthand for `co(...).promise`. Directly returns the promise without the handle.

#### Signatures

```typescript
// With Context
function promise<T, A extends unknown[]>(
  ctx: Context,
  fn: (ctx: Context, ...args: A) => T | Promise<T>,
  ...args: A
): Promise<T>

// Without Context
function promise<T, A extends unknown[]>(
  fn: (...args: A) => T | Promise<T>,
  ...args: A
): Promise<T>
```

#### Example

```typescript
// Simple execution
const result = await co.promise((a, b) => a + b, 2, 3);  // 5

// With context and timeout
const [ctx, cancel] = context.withTimeout(context.background(), 3000);
try {
  const data = await co.promise(ctx, async () => {
    const res = await fetch("https://api.example.com/data");
    return res.json();
  });
} finally {
  cancel();
}
```

---

### co.pool

Worker pool management interface.

#### co.pool.configure(options)

Configure the worker pool settings.

```typescript
function configure(options: Partial<CoConfig>): void
```

**Parameters:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `navigator.hardwareConcurrency - 1` | Number of worker threads to maintain |
| `maxQueue` | `number` | `1000` | Maximum number of tasks that can be queued |
| `idleTerminateMs` | `number` | `30000` | Time (ms) before idle workers are terminated |

**Example:**

```typescript
co.pool.configure({
  poolSize: 8,
  maxQueue: 500,
  idleTerminateMs: 60000
});
```

#### co.pool.stats()

Get current pool statistics.

```typescript
function stats(): PoolStats
```

**Returns:**

```typescript
type PoolStats = {
  workers: number;  // Total number of workers
  idle: number;     // Number of idle workers
  busy: number;     // Number of busy workers
  queued: number;   // Number of tasks waiting in queue
}
```

**Example:**

```typescript
const stats = co.pool.stats();
console.log(`Workers: ${stats.workers}, Busy: ${stats.busy}, Queued: ${stats.queued}`);
// Workers: 4, Busy: 2, Queued: 0
```

#### co.pool.shutdown(options?)

Shutdown the worker pool.

```typescript
function shutdown(options?: { force?: boolean }): Promise<void>
```

**Parameters:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `force` | `boolean` | `false` | If `true`, immediately cancel all tasks and terminate workers. If `false`, wait for in-flight tasks to complete. |

**Example:**

```typescript
// Graceful shutdown - wait for running tasks
await co.pool.shutdown();

// Force shutdown - cancel everything immediately
await co.pool.shutdown({ force: true });
```

---

### context

Factory functions for creating contexts. Implements Go's context pattern.

#### context.background()

Returns a non-cancellable root context. This should be used as the top-level context.

```typescript
function background(): Context
```

**Characteristics:**
- Never cancelled
- No deadline
- No values
- Singleton (same instance returned every time)

**Example:**

```typescript
const ctx = context.background();
console.log(ctx.done());      // false (never cancelled)
console.log(ctx.deadline());  // undefined (no deadline)
console.log(ctx.err());       // undefined (no error)
```

#### context.todo()

Returns a root context like `background()`, but semantically indicates that the proper context is not yet determined. Use during development or when context will be added later.

```typescript
function todo(): Context
```

**Example:**

```typescript
// TODO: Replace with proper context from request
const ctx = context.todo();
await co.promise(ctx, () => doWork());
```

#### context.withCancel(parent)

Creates a child context that can be manually cancelled.

```typescript
function withCancel(parent: Context): [Context, CancelFunc]
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `parent` | `Context` | The parent context to derive from |

**Returns:**

A tuple of `[Context, CancelFunc]`:
- `Context`: The new cancellable child context
- `CancelFunc`: Function to cancel the context: `(reason?: string) => void`

**Behavior:**
- Cancelled when `cancel()` is called
- Cancelled when parent is cancelled
- Cancelling does NOT cancel the parent

**Example:**

```typescript
const [ctx, cancel] = context.withCancel(context.background());

// Start some work
const handle = co(ctx, async () => {
  while (!ctx.done()) {
    await doSomeWork();
  }
});

// Cancel after 5 seconds
setTimeout(() => cancel("timeout"), 5000);

// Or cancel with no reason
cancel();
```

#### context.withTimeout(parent, timeoutMs)

Creates a child context that automatically cancels after the specified duration.

```typescript
function withTimeout(parent: Context, timeoutMs: number): [Context, CancelFunc]
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `parent` | `Context` | The parent context to derive from |
| `timeoutMs` | `number` | Timeout duration in milliseconds |

**Returns:**

A tuple of `[Context, CancelFunc]`:
- `Context`: The new context with timeout
- `CancelFunc`: Function to cancel before timeout (for cleanup)

**Behavior:**
- Automatically cancelled after `timeoutMs` milliseconds
- Cancelled when parent is cancelled
- `err()` returns `{ type: "deadline_exceeded", deadline: number }` on timeout
- Always call `cancel()` when done to release timer resources

**Example:**

```typescript
const [ctx, cancel] = context.withTimeout(context.background(), 5000);

try {
  const result = await co.promise(ctx, async () => {
    // This must complete within 5 seconds
    return await fetchData();
  });
  console.log("Success:", result);
} catch (error) {
  if (error instanceof DeadlineExceededError) {
    console.log("Request timed out");
  }
} finally {
  cancel();  // Always cleanup
}
```

#### context.withDeadline(parent, deadline)

Creates a child context that automatically cancels at a specific time.

```typescript
function withDeadline(parent: Context, deadline: number): [Context, CancelFunc]
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `parent` | `Context` | The parent context to derive from |
| `deadline` | `number` | Deadline as milliseconds since Unix epoch (`Date.now()` format) |

**Returns:**

A tuple of `[Context, CancelFunc]`

**Behavior:**
- Automatically cancelled at the specified deadline
- If deadline is already passed, context is immediately cancelled
- If parent has an earlier deadline, the parent's deadline takes precedence
- `err()` returns `{ type: "deadline_exceeded", deadline: number }` on timeout

**Example:**

```typescript
// Cancel at a specific time
const deadline = Date.now() + 10000;  // 10 seconds from now
const [ctx, cancel] = context.withDeadline(context.background(), deadline);

try {
  await co.promise(ctx, () => longRunningTask());
} finally {
  cancel();
}

// Already passed deadline
const pastDeadline = Date.now() - 1000;
const [ctx2, cancel2] = context.withDeadline(context.background(), pastDeadline);
console.log(ctx2.done());  // true (immediately cancelled)
cancel2();
```

#### context.withValue(parent, key, value)

Creates a child context with an attached key-value pair.

```typescript
function withValue<T>(parent: Context, key: ContextKey<T>, value: T): Context
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `parent` | `Context` | The parent context to derive from |
| `key` | `ContextKey<T>` | A unique symbol key for the value |
| `value` | `T` | The value to attach |

**Returns:**

A new `Context` with the value attached.

**Note:** `ContextKey<T>` must be created using `Symbol()` for type safety:

```typescript
const myKey: ContextKey<string> = Symbol("myKey") as ContextKey<string>;
```

**Example:**

```typescript
import { type ContextKey } from "@clix-so/co";

// Define typed keys
const userIdKey: ContextKey<string> = Symbol("userId") as ContextKey<string>;
const roleKey: ContextKey<string[]> = Symbol("roles") as ContextKey<string[]>;

// Build context chain
const ctx1 = context.withValue(context.background(), userIdKey, "user-123");
const ctx2 = context.withValue(ctx1, roleKey, ["admin", "user"]);

// Retrieve values
console.log(ctx2.value(userIdKey));  // "user-123"
console.log(ctx2.value(roleKey));    // ["admin", "user"]

// Parent doesn't have child's values
console.log(ctx1.value(roleKey));    // undefined
```

---

### Context Interface

All contexts implement this interface:

```typescript
interface Context {
  /**
   * Returns the deadline time as milliseconds since Unix epoch,
   * or undefined if no deadline is set.
   */
  deadline(): number | undefined;

  /**
   * Returns true if the context has been cancelled or the deadline exceeded.
   */
  done(): boolean;

  /**
   * Returns the error describing why the context was cancelled,
   * or undefined if not cancelled.
   */
  err(): ContextError | undefined;

  /**
   * Returns the value associated with the key,
   * or undefined if no value is associated.
   */
  value<T>(key: ContextKey<T>): T | undefined;

  /**
   * The underlying AbortSignal for interop with Web APIs.
   * Aborted when context is cancelled.
   */
  readonly signal: AbortSignal;
}
```

#### Context.signal

The `signal` property provides interoperability with Web APIs that accept `AbortSignal`:

```typescript
const [ctx, cancel] = context.withTimeout(context.background(), 5000);

// Use with fetch
const response = await fetch("https://api.example.com", {
  signal: ctx.signal
});

// Use with any AbortSignal-compatible API
const result = await someAsyncOperation({ signal: ctx.signal });

cancel();
```

---

## Type Definitions

### Core Types

```typescript
/** Context key type (branded symbol for type safety) */
export type ContextKey<T> = symbol & { __type?: T };

/** Function to cancel a context */
export type CancelFunc = (reason?: string) => void;

/** Context error types */
export type ContextError =
  | { type: "cancelled"; reason?: string }
  | { type: "deadline_exceeded"; deadline: number };

/** Function that receives context as first parameter */
export type ContextFn<T, A extends unknown[]> = (
  ctx: Context,
  ...args: A
) => T | Promise<T>;

/** Function without context */
export type CoFn<T, A extends unknown[]> = (...args: A) => T | Promise<T>;

/** Handle returned from co() calls */
export type CoHandle<T> = {
  readonly id: string;
  readonly promise: Promise<T>;
  cancel: (reason?: string) => void;
};

/** Pool configuration options */
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
  configure(options: Partial<CoConfig>): void;
  shutdown(options?: { force?: boolean }): Promise<void>;
  stats(): PoolStats;
}

/** Main co interface */
export interface Co {
  <T, A extends unknown[]>(ctx: Context, fn: ContextFn<T, A>, ...args: A): CoHandle<T>;
  <T, A extends unknown[]>(fn: CoFn<T, A>, ...args: A): CoHandle<T>;

  promise: {
    <T, A extends unknown[]>(ctx: Context, fn: ContextFn<T, A>, ...args: A): Promise<T>;
    <T, A extends unknown[]>(fn: CoFn<T, A>, ...args: A): Promise<T>;
  };

  readonly pool: PoolManager;
}

/** Context factory interface */
export interface ContextFactory {
  background(): Context;
  todo(): Context;
  withCancel(parent: Context): [Context, CancelFunc];
  withTimeout(parent: Context, timeoutMs: number): [Context, CancelFunc];
  withDeadline(parent: Context, deadline: number): [Context, CancelFunc];
  withValue<T>(parent: Context, key: ContextKey<T>, value: T): Context;
}
```

---

## Error Reference

All errors extend the base `CoError` class:

```typescript
import {
  CoError,
  CancelledError,
  DeadlineExceededError,
  TimeoutError,
  QueueFullError,
  ShutdownError,
  RuntimeError,
} from "@clix-so/co";
```

### CoError

Base class for all co errors.

```typescript
class CoError extends Error {
  readonly name: string;
  readonly taskId?: string;
}
```

### CancelledError

Thrown when a task is cancelled via `handle.cancel()` or context cancellation.

```typescript
class CancelledError extends CoError {
  readonly name = "CancelledError";
  readonly taskId: string;
  readonly reason?: string;
}
```

**Example:**

```typescript
try {
  await handle.promise;
} catch (error) {
  if (error instanceof CancelledError) {
    console.log(`Task ${error.taskId} cancelled: ${error.reason}`);
  }
}
```

### DeadlineExceededError

Thrown when a context deadline (timeout) is exceeded.

```typescript
class DeadlineExceededError extends CoError {
  readonly name = "DeadlineExceededError";
  readonly deadline: number;  // The deadline that was exceeded (epoch ms)
  readonly taskId?: string;
}
```

**Example:**

```typescript
const [ctx, cancel] = context.withTimeout(context.background(), 100);
try {
  await co.promise(ctx, async () => {
    await new Promise(r => setTimeout(r, 5000));
  });
} catch (error) {
  if (error instanceof DeadlineExceededError) {
    console.log(`Deadline exceeded: ${new Date(error.deadline)}`);
  }
} finally {
  cancel();
}
```

### TimeoutError

Thrown when a task exceeds its internal timeout (different from context deadline).

```typescript
class TimeoutError extends CoError {
  readonly name = "TimeoutError";
  readonly taskId: string;
  readonly timeoutMs?: number;
}
```

### QueueFullError

Thrown when attempting to submit a task but the queue is at capacity.

```typescript
class QueueFullError extends CoError {
  readonly name = "QueueFullError";
  readonly maxQueue: number;  // The configured maximum queue size
}
```

**Example:**

```typescript
co.pool.configure({ maxQueue: 10 });

try {
  // Submit many tasks quickly
  for (let i = 0; i < 100; i++) {
    co(() => heavyComputation());
  }
} catch (error) {
  if (error instanceof QueueFullError) {
    console.log(`Queue full (max: ${error.maxQueue}). Try again later.`);
  }
}
```

### ShutdownError

Thrown when attempting to submit a task after the pool has been shut down.

```typescript
class ShutdownError extends CoError {
  readonly name = "ShutdownError";
}
```

**Example:**

```typescript
await co.pool.shutdown();

try {
  await co.promise(() => work());  // Throws ShutdownError
} catch (error) {
  if (error instanceof ShutdownError) {
    console.log("Pool is shut down");
  }
}
```

### RuntimeError

Thrown when attempting to use the library outside of Bun runtime.

```typescript
class RuntimeError extends CoError {
  readonly name = "RuntimeError";
}
```

---

## Usage Examples

### Basic Execution

```typescript
import { co } from "@clix-so/co";

// Fire and forget
co(() => {
  console.log("Running in background");
});

// With return value
const handle = co((x: number, y: number) => x + y, 10, 20);
const sum = await handle.promise;  // 30

// Using co.promise shorthand
const result = await co.promise((name: string) => `Hello, ${name}!`, "World");
console.log(result);  // "Hello, World!"

// Async function
const data = await co.promise(async (url: string) => {
  const response = await fetch(url);
  return response.json();
}, "https://api.example.com/users");
```

### Context with Cancellation

```typescript
import { co, context, CancelledError } from "@clix-so/co";

const [ctx, cancel] = context.withCancel(context.background());

// Start a long-running task
const handle = co(ctx, async () => {
  for (let i = 0; i < 100; i++) {
    await doSomeWork(i);
  }
  return "completed";
});

// Cancel after 1 second
setTimeout(() => {
  cancel("user requested cancellation");
}, 1000);

try {
  const result = await handle.promise;
  console.log(result);
} catch (error) {
  if (error instanceof CancelledError) {
    console.log("Task was cancelled:", error.reason);
  }
}
```

### Context with Timeout

```typescript
import { co, context, DeadlineExceededError } from "@clix-so/co";

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const [ctx, cancel] = context.withTimeout(context.background(), timeoutMs);

  try {
    return await co.promise(ctx, async () => {
      const response = await fetch(url);
      return response.json();
    });
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    cancel();  // Always cleanup
  }
}

// Usage
try {
  const data = await fetchWithTimeout("https://api.example.com/data", 5000);
  console.log(data);
} catch (error) {
  console.error(error.message);
}
```

### Context with Deadline

```typescript
import { co, context } from "@clix-so/co";

// Process must complete by end of business day
const endOfDay = new Date();
endOfDay.setHours(18, 0, 0, 0);

const [ctx, cancel] = context.withDeadline(context.background(), endOfDay.getTime());

try {
  await co.promise(ctx, async () => {
    await processAllOrders();
  });
  console.log("All orders processed before deadline");
} catch (error) {
  console.log("Could not complete before deadline");
} finally {
  cancel();
}
```

### Context Values

```typescript
import { co, context, type ContextKey } from "@clix-so/co";

// Define typed context keys
const requestIdKey: ContextKey<string> = Symbol("requestId") as ContextKey<string>;
const userKey: ContextKey<{ id: string; name: string }> = Symbol("user") as ContextKey<{ id: string; name: string }>;
const permissionsKey: ContextKey<string[]> = Symbol("permissions") as ContextKey<string[]>;

// Build context with values
function createRequestContext(requestId: string, user: { id: string; name: string }) {
  let ctx = context.background();
  ctx = context.withValue(ctx, requestIdKey, requestId);
  ctx = context.withValue(ctx, userKey, user);
  ctx = context.withValue(ctx, permissionsKey, ["read", "write"]);
  return ctx;
}

// Use in tasks
const ctx = createRequestContext("req-123", { id: "user-456", name: "Alice" });

await co.promise(ctx, (ctx) => {
  const requestId = ctx.value(requestIdKey);
  const user = ctx.value(userKey);
  const permissions = ctx.value(permissionsKey);

  console.log(`Request ${requestId} by ${user?.name}`);
  console.log(`Permissions: ${permissions?.join(", ")}`);
});
```

### Context Inheritance

```typescript
import { co, context, CancelledError } from "@clix-so/co";

// Parent context with 10 second timeout
const [parentCtx, parentCancel] = context.withTimeout(context.background(), 10000);

// Child context with 5 second timeout (shorter deadline wins)
const [childCtx, childCancel] = context.withTimeout(parentCtx, 5000);

// Start parallel tasks
const task1 = co(parentCtx, async () => {
  await doTask1();  // Has 10 seconds
});

const task2 = co(childCtx, async () => {
  await doTask2();  // Has only 5 seconds
});

// If we cancel parent, both tasks are cancelled
parentCancel();
console.log(parentCtx.done());  // true
console.log(childCtx.done());   // true

// Cleanup
childCancel();
```

### Error Handling

```typescript
import {
  co,
  context,
  CancelledError,
  DeadlineExceededError,
  QueueFullError,
  ShutdownError,
} from "@clix-so/co";

async function executeWithRetry<T>(
  ctx: Context,
  fn: () => T | Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await co.promise(ctx, fn);
    } catch (error) {
      lastError = error as Error;

      // Don't retry on these errors
      if (error instanceof CancelledError) {
        throw error;  // Explicitly cancelled
      }
      if (error instanceof DeadlineExceededError) {
        throw error;  // Timeout - retrying won't help
      }
      if (error instanceof ShutdownError) {
        throw error;  // Pool is shutting down
      }

      // Retry on queue full (wait and retry)
      if (error instanceof QueueFullError) {
        await new Promise(r => setTimeout(r, 100 * attempt));
        continue;
      }

      // Retry on other errors
      console.warn(`Attempt ${attempt} failed:`, error);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastError;
}
```

### Pool Management

```typescript
import { co } from "@clix-so/co";

// Configure pool at startup
co.pool.configure({
  poolSize: 8,           // 8 worker threads
  maxQueue: 500,         // Max 500 pending tasks
  idleTerminateMs: 60000 // Terminate idle workers after 1 minute
});

// Monitor pool status
setInterval(() => {
  const stats = co.pool.stats();
  console.log(`Pool: ${stats.workers} workers, ${stats.busy} busy, ${stats.queued} queued`);
}, 5000);

// Graceful shutdown on process exit
process.on("SIGTERM", async () => {
  console.log("Shutting down...");

  // Wait for in-flight tasks (with 30 second timeout)
  const shutdownTimeout = setTimeout(() => {
    console.log("Force shutdown due to timeout");
    co.pool.shutdown({ force: true });
  }, 30000);

  await co.pool.shutdown();
  clearTimeout(shutdownTimeout);

  console.log("Shutdown complete");
  process.exit(0);
});
```

---

## Advanced Patterns

### Request-scoped Context

```typescript
import { co, context, type ContextKey, type Context } from "@clix-so/co";

// Context keys
const traceIdKey: ContextKey<string> = Symbol("traceId") as ContextKey<string>;
const startTimeKey: ContextKey<number> = Symbol("startTime") as ContextKey<number>;

function handleRequest(request: Request): Context {
  const traceId = request.headers.get("x-trace-id") || crypto.randomUUID();
  const startTime = Date.now();

  // Create request-scoped context with 30 second timeout
  let ctx = context.background();
  ctx = context.withValue(ctx, traceIdKey, traceId);
  ctx = context.withValue(ctx, startTimeKey, startTime);

  const [timeoutCtx, _] = context.withTimeout(ctx, 30000);
  return timeoutCtx;
}

// Usage in request handler
async function handler(request: Request) {
  const ctx = handleRequest(request);

  try {
    const result = await co.promise(ctx, async (ctx) => {
      const traceId = ctx.value(traceIdKey);
      console.log(`[${traceId}] Processing request`);

      return await processRequest(request);
    });

    const duration = Date.now() - (ctx.value(startTimeKey) || 0);
    console.log(`Request completed in ${duration}ms`);

    return new Response(JSON.stringify(result));
  } catch (error) {
    return new Response("Error", { status: 500 });
  }
}
```

### Parallel Execution with Shared Context

```typescript
import { co, context, type Context } from "@clix-so/co";

async function fetchAllData(ctx: Context, urls: string[]) {
  // Create child contexts for each request
  const handles = urls.map(url => {
    const [childCtx, cancel] = context.withTimeout(ctx, 5000);
    return {
      handle: co(childCtx, async () => {
        const response = await fetch(url);
        return response.json();
      }),
      cancel
    };
  });

  try {
    // Wait for all to complete
    const results = await Promise.all(handles.map(h => h.promise));
    return results;
  } finally {
    // Cleanup all child contexts
    handles.forEach(h => h.cancel());
  }
}

// Usage
const [ctx, cancel] = context.withTimeout(context.background(), 10000);
try {
  const data = await fetchAllData(ctx, [
    "https://api.example.com/users",
    "https://api.example.com/posts",
    "https://api.example.com/comments"
  ]);
  console.log(data);
} finally {
  cancel();
}
```

### Nested Timeouts

```typescript
import { co, context } from "@clix-so/co";

async function processWithNestedTimeouts() {
  // Overall operation: 30 seconds
  const [outerCtx, outerCancel] = context.withTimeout(context.background(), 30000);

  try {
    // Phase 1: 10 seconds max
    const [phase1Ctx, phase1Cancel] = context.withTimeout(outerCtx, 10000);
    try {
      await co.promise(phase1Ctx, () => phase1Work());
    } finally {
      phase1Cancel();
    }

    // Phase 2: 15 seconds max
    const [phase2Ctx, phase2Cancel] = context.withTimeout(outerCtx, 15000);
    try {
      await co.promise(phase2Ctx, () => phase2Work());
    } finally {
      phase2Cancel();
    }

    // Remaining time for phase 3
    await co.promise(outerCtx, () => phase3Work());

  } finally {
    outerCancel();
  }
}
```

### Graceful Shutdown Pattern

```typescript
import { co, context, type Context } from "@clix-so/co";

class TaskProcessor {
  private shutdownCtx: Context | null = null;
  private shutdownCancel: (() => void) | null = null;

  start() {
    const [ctx, cancel] = context.withCancel(context.background());
    this.shutdownCtx = ctx;
    this.shutdownCancel = cancel;

    this.processLoop(ctx);
  }

  private async processLoop(ctx: Context) {
    while (!ctx.done()) {
      try {
        const task = await this.getNextTask();
        if (task) {
          await co.promise(ctx, () => this.processTask(task));
        } else {
          // No task available, wait a bit
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (error) {
        if (ctx.done()) break;  // Shutdown requested
        console.error("Task processing error:", error);
      }
    }
    console.log("Process loop ended");
  }

  async shutdown() {
    console.log("Initiating shutdown...");

    // Signal shutdown to process loop
    this.shutdownCancel?.();

    // Wait for pool to finish current tasks
    await co.pool.shutdown();

    console.log("Shutdown complete");
  }

  private async getNextTask() { /* ... */ }
  private async processTask(task: any) { /* ... */ }
}

// Usage
const processor = new TaskProcessor();
processor.start();

process.on("SIGTERM", () => processor.shutdown());
```

---

## Limitations

### 1. Pure Functions Only

Functions must be self-contained and cannot access variables from outer scope (closures). All data must be passed as arguments.

```typescript
// CORRECT: All data passed as arguments
await co.promise((x, y) => x + y, 10, 20);

// CORRECT: Using inline values
await co.promise((items) => items.map(x => x * 2), [1, 2, 3]);

// WRONG: Captures outer variable (will fail at runtime)
const multiplier = 2;
await co.promise((x) => x * multiplier, 10);  // Error!

// WRONG: Captures imported function
import { helper } from "./utils";
await co.promise((x) => helper(x), 10);  // Error!

// CORRECT: Include all logic inline
await co.promise((x) => {
  // Define helper inline
  const helper = (n: number) => n * 2;
  return helper(x);
}, 10);
```

### 2. Dynamic Imports Work in Workers

Bun Workers support dynamic `import()` unlike standard Web Workers. You can use Node.js built-in modules and npm packages via dynamic import:

```typescript
// WRONG: Static import from main thread not accessible
import path from "node:path";
await co.promise(() => path.join("a", "b"));  // Error: path is not defined

// CORRECT: Dynamic import inside worker
await co.promise(async () => {
  const path = await import("node:path");
  return path.join("a", "b");
});  // "a/b"

// CORRECT: Using Node.js built-in modules
await co.promise(async () => {
  const fs = await import("node:fs");
  return fs.existsSync("/tmp");
});  // true

// CORRECT: Using npm packages (must be installed)
await co.promise(async () => {
  const _ = await import("lodash");
  return _.chunk([1, 2, 3, 4], 2);
});  // [[1, 2], [3, 4]]
```

**Available in Workers:**
- Node.js built-in modules via `await import("node:*")`
- npm packages via `await import("package-name")`
- Web APIs: `fetch`, `crypto`, `URL`, `TextEncoder`, etc.
- Global objects: `Math`, `JSON`, `Date`, `Array`, etc.

**Not Available in Workers:**
- Variables from outer scope (closures)
- Static imports from main thread
- Main thread's global state

### 3. Serializable Arguments Only

Arguments must be serializable via the [structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).

**Supported types:**
- Primitives: `string`, `number`, `boolean`, `null`, `undefined`, `bigint`
- Objects: Plain objects, `Array`, `Map`, `Set`, `Date`, `RegExp`
- Binary: `ArrayBuffer`, `TypedArray`, `DataView`, `Blob`, `File`
- Error objects

**Not supported:**
- Functions
- Class instances (lose prototype chain)
- DOM nodes
- Symbols (except as ContextKey)
- WeakMap, WeakSet

```typescript
// CORRECT
await co.promise((data) => data.value, { value: 42 });
await co.promise((arr) => arr.length, [1, 2, 3]);
await co.promise((map) => map.get("key"), new Map([["key", "value"]]));
await co.promise((date) => date.getFullYear(), new Date());

// WRONG: Class instances
class User { constructor(public name: string) {} }
const user = new User("Alice");
await co.promise((u) => u.name, user);  // Works but u is a plain object, not User instance

// WRONG: Functions cannot be passed
await co.promise((fn) => fn(), () => 42);  // Error!
```

### 4. Bun Only

Co requires Bun runtime and will not work in Node.js or browsers. Attempting to use it in other environments will throw `RuntimeError`.

```typescript
import { co, RuntimeError } from "@clix-so/co";

try {
  await co.promise(() => 1);
} catch (error) {
  if (error instanceof RuntimeError) {
    console.log("This library requires Bun runtime");
  }
}
```

### 5. No Shared Memory

Workers have isolated memory. You cannot share references between the main thread and workers.

```typescript
// WRONG: Trying to modify shared state
const results: number[] = [];
await co.promise((arr) => {
  arr.push(42);  // This modifies a copy, not the original
}, results);
console.log(results);  // Still []

// CORRECT: Return data from worker
const result = await co.promise(() => {
  return [42];
});
console.log(result);  // [42]
```

---

## Binary Compilation

Co is designed to work with `bun build --compile`. The worker script is embedded as a Blob URL, allowing it to function correctly in compiled binaries.

```bash
# Compile your application
bun build ./app.ts --compile --outfile ./app

# Run the compiled binary
./app
```

**How it works:**
1. Worker script is generated as a string at build time
2. String is converted to a Blob URL at runtime
3. Workers are created using the Blob URL
4. This approach works in both development and compiled binaries

---

## Troubleshooting

### "RuntimeError: co requires Bun runtime"

You're trying to use Co outside of Bun. Co only works with Bun.

### "Function captured closure variable"

Your function references variables from outer scope. Pass all data as arguments:

```typescript
// Wrong
const config = { timeout: 1000 };
await co.promise(() => config.timeout);

// Correct
const config = { timeout: 1000 };
await co.promise((cfg) => cfg.timeout, config);
```

### "QueueFullError: Task queue is at capacity"

Too many tasks are queued. Either:
1. Increase `maxQueue`: `co.pool.configure({ maxQueue: 2000 })`
2. Add backpressure to your application
3. Increase `poolSize` for faster processing

### Tasks are not running in parallel

Check your `poolSize` configuration. Default is `navigator.hardwareConcurrency - 1`.

```typescript
co.pool.configure({ poolSize: 8 });
```

### Memory leaks with contexts

Always call `cancel()` when done with a context:

```typescript
const [ctx, cancel] = context.withTimeout(context.background(), 5000);
try {
  await co.promise(ctx, () => work());
} finally {
  cancel();  // Always cleanup!
}
```

### "DeadlineExceededError" when timeout is long enough

Check for parent context deadlines. Child contexts inherit parent deadlines:

```typescript
const [parent, parentCancel] = context.withTimeout(context.background(), 1000);
const [child, childCancel] = context.withTimeout(parent, 10000);
// child will timeout at 1000ms (parent's deadline), not 10000ms
```

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

**Quick Start:**

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck

# Lint and format
bun run lint
bun run format
```

**Pull Request Process:**
1. Fork the repo and create your branch
2. Make your changes with tests
3. Ensure all tests pass and code is formatted
4. Submit a PR with a [Conventional Commits](https://www.conventionalcommits.org/) title

---

## References

For detailed technical documentation including architecture, internal components, memory model, and Go comparison, see [REFERENCES.md](./REFERENCES.md).

---

## License

MIT
