import { afterEach, describe, expect, test } from "bun:test";
import { CancelledError, type ContextKey, co, context } from "../src";

describe("context", () => {
  afterEach(async () => {
    await co.pool.shutdown({ force: true });
  });

  describe("background", () => {
    test("creates a context that is never cancelled", () => {
      const ctx = context.background();
      expect(ctx.done()).toBe(false);
      expect(ctx.err()).toBeUndefined();
      expect(ctx.deadline()).toBeUndefined();
    });

    test("returns the same instance", () => {
      const ctx1 = context.background();
      const ctx2 = context.background();
      expect(ctx1).toBe(ctx2);
    });
  });

  describe("todo", () => {
    test("creates a context like background", () => {
      const ctx = context.todo();
      expect(ctx.done()).toBe(false);
      expect(ctx.err()).toBeUndefined();
      expect(ctx.deadline()).toBeUndefined();
    });
  });

  describe("withCancel", () => {
    test("creates a cancellable context", () => {
      const [ctx, cancel] = context.withCancel(context.background());
      expect(ctx.done()).toBe(false);

      cancel();

      expect(ctx.done()).toBe(true);
      expect(ctx.err()?.type).toBe("cancelled");
    });

    test("cancel with reason", () => {
      const [ctx, cancel] = context.withCancel(context.background());
      cancel("user requested");

      expect(ctx.done()).toBe(true);
      expect(ctx.err()).toEqual({
        type: "cancelled",
        reason: "user requested",
      });
    });

    test("cancelling parent cancels child", () => {
      const [parentCtx, parentCancel] = context.withCancel(
        context.background(),
      );
      const [childCtx] = context.withCancel(parentCtx);

      expect(childCtx.done()).toBe(false);

      parentCancel();

      expect(parentCtx.done()).toBe(true);
      expect(childCtx.done()).toBe(true);
    });

    test("cancelling child does not cancel parent", () => {
      const [parentCtx] = context.withCancel(context.background());
      const [childCtx, childCancel] = context.withCancel(parentCtx);

      childCancel();

      expect(childCtx.done()).toBe(true);
      expect(parentCtx.done()).toBe(false);
    });
  });

  describe("withTimeout", () => {
    test("creates a context with timeout", async () => {
      const [ctx, cancel] = context.withTimeout(context.background(), 50);

      expect(ctx.done()).toBe(false);
      expect(ctx.deadline()).toBeDefined();

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 100));

      expect(ctx.done()).toBe(true);
      expect(ctx.err()?.type).toBe("deadline_exceeded");

      cancel(); // cleanup
    });

    test("cancel before timeout", async () => {
      const [ctx, cancel] = context.withTimeout(context.background(), 1000);

      cancel("early cancel");

      expect(ctx.done()).toBe(true);
      expect(ctx.err()?.type).toBe("cancelled");
    });

    test("inherits shorter deadline from parent", () => {
      const [parentCtx, parentCancel] = context.withTimeout(
        context.background(),
        1000,
      );
      const [childCtx, childCancel] = context.withTimeout(parentCtx, 500);

      // Child deadline should be sooner
      const childDeadline = childCtx.deadline();
      const parentDeadline = parentCtx.deadline();

      expect(childDeadline).toBeDefined();
      expect(parentDeadline).toBeDefined();
      expect(childDeadline).toBeLessThanOrEqual(parentDeadline as number);

      parentCancel();
      childCancel();
    });
  });

  describe("withDeadline", () => {
    test("creates a context with absolute deadline", async () => {
      const deadline = Date.now() + 50;
      const [ctx, cancel] = context.withDeadline(
        context.background(),
        deadline,
      );

      expect(ctx.deadline()).toBe(deadline);

      // Wait for deadline
      await new Promise((r) => setTimeout(r, 100));

      expect(ctx.done()).toBe(true);
      expect(ctx.err()?.type).toBe("deadline_exceeded");

      cancel();
    });

    test("already passed deadline", () => {
      const deadline = Date.now() - 100; // past deadline
      const [ctx, cancel] = context.withDeadline(
        context.background(),
        deadline,
      );

      expect(ctx.done()).toBe(true);
      expect(ctx.err()?.type).toBe("deadline_exceeded");

      cancel();
    });
  });

  describe("withValue", () => {
    test("stores and retrieves values", () => {
      const userKey: ContextKey<string> = Symbol("user") as ContextKey<string>;
      const ctx = context.withValue(context.background(), userKey, "alice");

      expect(ctx.value(userKey)).toBe("alice");
    });

    test("child inherits parent values", () => {
      const key1: ContextKey<string> = Symbol("key1") as ContextKey<string>;
      const key2: ContextKey<number> = Symbol("key2") as ContextKey<number>;

      const ctx1 = context.withValue(context.background(), key1, "value1");
      const ctx2 = context.withValue(ctx1, key2, 42);

      expect(ctx2.value(key1)).toBe("value1");
      expect(ctx2.value(key2)).toBe(42);
    });

    test("child can override parent values", () => {
      const key: ContextKey<string> = Symbol("key") as ContextKey<string>;

      const parent = context.withValue(context.background(), key, "parent");
      const child = context.withValue(parent, key, "child");

      expect(parent.value(key)).toBe("parent");
      expect(child.value(key)).toBe("child");
    });

    test("returns undefined for unknown keys", () => {
      const key: ContextKey<string> = Symbol("key") as ContextKey<string>;
      const ctx = context.background();

      expect(ctx.value(key)).toBeUndefined();
    });
  });

  describe("signal interop", () => {
    test("context has AbortSignal", () => {
      const ctx = context.background();
      expect(ctx.signal).toBeDefined();
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
    });

    test("signal is aborted when context is cancelled", () => {
      const [ctx, cancel] = context.withCancel(context.background());
      expect(ctx.signal.aborted).toBe(false);

      cancel();

      expect(ctx.signal.aborted).toBe(true);
    });
  });
});

