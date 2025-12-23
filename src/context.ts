import type {
  CancelFunc,
  Context,
  ContextError,
  ContextFactory,
  ContextKey,
} from "./types.ts";

class CancellableContext implements Context {
  private controller: AbortController;
  private deadlineMs: number | undefined;
  private error: ContextError | undefined;
  private values: Map<symbol, unknown>;
  private parent: CancellableContext | null;

  constructor(
    parent: CancellableContext | null = null,
    deadline?: number,
    values?: Map<symbol, unknown>,
  ) {
    this.parent = parent;
    this.controller = new AbortController();
    this.values = values ?? new Map();

    if (parent) {
      const parentDeadline = parent.deadline();
      if (parentDeadline !== undefined && deadline !== undefined) {
        this.deadlineMs = Math.min(parentDeadline, deadline);
      } else {
        this.deadlineMs = deadline ?? parentDeadline;
      }

      if (!parent.done()) {
        parent.signal.addEventListener(
          "abort",
          () => {
            if (!this.controller.signal.aborted) {
              this.error = parent.err();
              this.controller.abort();
            }
          },
          { once: true },
        );
      } else {
        this.error = parent.err();
        this.controller.abort();
      }
    } else {
      this.deadlineMs = deadline;
    }
  }

  deadline(): number | undefined {
    return this.deadlineMs;
  }

  done(): boolean {
    return this.controller.signal.aborted;
  }

  err(): ContextError | undefined {
    return this.error;
  }

  value<T>(key: ContextKey<T>): T | undefined {
    if (this.values.has(key)) {
      return this.values.get(key) as T;
    }
    if (this.parent) {
      return this.parent.value(key);
    }
    return undefined;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(err: ContextError): void {
    if (this.controller.signal.aborted) return;
    this.error = err;
    this.controller.abort();
  }

  getAllValues(): Map<symbol, unknown> {
    const allValues = new Map<symbol, unknown>();
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

class BackgroundContext implements Context {
  private static instance: BackgroundContext | null = null;
  private controller = new AbortController();

  static getInstance(): BackgroundContext {
    if (!BackgroundContext.instance) {
      BackgroundContext.instance = new BackgroundContext();
    }
    return BackgroundContext.instance;
  }

  deadline(): number | undefined {
    return undefined;
  }

  done(): boolean {
    return false;
  }

  err(): ContextError | undefined {
    return undefined;
  }

  value<T>(_key: ContextKey<T>): T | undefined {
    return undefined;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

class TodoContext implements Context {
  private static instance: TodoContext | null = null;
  private controller = new AbortController();

  static getInstance(): TodoContext {
    if (!TodoContext.instance) {
      TodoContext.instance = new TodoContext();
    }
    return TodoContext.instance;
  }

  deadline(): number | undefined {
    return undefined;
  }

  done(): boolean {
    return false;
  }

  err(): ContextError | undefined {
    return undefined;
  }

  value<T>(_key: ContextKey<T>): T | undefined {
    return undefined;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

/**
 * Context factory providing Go-style context creation functions.
 */
export const context: ContextFactory = {
  /** Returns a root context that is never cancelled. */
  background(): Context {
    return BackgroundContext.getInstance();
  },

  /** Returns a root context for operations where context is not yet determined. */
  todo(): Context {
    return TodoContext.getInstance();
  },

  /** Returns a cancellable child context. */
  withCancel(parent: Context): [Context, CancelFunc] {
    const parentCtx =
      parent instanceof CancellableContext
        ? parent
        : new CancellableContext(null, parent.deadline());

    const ctx = new CancellableContext(parentCtx);

    const cancel: CancelFunc = (reason?: string) => {
      ctx.cancel({ type: "cancelled", reason });
    };

    return [ctx, cancel];
  },

  /** Returns a child context that cancels after the specified duration (ms). */
  withTimeout(parent: Context, timeoutMs: number): [Context, CancelFunc] {
    return context.withDeadline(parent, Date.now() + timeoutMs);
  },

  /** Returns a child context that cancels at the specified deadline (ms since epoch). */
  withDeadline(parent: Context, deadline: number): [Context, CancelFunc] {
    const parentCtx =
      parent instanceof CancellableContext
        ? parent
        : new CancellableContext(null, parent.deadline());

    const ctx = new CancellableContext(parentCtx, deadline);

    const now = Date.now();
    const effectiveDeadline = ctx.deadline();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (effectiveDeadline !== undefined && effectiveDeadline > now) {
      const delay = effectiveDeadline - now;
      timeoutId = setTimeout(() => {
        ctx.cancel({ type: "deadline_exceeded", deadline: effectiveDeadline });
      }, delay);
    } else if (effectiveDeadline !== undefined && effectiveDeadline <= now) {
      ctx.cancel({ type: "deadline_exceeded", deadline: effectiveDeadline });
    }

    const cancel: CancelFunc = (reason?: string) => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      ctx.cancel({ type: "cancelled", reason });
    };

    return [ctx, cancel];
  },

  /** Returns a child context with an attached key-value pair. */
  withValue<T>(parent: Context, key: ContextKey<T>, value: T): Context {
    const parentCtx =
      parent instanceof CancellableContext
        ? parent
        : new CancellableContext(null, parent.deadline());

    const values = new Map<symbol, unknown>();
    values.set(key, value);

    return new CancellableContext(parentCtx, undefined, values);
  },
};

export function isContext(value: unknown): value is Context {
  return (
    value !== null &&
    typeof value === "object" &&
    "deadline" in value &&
    "done" in value &&
    "err" in value &&
    "value" in value &&
    "signal" in value
  );
}

export function getContextValues(ctx: Context): Map<symbol, unknown> {
  if (ctx instanceof CancellableContext) {
    return ctx.getAllValues();
  }
  return new Map();
}
