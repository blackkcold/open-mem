import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The orchestrator uses real timers and temp-dir I/O; under a full parallel
    // run the default 5s is too tight for the multi-step reliability cases.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
