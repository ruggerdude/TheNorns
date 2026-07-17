import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The server suite contains real PGlite, Git, WebSocket, and optional
    // Docker integration files. Unbounded file parallelism causes CPU/I/O
    // contention and false 5-second timeouts as the suite grows.
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
