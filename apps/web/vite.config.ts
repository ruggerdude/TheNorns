import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Playwright's e2e specs live under e2e/ and run through @playwright/test,
    // not Vitest — keep the two runners from tripping over each other's files.
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
