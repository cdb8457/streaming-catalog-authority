import { defineConfig, devices } from '@playwright/test';

// Phase 248 — release-candidate browser acceptance configuration.
//
// A single headless Chromium project, pointed at the loopback operator UI the orchestrator started. There is
// no dev server here: the stack is already up (real Compose, real image) before Playwright runs, so this
// config never builds, serves, or reaches the network beyond 127.0.0.1.
//
// ARTIFACTS ARE FAILURE-ONLY AND SANITISED. Screenshots and traces are captured only when a test fails, and
// they are the only diagnostic a failed CI run keeps. The operator token is masked in the password field and
// never rendered, so a screenshot cannot show it; a trace could in principle record a typed value, so the
// orchestrator runs redact-artifacts.sh over this directory and FAILS the collection if any token-like
// material is found before anything is uploaded.

const artifactDir = process.env.PLAYWRIGHT_ARTIFACT_DIR ?? './test-results';
const baseURL = process.env.OPERATOR_UI_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:8099';

export default defineConfig({
  testDir: '.',
  testMatch: /operator-ui\.spec\.mjs/,
  // A browser leg that hangs is a failed leg, not an indefinitely stuck CI job.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: `${artifactDir}/report.json` }]],
  outputDir: `${artifactDir}/traces`,
  use: {
    baseURL,
    headless: true,
    // Loopback only; never follow anything off 127.0.0.1.
    ignoreHTTPSErrors: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
