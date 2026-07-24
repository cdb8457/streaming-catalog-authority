import { test, expect } from '@playwright/test';

// Phase 248 — the operator UI, exercised in a REAL headless Chromium against the REAL extracted Compose
// stack. Everything here is behaviour a fake DOM cannot prove: that a real browser enforces the CSP, that no
// console error or CSP violation occurs on a normal load, that inline/data/blob/javascript execution is
// actually refused by the engine, and that the token never lands anywhere a browser persists things.
//
// The operator token arrives ONLY via the environment, from the isolated orchestrator that generated it. It
// is never printed. Every assertion that involves the token uses a boolean form — expect(x.includes(token))
// .toBe(false) — so a failure message can never contain it, and it is never passed into a matcher that would
// echo it into the report.

const TOKEN = process.env.OPERATOR_UI_ACCEPTANCE_TOKEN ?? '';
const BASE_URL = process.env.OPERATOR_UI_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:8099';
const EXPECTED_VERSION = process.env.OPERATOR_UI_ACCEPTANCE_VERSION ?? '';
const ORIGIN = new URL(BASE_URL).host;

if (TOKEN === '') throw new Error('OPERATOR_UI_ACCEPTANCE_TOKEN is required and must not be empty');

/** Install collectors for everything a real browser can tell us, before any page script runs. */
function instrument(page) {
  const collected = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failed: [], requests: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') collected.consoleErrors.push(msg.text());
    if (msg.type() === 'warning') collected.consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => collected.pageErrors.push(String(err)));
  page.on('requestfailed', (req) => collected.failed.push({ url: req.url(), method: req.method() }));
  page.on('request', (req) => collected.requests.push({ url: req.url(), method: req.method(), post: req.postData() ?? '' }));
  return collected;
}

async function installCspCollector(page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blockedURI: event.blockedURI,
      });
    });
  });
}

async function load(page) {
  await installCspCollector(page);
  const collected = instrument(page);
  const response = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  expect(response, 'the shell responded').toBeTruthy();
  expect(response.status(), 'the shell is 200').toBe(200);
  return collected;
}

async function loadWithToken(page) {
  const collected = await load(page);
  await page.locator('#token').fill(TOKEN);
  await page.locator('#refresh').click();
  await expect(page.locator('#verdict')).toHaveText(/READY|NEEDS_SETUP|DEGRADED/, { timeout: 20_000 });
  return collected;
}

// -----------------------------------------------------------------------------------------------------------
// The real browser, the real CSP
// -----------------------------------------------------------------------------------------------------------

test('the shell and its external JS/CSS load under the real CSP with no errors or violations', async ({ page }) => {
  const collected = await load(page);

  // The CSP header the real server sent, as the browser received it.
  const response = await page.request.get(BASE_URL);
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("default-src 'none'");
  expect(csp.includes('unsafe-inline')).toBe(false);
  expect(csp.includes('unsafe-eval')).toBe(false);

  // The external assets actually loaded — no blocked or failed asset.
  const failedAssets = collected.failed.filter((r) => /\/assets\/app\.(js|css)$/.test(r.url));
  expect(failedAssets, 'no operator UI asset failed to load').toEqual([]);
  expect(collected.consoleErrors, 'no console errors on load').toEqual([]);
  expect(collected.pageErrors, 'no uncaught page errors on load').toEqual([]);

  const violations = await page.evaluate(() => window.__cspViolations);
  expect(violations, 'a compliant page produces no CSP violations on load').toEqual([]);

  // No mixed content and no unexpected outbound request: everything is loopback, same-origin, http.
  for (const req of collected.requests) {
    const host = new URL(req.url).host;
    expect(host, `request to ${host} is same-origin`).toBe(ORIGIN);
    expect(req.url.startsWith('https://'), 'no https/mixed content on the loopback stack').toBe(false);
  }

  // No service worker was registered or is controlling the page.
  const sw = await page.evaluate(async () => {
    const controller = navigator.serviceWorker ? navigator.serviceWorker.controller : null;
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    return { controlled: controller !== null, registrations: regs.length };
  });
  expect(sw.controlled).toBe(false);
  expect(sw.registrations).toBe(0);
});

// -----------------------------------------------------------------------------------------------------------
// First-run UX, end to end
// -----------------------------------------------------------------------------------------------------------

test('unauthenticated guidance is visible before any token is entered', async ({ page }) => {
  await load(page);
  await expect(page.locator('#setup-panel')).toContainText('Setup & Diagnostics');
  await expect(page.locator('#firstrun-panel')).toContainText('First-run checklist');
  await expect(page.locator('#trouble-panel')).toContainText('Troubleshooting');
  // The "read your token" guidance is part of the unauthenticated shell.
  await expect(page.locator('body')).toContainText('operator_ui_token');
  // Nothing operational has loaded yet.
  await expect(page.locator('#verdict')).toHaveText('Not loaded');
});

