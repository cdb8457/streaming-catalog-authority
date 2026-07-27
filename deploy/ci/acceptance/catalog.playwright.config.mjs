import { defineConfig, devices } from '@playwright/test';

// Phase 262 — catalog import-and-browse acceptance configuration.
//
// Deliberately its own config rather than a flag on the Phase 248 one: this leg runs against a DIFFERENT
// stack (its own disposable Compose project, its own loopback port, a database that has been migrated and
// then filled from a snapshot), and a shared config that had to branch on which stack it was pointed at
// would be one edit away from running the wrong spec against the wrong installation.
//
// Same discipline as Phase 248: headless, loopback only, no dev server, no network beyond 127.0.0.1, and
// artifacts captured ONLY on failure. The orchestrator runs redact-artifacts.sh over the artifact directory
// and refuses to promote anything that carries token-like material, so a trace can never be uploaded raw.

const artifactDir = process.env.PLAYWRIGHT_ARTIFACT_DIR ?? './test-results';
const baseURL = process.env.OPERATOR_UI_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:8098';

export default defineConfig({
  testDir: '.',
  testMatch: /catalog\.spec\.mjs/,
  // A browser leg that hangs is a failed leg, not an indefinitely stuck CI job.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: `${artifactDir}/report.json` }]],
  outputDir: `${artifactDir}/traces`,
  use: {
    baseURL,
    headless: true,
    // Stated rather than inherited. Phase 265's export leg drives a REAL download and reads the file back
    // off disk; that only works with downloads accepted, and a leg whose whole subject depends on a
    // framework default is a leg that breaks silently the day the default changes.
    acceptDownloads: true,
    ignoreHTTPSErrors: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
