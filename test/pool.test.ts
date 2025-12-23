import { afterEach, describe, expect, test } from "bun:test";
import { co, QueueFullError } from "../src";

describe("pool", () => {
  afterEach(async () => {
    await co.pool.shutdown({ force: true });
  });

  test("processes multiple tasks concurrently", async () => {
    const startTime = Date.now();
    const handles = Array.from({ length: 4 }, (_, i) =>
      co(async (n: number) => {
        await new Promise((r) => setTimeout(r, 100));
        return n;
      }, i),
    );

    const results = await Promise.all(handles.map((h) => h.promise));
    const elapsed = Date.now() - startTime;

    expect(results).toEqual([0, 1, 2, 3]);
    // Should complete faster than sequential (4 * 100ms = 400ms)
    expect(elapsed).toBeLessThan(350);
  });

  test("respects maxQueue configuration", async () => {
    co.pool.configure({ poolSize: 1, maxQueue: 3 });

    // Fill the pool with a long-running task
    const handle1 = co(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 1;
    });

    // Fill the queue (note: handle1 also starts in queue while worker initializes)
    const handle2 = co(() => 2);
    const handle3 = co(() => 3);

    // Next task should be rejected (queue: handle1, handle2, handle3 = 3 items)
    const handle4 = co(() => 4);
    await expect(handle4.promise).rejects.toBeInstanceOf(QueueFullError);

    // Clean up - catch the cancellation errors
    handle1.cancel();
    handle2.cancel();
    handle3.cancel();
    await Promise.allSettled([
      handle1.promise,
      handle2.promise,
      handle3.promise,
    ]);
  });

  test("configure updates pool settings", () => {
    expect(() => co.pool.configure({ poolSize: 8 })).not.toThrow();
    expect(() => co.pool.configure({ maxQueue: 500 })).not.toThrow();
    expect(() => co.pool.configure({ idleTerminateMs: 60000 })).not.toThrow();
  });

  test("handles many concurrent tasks", async () => {
    const count = 20;
    const handles = Array.from({ length: count }, (_, i) =>
      co((n: number) => n * 2, i),
    );

    const results = await Promise.all(handles.map((h) => h.promise));

    expect(results).toHaveLength(count);
    results.forEach((result, i) => {
      expect(result).toBe(i * 2);
    });
  });
});
