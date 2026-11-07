import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/native", outputDir: "test-results/native", workers: 1, timeout: 60_000,
  expect: { timeout: 20_000 },
  use: { headless: true, baseURL: "http://127.0.0.1:19292", viewport: { width: 1280, height: 840 }, trace: "retain-on-failure" },
  globalSetup: "./tests/global-setup.ts", metadata: { fixture: "native-server.ts" },
});
