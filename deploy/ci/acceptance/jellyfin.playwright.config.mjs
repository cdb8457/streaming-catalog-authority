import { defineConfig, devices } from '@playwright/test';

// Phase 266-268 — Jellyfin control plane acceptance configuration.
//
// Its own config, for the same reason Phase 262's is: this leg runs against a DIFFERENT stack — its own
// disposable Compose project, its own loopback port, and a local fake Jellyfin on the Compose network — and a
// shared config that had to branch on which stack it was pointed at would be one edit away from running the
// wrong spec against the wrong installation.
//
// Same discipline as every browser leg here: headless, loopback only, no dev server, no network beyond
// 127.0.0.1, and artifacts captured ONLY on failure. The orchestrator runs redact-artifacts.sh over the
// artifact directory and refuses to promote anything carrying token-like material, so a trace can never be
// uploaded raw.
//
// `acceptDownloads` is deliberately OFF: nothing in this leg downloads anything, and a capability a leg does
// not need is one it should not have.

const artifactDir = process.env.PLAYWRIGHT_ARTIFACT_DIR ?? './test-results';
const baseURL = process.env.OPERATOR_UI_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:8097';

export default defineConfig({
  testDir: '.',
  testMatch: /jellyfin\.spec\.mjs/,
  // A browser leg that hangs is a failed leg, not an indefinitely stuck CI job. A reconcile pass talks to a
  // server over a network, so this is a little longer than the read-only legs elsewhere.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: `${artifactDir}/report.json` }]],
  outputDir: `${artifactDir}/traces`,
  use: {
    baseURL,
    headless: true,
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
