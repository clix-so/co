import { afterEach, describe, expect, test } from "bun:test";
import { CancelledError, co, context } from "../src";

describe("cancel", () => {
  afterEach(async () => {
    await co.pool.shutdown({ force: true });
  });

  test("cancels a pending task", async () => {
    const handle = co(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "should not reach";
    });

    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("cancels using context.withCancel", async () => {
    const [ctx, cancel] = context.withCancel(context.background());

    const handle = co(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "should not reach";
    });

    setTimeout(() => cancel(), 50);
    await expect(handle.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("cancelling completed task is no-op", async () => {
    const handle = co(() => 42);
    const result = await handle.promise;

    expect(result).toBe(42);
    expect(() => handle.cancel()).not.toThrow();
  });

  test("cancel with already cancelled context", async () => {
    const [ctx, cancel] = context.withCancel(context.background());
    cancel();

    const handle = co(ctx, async () => {
      return "should not reach";
    });

    await expect(handle.promise).rejects.toBeInstanceOf(CancelledError);
  });

  test("cancel multiple tasks", async () => {
    const handles = Array.from({ length: 5 }, () =>
      co(async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return "should not reach";
      }),
    );

    for (const h of handles) {
      h.cancel();
    }

    for (const handle of handles) {
      await expect(handle.promise).rejects.toBeInstanceOf(CancelledError);
    }
  });
});
