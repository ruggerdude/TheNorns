import { defineConfig, devices } from "@playwright/test";

// Real-browser regression layer, for the handful of things jsdom can't tell
// us (actual layout, actual CSS, actual pointer/drag semantics on the graph
// canvas). The Vitest + React Testing Library suite (src/**/*.test.tsx) is
// the primary, must-pass layer for the 7 UI findings — all of them are
// frontend state-logic bugs that don't need a real browser to reproduce.
// This config exists so a real-browser layer is ready to grow into once a
// findings-specific case needs it (e.g. drag-and-drop on the graph canvas).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  use: {
    // "localhost" (not 127.0.0.1): vite dev only binds the IPv6 loopback by
    // default in this environment, and 127.0.0.1 (IPv4) doesn't reach it.
    baseURL: "http://localhost:5173",
  },
  webServer: {
    command: "pnpm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