describe("co with context", () => {
  afterEach(async () => {
    await co.pool.shutdown({ force: true });
  });

  test("executes with context", async () => {
    const ctx = context.background();
    const handle = co(ctx, () => 42);

    expect(await handle.promise).toBe(42);
  });

  test("co.promise with context", async () => {
    const ctx = context.background();
    const result = await co.promise(ctx, () => "hello");

    expect(result).toBe("hello");
  });

  test("context cancellation rejects task", async () => {
    const [ctx, cancel] = context.withCancel(context.background());

    const handle = co(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "should not reach";
    });

    cancel();

    await expect(handle.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("context timeout rejects task", async () => {
    const [ctx, cancel] = context.withTimeout(context.background(), 50);

    const handle = co(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "should not reach";
    });

    await expect(handle.promise).rejects.toThrow();

    cancel();
  });

  test("already cancelled context rejects immediately", async () => {
    const [ctx, cancel] = context.withCancel(context.background());
    cancel();

    const handle = co(ctx, () => "should not execute");

    await expect(handle.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("works without context", async () => {
    const result = await co.promise(() => 123);
    expect(result).toBe(123);
  });
});

describe("co.pool", () => {
  afterEach(async () => {
    await co.pool.shutdown({ force: true });
  });

  test("configure via co.pool", () => {
    expect(() => co.pool.configure({ poolSize: 4 })).not.toThrow();
  });

  test("stats returns pool statistics", async () => {
    // Execute a task to ensure pool is initialized
    await co.promise(() => 1);

    const stats = co.pool.stats();
    expect(stats).toHaveProperty("workers");
    expect(stats).toHaveProperty("idle");
    expect(stats).toHaveProperty("busy");
    expect(stats).toHaveProperty("queued");
  });

  test("shutdown via co.pool", async () => {
    await co.promise(() => 1);
    await expect(co.pool.shutdown()).resolves.toBeUndefined();
  });
});
