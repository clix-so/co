import { co } from "../../src";

async function main() {
  console.log("Starting smoke test...");

  try {
    // Test 1: Basic execution
    console.log("Test 1: Basic execution");
    const handle = co((a: number, b: number) => a + b, 20, 22);
    const result = await handle.promise;
    console.log(`result: ${result}`);

    if (result !== 42) {
      console.log("FAILURE: Wrong result");
      process.exit(1);
    }

    // Test 2: Async function
    console.log("Test 2: Async function");
    const asyncResult = await co.promise(async (x: number) => {
      await new Promise((r) => setTimeout(r, 10));
      return x * 2;
    }, 21);

    if (asyncResult !== 42) {
      console.log("FAILURE: Async result wrong");
      process.exit(1);
    }

    // Test 3: Multiple concurrent tasks
    console.log("Test 3: Multiple concurrent tasks");
    const handles = [co(() => 1), co(() => 2), co(() => 3)];
    const results = await Promise.all(handles.map((h) => h.promise));
    if (results.join(",") !== "1,2,3") {
      console.log("FAILURE: Concurrent tasks wrong");
      process.exit(1);
    }

    // Test 4: Error handling
    console.log("Test 4: Error handling");
    const errorHandle = co(() => {
      throw new Error("expected error");
    });
    try {
      await errorHandle.promise;
      console.log("FAILURE: Should have thrown");
      process.exit(1);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("expected error")) {
        console.log("FAILURE: Wrong error");
        process.exit(1);
      }
    }

    // Clean shutdown
    await co.pool.shutdown();

    console.log("SUCCESS");
    process.exit(0);
  } catch (error) {
    console.error("FAILURE:", error);
    process.exit(1);
  }
}

main();
