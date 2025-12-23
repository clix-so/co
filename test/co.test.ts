import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { co } from "../src";

describe("co", () => {
  afterEach(async () => {
    await co.pool.shutdown({ force: true });
  });

  test("executes a simple function", async () => {
    const handle = co((a: number, b: number) => a + b, 2, 3);
    expect(handle.id).toBeDefined();
    expect(await handle.promise).toBe(5);
  });

  test("executes an async function", async () => {
    const handle = co(async (x: number) => {
      await new Promise((r) => setTimeout(r, 10));
      return x * 2;
    }, 21);
    expect(await handle.promise).toBe(42);
  });

  test("co.promise returns just the promise", async () => {
    const result = await co.promise((x: number) => x * x, 7);
    expect(result).toBe(49);
  });

  test("handles errors", async () => {
    const handle = co(() => {
      throw new Error("test error");
    });
    await expect(handle.promise).rejects.toThrow("test error");
  });

  test("handles async errors", async () => {
    const handle = co(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("async error");
    });
    await expect(handle.promise).rejects.toThrow("async error");
  });

  test("returns different types", async () => {
    expect(await co.promise(() => "string")).toBe("string");
    expect(await co.promise(() => 123)).toBe(123);
    expect(await co.promise(() => true)).toBe(true);
    expect(await co.promise(() => null)).toBe(null);
    expect(await co.promise(() => ({ a: 1 }))).toEqual({ a: 1 });
    expect(await co.promise(() => [1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("handles multiple arguments", async () => {
    const result = await co.promise(
      (a: number, b: string, c: boolean) => `${a}-${b}-${c}`,
      1,
      "two",
      true,
    );
    expect(result).toBe("1-two-true");
  });

  describe("external dependencies", () => {
    test("cannot access variables from outer scope via dynamic reference", async () => {
      // Variables referenced dynamically (not inlined) will fail
      const obj = { value: 42 };
      const handle = co(() => {
        // obj is not available in worker scope
        return obj.value;
      });
      await expect(handle.promise).rejects.toThrow();
    });

    test("cannot access imported modules in worker", async () => {
      const handle = co(() => {
        // 'expect' from bun:test is not available in worker
        return expect;
      });
      await expect(handle.promise).rejects.toThrow();
    });

    test("cannot use Node.js built-in modules imported in main thread", async () => {
      const handle = co(() => {
        // 'path' module imported at top level is not available in worker
        return path.join("a", "b");
      });
      await expect(handle.promise).rejects.toThrow();
    });

    test("CAN dynamically import modules in worker (Bun Workers support)", async () => {
      // Bun Workers support dynamic imports unlike standard Web Workers
      const result = await co.promise(async () => {
        const fs = await import("node:fs");
        return fs.existsSync("/");
      });
      expect(result).toBe(true);
    });

    test("CAN use dynamically imported path module in worker", async () => {
      const result = await co.promise(async () => {
        const path = await import("node:path");
        return path.join("a", "b", "c");
      });
      expect(result).toBe("a/b/c");
    });

    test("can use built-in globals (Math, JSON, etc.)", async () => {
      const result = await co.promise(() => {
        return Math.max(1, 2, 3) + JSON.parse('{"a":1}').a;
      });
      expect(result).toBe(4);
    });

    test("can use Web APIs available in workers (crypto, fetch, etc.)", async () => {
      const result = await co.promise(() => {
        return typeof crypto.randomUUID === "function";
      });
      expect(result).toBe(true);
    });

    test("should pass dependencies as arguments instead of closure", async () => {
      const config = { multiplier: 10 };
      const data = [1, 2, 3];

      const result = await co.promise(
        (cfg: typeof config, arr: typeof data) => {
          return arr.map((x) => x * cfg.multiplier);
        },
        config,
        data,
      );
      expect(result).toEqual([10, 20, 30]);
    });

    test("complex objects can be passed as arguments (serializable)", async () => {
      const input = {
        nested: { value: 100 },
        array: [{ id: 1 }, { id: 2 }],
      };

      const result = await co.promise((obj: typeof input) => {
        return obj.nested.value + obj.array.length;
      }, input);
      expect(result).toBe(102);
    });

    test("non-serializable arguments cause worker error", async () => {
      const fn = (x: number) => x * 2;

      // Functions cannot be serialized via structured clone
      // This causes a DataCloneError when postMessage is called
      const handle = co((callback: (x: number) => number) => {
        return callback(5);
      }, fn);

      await expect(handle.promise).rejects.toThrow();
    });
  });
});
