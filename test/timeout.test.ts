import { afterEach, describe, expect, test } from "bun:test";
import { co, context, DeadlineExceededError } from "../src";

describe("timeout", () => {
  afterEach(async () => {
    await co.pool.shutdown({ force: true });
  });

  test("times out after specified duration", async () => {
    const [ctx, cancel] = context.withTimeout(context.background(), 50);

    const handle = co(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "should not reach";
    });

    await expect(handle.promise).rejects.toThrow();
    cancel();
  });

  test("completes before timeout", async () => {
    const [ctx, cancel] = context.withTimeout(context.background(), 1000);

    const handle = co(ctx, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "completed";
    });

    expect(await handle.promise).toBe("completed");
    cancel();
  });

  test("timeout cancels the task quickly", async () => {
    const startTime = Date.now();
    const [ctx, cancel] = context.withTimeout(context.background(), 100);

    const handle = co(ctx, async () => {
      await new Promise((r) => setTimeout(r, 10000));
      return "should not reach";
    });

    try {
      await handle.promise;
    } catch {
      // Expected
    }

    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(200);
    cancel();
  });

  test("timeout with sync function", async () => {
    // Sync functions that don't await won't respect timeout during execution
    // but timeout still works for queued tasks
    const [ctx, cancel] = context.withTimeout(context.background(), 1000);

    const result = await co.promise(ctx, () => {
      return "completed";
    });

    expect(result).toBe("completed");
    cancel();
  });

  test("multiple tasks with different timeouts", async () => {
    const [fastCtx, fastCancel] = context.withTimeout(
      context.background(),
      1000,
    );
    const [slowCtx, slowCancel] = context.withTimeout(context.background(), 50);

    const fast = co(fastCtx, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "fast";
    });

    const slow = co(slowCtx, async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "slow";
    });

    expect(await fast.promise).toBe("fast");
    await expect(slow.promise).rejects.toThrow();

    fastCancel();
    slowCancel();
  });

  test("deadline exceeded error type", async () => {
    const [ctx, cancel] = context.withTimeout(context.background(), 30);

    const handle = co(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "should not reach";
    });

    await expect(handle.promise).rejects.toBeInstanceOf(DeadlineExceededError);
    cancel();
  });
});
