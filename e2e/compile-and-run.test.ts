import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const OUTPUT_BINARY = join(import.meta.dir, "smoke-test-binary");

describe("compile-and-run e2e", () => {
  test("compiles and runs with bun build --compile", async () => {
    // Clean up any previous build
    if (existsSync(OUTPUT_BINARY)) {
      rmSync(OUTPUT_BINARY);
    }

    // Build the test fixture
    const buildResult =
      await $`bun build ${join(FIXTURES_DIR, "smoke.ts")} --compile --outfile ${OUTPUT_BINARY}`.quiet();
    expect(buildResult.exitCode).toBe(0);
    expect(existsSync(OUTPUT_BINARY)).toBe(true);

    // Run the compiled binary
    const runResult = await $`${OUTPUT_BINARY}`.text();
    expect(runResult).toContain("SUCCESS");
    expect(runResult).toContain("result: 42");

    // Clean up
    rmSync(OUTPUT_BINARY);
  }, 60000); // 60 second timeout for compile

  test("runs directly with bun", async () => {
    const result = await $`bun run ${join(FIXTURES_DIR, "smoke.ts")}`.text();
    expect(result).toContain("SUCCESS");
    expect(result).toContain("result: 42");
  });
});
