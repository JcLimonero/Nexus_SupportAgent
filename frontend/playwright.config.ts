import { defineConfig } from "@playwright/test";

// Browser E2E — needs the full stack running (`docker compose up -d`).
// Run with: npm run e2e
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  // Specs share real backend state (sessions, docs) — run serially.
  workers: 1,
  globalSetup: "./e2e/global.setup.ts",
  globalTeardown: "./e2e/global.teardown.ts",
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_WEB_URL || "http://localhost:3000",
    locale: "es-MX",
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
});