test('a wrong token is refused, and correcting it recovers without a reload', async ({ page }) => {
  await load(page);
  await page.locator('#token').fill('this-is-not-the-token-but-long-enough');
  await page.locator('#refresh').click();
  await expect(page.locator('#statusText')).toContainText(/token was not accepted/i, { timeout: 20_000 });
  await expect(page.locator('#statusText')).toHaveClass(/err/);
  await expect(page.locator('#verdict')).toHaveText('Not loaded');

  await page.locator('#token').fill(TOKEN);
  await page.locator('#refresh').click();
  await expect(page.locator('#verdict')).toHaveText(/READY|NEEDS_SETUP|DEGRADED/, { timeout: 20_000 });
});

test('a valid token loads installation, status, logs, promotion and version, in agreement', async ({ page }) => {
  const collected = await loadWithToken(page);

  // Installation verdict (this route always answers 200, so it is the load that must populate).
  await expect(page.locator('#verdict')).toHaveText(/READY|NEEDS_SETUP|DEGRADED/);
  // Logs rendered a positive count.
  const logCount = Number(await page.locator('#logCount').textContent());
  expect(logCount).toBeGreaterThan(0);
  // Promotion chain rendered an outcome (even "UNAVAILABLE" is a rendered outcome, not the placeholder).
  await expect(page.locator('#chainOutcome')).not.toHaveText('-');
  // Version: the image and the bundle that started it agree (deliverable 5 — version/revision agreement).
  await expect(page.locator('#verAgreement')).toHaveText('AGREES');
  if (EXPECTED_VERSION !== '') {
    await expect(page.locator('#verVersion')).toHaveText(EXPECTED_VERSION);
  }
  // All five operational routes were exercised. On a freshly-started stack the database has not been migrated,
  // so /api/status answers 503 (a dependency-not-ready state the page surfaces rather than crashes on) — the
  // point here is that the route was driven, which the request log proves.
  for (const route of ['/api/installation', '/api/status', '/api/logs', '/api/promotion-chain']) {
    expect(collected.requests.some((r) => r.url.endsWith(route)), `the page requested ${route}`).toBe(true);
  }
  // /api/version is the standalone route; it answers with the same agreement the panel shows.
  const versionRes = await page.request.get(`${BASE_URL}/api/version`, { headers: { 'x-operator-ui-secret': TOKEN } });
  expect(versionRes.status()).toBe(200);
  expect((await versionRes.json()).version.agreement).toBe('AGREES');
});

test('Clear resets the token and every rendered panel; a reload clears the token too', async ({ page }) => {
  await loadWithToken(page);
  // A panel is populated first (the installation verdict always loads).
  await expect(page.locator('#verdict')).toHaveText(/READY|NEEDS_SETUP|DEGRADED/);
  const loadedLogs = Number(await page.locator('#logCount').textContent());
  expect(loadedLogs).toBeGreaterThan(0);

  await page.locator('#clear').click();
  expect(await page.locator('#token').inputValue()).toBe('');
  await expect(page.locator('#verdict')).toHaveText('Not loaded');
  await expect(page.locator('#service')).toHaveText('-');
  await expect(page.locator('#logCount')).toHaveText('-');
  await expect(page.locator('#statusText')).toContainText(/cleared from this page/i);

  // Enter it again, then reload: the token lives only in the input, so a fresh document has an empty field.
  await page.locator('#token').fill(TOKEN);
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.locator('#token').inputValue()).toBe('');
  await expect(page.locator('#verdict')).toHaveText('Not loaded');
});

// -----------------------------------------------------------------------------------------------------------
// Accessibility and responsive layout
// -----------------------------------------------------------------------------------------------------------

test('keyboard order, visible focus, accessible names and a live status region', async ({ page }) => {
  await load(page);

  // Accessible names: the input has an associated label, the buttons name themselves.
  await expect(page.locator('label[for="token"]')).toHaveText('Operator token');
  await expect(page.locator('#refresh')).toHaveText('Load everything');
  await expect(page.locator('#clear')).toHaveText('Clear');
  // The status line announces changes to assistive technology.
  await expect(page.locator('#statusText')).toHaveAttribute('role', 'status');
  await expect(page.locator('#statusText')).toHaveAttribute('aria-live', 'polite');

  // Keyboard order is DOM order: token -> Load everything -> Clear.
  await page.locator('#token').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('refresh');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('clear');

  // Keyboard focus is visible: :focus-visible gives the focused control an outline.
  const outline = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { width: style.outlineWidth, styleName: style.outlineStyle };
  });
  expect(outline.styleName).not.toBe('none');
  expect(outline.width).not.toBe('0px');
});

