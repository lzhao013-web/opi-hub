import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser", outputDir: "test-results/browser", fullyParallel: false, workers: 1, timeout: 30_000,
  use: { headless: true, baseURL: "http://127.0.0.1:19291", trace: "retain-on-failure" },
  globalSetup: "./tests/global-setup.ts", metadata: { fixture: "browser-server.ts" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 840 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 } } },
  ],
});
