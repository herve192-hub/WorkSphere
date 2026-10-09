const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // A single worker also keeps login attempts within the real API rate limit.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  globalTimeout: 5 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.WORKSPHERE_E2E_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