test('a 320px mobile viewport has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await load(page);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // Allow a 1px rounding slack; anything more is a real horizontal scrollbar.
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

// -----------------------------------------------------------------------------------------------------------
// Security, proven by the real engine
// -----------------------------------------------------------------------------------------------------------

test('every operational API is 401 without a token; health is minimal', async ({ page }) => {
  for (const route of ['/api/installation', '/api/status', '/api/logs', '/api/promotion-chain', '/api/version']) {
    const res = await page.request.get(`${BASE_URL}${route}`);
    expect(res.status(), `${route} requires the token`).toBe(401);
  }
  const health = await page.request.get(`${BASE_URL}/healthz`);
  expect(health.status()).toBe(200);
  const body = await health.json();
  expect(Object.keys(body).sort()).toEqual(['code', 'mode', 'ok', 'service']);
});

test('after a full authenticated load, the token is in no browser-persisted surface', async ({ page, context }) => {
  const collected = await loadWithToken(page);

  // URL and history: the token is never in the address.
  expect(page.url().includes(TOKEN)).toBe(false);
  expect(page.url().includes('?')).toBe(false);
  expect(page.url().includes('#')).toBe(false);

  // Cookies: none set at all, and certainly none carrying the token.
  const cookies = await context.cookies();
  expect(cookies.length).toBe(0);

  // Storage: localStorage, sessionStorage, IndexedDB all empty of the token.
  const storage = await page.evaluate(async () => {
    const dbs = window.indexedDB && indexedDB.databases ? await indexedDB.databases() : [];
    return {
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      idbCount: dbs.length,
      localLen: window.localStorage.length,
      sessionLen: window.sessionStorage.length,
    };
  });
  expect(storage.localLen).toBe(0);
  expect(storage.sessionLen).toBe(0);
  expect(storage.idbCount).toBe(0);
  expect(storage.local.includes(TOKEN)).toBe(false);
  expect(storage.session.includes(TOKEN)).toBe(false);

  // DOM serialization: the whole document, as text, never contains the token.
  const serialized = await page.evaluate(() => document.documentElement.outerHTML);
  expect(serialized.includes(TOKEN)).toBe(false);

  // Console: nothing the page logged contains the token.
  expect(collected.consoleErrors.join('\n').includes(TOKEN)).toBe(false);
  expect(collected.consoleWarnings.join('\n').includes(TOKEN)).toBe(false);

  // Network logs: no request URL and no request body carries the token. (It travels only as a request
  // header, which is the intended and only channel — that is bearer auth, not a leak.)
  for (const req of collected.requests) {
    expect(req.url.includes(TOKEN), 'no request URL carries the token').toBe(false);
    expect(req.post.includes(TOKEN), 'no request body carries the token').toBe(false);
  }
});

test('the real engine refuses inline, data, blob and javascript-URL execution', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const flags = {};
    // Inline <script> injected into the DOM.
    try {
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true;';
      document.body.appendChild(s);
    } catch (e) { /* ignored */ }
    // data: URL script.
    try {
      const s = document.createElement('script');
      s.src = 'data:text/javascript,window.__dataRan=true';
      document.body.appendChild(s);
    } catch (e) { /* ignored */ }
    // blob: URL script.
    try {
      const blob = new Blob(['window.__blobRan=true'], { type: 'text/javascript' });
      const s = document.createElement('script');
      s.src = URL.createObjectURL(blob);
      document.body.appendChild(s);
    } catch (e) { /* ignored */ }
    // javascript: URL navigation via an anchor.
    try {
      const a = document.createElement('a');
      a.href = 'javascript:window.__jsRan=true';
      document.body.appendChild(a);
      a.click();
    } catch (e) { /* ignored */ }
    // Give the engine a tick to (not) run any of them.
    await new Promise((r) => setTimeout(r, 300));
    flags.inline = window.__inlineRan === true;
    flags.data = window.__dataRan === true;
    flags.blob = window.__blobRan === true;
    flags.js = window.__jsRan === true;
    return flags;
  });
  expect(result.inline, 'inline script did not run').toBe(false);
  expect(result.data, 'data: script did not run').toBe(false);
  expect(result.blob, 'blob: script did not run').toBe(false);
  expect(result.js, 'javascript: URL did not run').toBe(false);

  // And the engine reported the refusals as CSP violations.
  const violations = await page.evaluate(() => window.__cspViolations);
  expect(violations.length, 'the CSP engine recorded the blocked attempts').toBeGreaterThan(0);
  expect(violations.every((v) => /script-src|default-src/.test(v.directive))).toBe(true);
});

test('a hostile string in a rendered record does not execute', async ({ page }) => {
  // The orchestrator planted a promotion record whose content contains <img onerror> and <script> markup.
  // Loading the authenticated page renders whatever the chain endpoint returns; nothing must execute.
  await loadWithToken(page);
  const executed = await page.evaluate(() => window.__xss === 1);
  expect(executed, 'the hostile string in the record did not execute').toBe(false);
  // And no CSP violation was needed, because the value was only ever written as text, never as markup.
});
