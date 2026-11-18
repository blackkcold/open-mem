import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The orchestrator uses real timers and temp-dir I/O; full-suite runs are
    // CPU-bound on 8 workers, so the default 5s and the older 20s are too tight
    // for the multi-step reliability and wiring cases.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
